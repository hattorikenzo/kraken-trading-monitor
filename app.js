'use strict';
// Kraken Trading Monitor v1.4.1: WebSocket + REST fallback; SOLO SIMULAZIONE.
const PAIRS=['BTC/USDC','ETH/USDC','SOL/USDC','XRP/USDC'];
const INITIAL=39.0104, KEY='ktm_sim_v1', SETKEY='ktm_settings_v1'; // preserva i dati v1.1
const $=id=>document.getElementById(id);
const fmt=(n,d=4)=>Number.isFinite(n)?n.toLocaleString('it-IT',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const safe=(n,def=0)=>Number.isFinite(+n)?+n:def;
let state,settings,ws=null,retry=null,lastReceived=0;
const REFRESH_MS=2000, STALE_MS=30000;
let lastPriceReceived=0, lastDataSource='';
const lastPairUpdate=Object.fromEntries(PAIRS.map(p=>[p,0]));
let fallbackBusy=false, lastFallback=0;
let lastAlert={},alertLog=[],backtestResult=null;
const REST_PAIRS={'BTC/USDC':'XBTUSDC','ETH/USDC':'ETHUSDC','SOL/USDC':'SOLUSDC','XRP/USDC':'XRPUSDC'};
let historyStatus='Caricamento storico…',historyLoaded=0;
function updateHistoryStatus(){const e=$('historyStatus');if(e)e.textContent=historyStatus;}
async function loadHistory(){historyStatus='Recupero storico Kraken in corso…';updateHistoryStatus();let count=0,failed=[];await Promise.all(PAIRS.map(async p=>{try{const url='https://api.kraken.com/0/public/OHLC?pair='+encodeURIComponent(REST_PAIRS[p])+'&interval=5';const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(9000)});if(!response.ok)throw Error('HTTP '+response.status);const json=await response.json();if(json.error?.length)throw Error(json.error.join(','));const key=Object.keys(json.result||{}).find(k=>k!=='last');const rows=json.result?.[key];if(!Array.isArray(rows))throw Error('Nessuna candela');for(const c of rows){const t=Number(c[0])*1000,close=Number(c[4]);if(Number.isFinite(t)&&close>0)market[p].candles.set(t,close);market[p].ohlc.set(t,{open:+c[1],high:+c[2],low:+c[3],close})}trimCandles(p);if(rows.length)count++}catch(e){failed.push(p)}}));historyLoaded=count;historyStatus=count===4?'Storico caricato: 4 mercati':count?'Storico caricato: '+count+'/4; gli altri attendono nuove candele':'Storico REST non accessibile dal browser: raccolta candele in tempo reale';updateHistoryStatus();analyze();render();}
function trimCandles(p){const m=market[p];if(m.candles.size>720){const keys=[...m.candles.keys()].sort((a,b)=>a-b);for(const t of keys.slice(0,keys.length-720)){m.candles.delete(t);m.ohlc.delete(t)}}}
const market=Object.fromEntries(PAIRS.map(p=>[p,{price:null,candles:new Map(),ohlc:new Map(),signal:'Attendi',score:0,rsi:null,trend:null}]));
function load(){try{const x=JSON.parse(localStorage.getItem(KEY));if(x&&typeof x.cash==='number'&&x.cash>=0&&x.positions&&x.history&&Array.isArray(x.history))return {...x,pending:Array.isArray(x.pending)?x.pending:[]}}catch{}return {cash:INITIAL,positions:{},history:[],fees:0,pending:[]}}
function loadSettings(){try{return {...{fee:.8,maker:.4,slippage:.15,budget:15,stop:2,take:4},...JSON.parse(localStorage.getItem(SETKEY))}}catch{return {fee:.8,maker:.4,slippage:.15,budget:15,stop:2,take:4}}}
state=load();settings=loadSettings();
function persist(){localStorage.setItem(KEY,JSON.stringify(state))}
function setStatus(s,cls=''){const e=$('status');if(e){e.textContent=s;e.className='pill '+cls}}
function showConnectionIssue(message){const e=$('notice');if(e)e.textContent='Connessione dati: '+message+' · Le operazioni rimangono soltanto simulate.'}
async function fallbackPrices(){
 if(fallbackBusy || Date.now()-lastFallback<12000)return;
 fallbackBusy=true;lastFallback=Date.now();
 try{
  const url='https://api.kraken.com/0/public/Ticker?pair='+encodeURIComponent(Object.values(REST_PAIRS).join(','));
  const resp=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!resp.ok)throw Error('HTTP '+resp.status);
  const data=await resp.json();if(data.error?.length)throw Error(data.error.join(', '));
  let updated=0;
  for(const p of PAIRS){
   const normalized=REST_PAIRS[p].replace(/[^A-Z0-9]/g,'');
   const aliases={ 'BTC/USDC':['XBTUSDC','XXBTUSDC'], 'ETH/USDC':['ETHUSDC','XETHUSDC'], 'SOL/USDC':['SOLUSDC'], 'XRP/USDC':['XRPUSDC','XXRPUSDC'] };
   const entry=Object.entries(data.result||{}).find(([key])=>aliases[p].includes(key.toUpperCase()));
   if(!entry)continue;
   const price=Number(entry[1]?.c?.[0]);if(!(price>0))continue;
   market[p].price=price;lastPairUpdate[p]=Date.now();updated++;
  }
  if(updated){lastPriceReceived=Date.now();lastReceived=lastPriceReceived;lastDataSource='REST';analyze();setStatus('Prezzi Kraken REST · '+updated+'/4','neutral')}
  else showConnectionIssue('REST raggiungibile ma coppie non riconosciute');
 }catch(err){showConnectionIssue('WebSocket non disponibile e REST fallito ('+err.message+')');setStatus('Dati non disponibili','down')}
 finally{fallbackBusy=false}
}

function connect(){
 if(ws){const old=ws;ws=null;try{old.close()}catch{}}
 clearTimeout(retry);setStatus('Connessione Kraken…','neutral');
 try{ws=new WebSocket('wss://ws.kraken.com/v2')}
 catch(err){setStatus('WebSocket non disponibile','down');showConnectionIssue(err.message);void fallbackPrices();return}
 const socket=ws;
 socket.onopen=()=>{
  if(socket!==ws)return;
  setStatus('Connesso · attesa quotazioni','neutral');
  for(const params of [
   {channel:'ticker',symbol:PAIRS,event_trigger:'trades'},
   {channel:'ohlc',symbol:PAIRS,interval:5,snapshot:true}
  ])socket.send(JSON.stringify({method:'subscribe',params}));
 };
 socket.onmessage=e=>{
  if(socket!==ws)return;
  let msg;try{msg=JSON.parse(e.data)}catch{return}
  if(msg.success===false){showConnectionIssue(msg.error||'Iscrizione rifiutata');void fallbackPrices();return}
  if(!Array.isArray(msg.data))return;
  let gotPrice=false,gotCandle=false;
  for(const d of msg.data){
   const p=d.symbol;if(!market[p])continue;
   if(msg.channel==='ticker'){
    const price=Number(d.last);if(price>0){market[p].price=price;lastPairUpdate[p]=Date.now();gotPrice=true}
   }else if(msg.channel==='ohlc'){
    const t=Date.parse(d.interval_begin||d.timestamp),close=Number(d.close);
    if(Number.isFinite(t)&&close>0){
     market[p].candles.set(t,close);
     market[p].ohlc.set(t,{open:Number(d.open),high:Number(d.high),low:Number(d.low),close});
     trimCandles(p);gotCandle=true;
     if(!market[p].price){market[p].price=close;lastPairUpdate[p]=Date.now();gotPrice=true}
    }
   }
  }
  if(gotPrice||gotCandle){
   lastReceived=Date.now();
   if(gotPrice){lastPriceReceived=lastReceived;lastDataSource='WebSocket'}
   processPending();analyze();checkAlerts();
   setStatus('Dati Kraken attivi · WebSocket','up');
  }
 };
 socket.onerror=()=>{if(socket!==ws)return;setStatus('Errore WebSocket','down');void fallbackPrices()};
 socket.onclose=()=>{
  if(socket!==ws)return;
  ws=null;setStatus('WebSocket disconnesso · riconnessione','down');
  void fallbackPrices();retry=setTimeout(connect,5000);
 };
}

function rsi(closes){if(closes.length<16)return null;let gain=0,loss=0;const last=closes.slice(-15);for(let i=1;i<last.length;i++){const d=last[i]-last[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d)}if(loss===0)return gain===0?50:100;return 100-100/(1+gain/loss)}
function analyze(){for(const p of PAIRS){const m=market[p];const arr=[...m.candles.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]);if(arr.length<22){m.signal='Dati insufficienti';m.score=0;m.rsi=null;m.trend=null;continue}const ma8=arr.slice(-8).reduce((a,b)=>a+b,0)/8,ma21=arr.slice(-21).reduce((a,b)=>a+b,0)/21;m.rsi=rsi(arr);m.trend=100*(ma8/ma21-1);const rising=ma8>ma21&&m.rsi>=48&&m.rsi<=68;const falling=ma8<ma21&&m.rsi<43;m.signal=rising?'Osserva acquisto':falling?'Debolezza':'Attendi';m.score=rising?Math.min(100,Math.round(50+Math.min(m.trend,2)*15+(68-m.rsi)*.5)):0}}
function netAtMove(amount,move){const r=costRate();return amount*(1-r)*(1+move/100)*(1-r)-amount}
function candidate(p){const m=market[p];if(m.signal!=='Osserva acquisto'||!m.price)return null;const profit=netAtMove(settings.budget,settings.take),loss=netAtMove(settings.budget,-settings.stop);const ratio=loss<0?profit/(-loss):0;return {pair:p,score:m.score,profit,loss,ratio,eligible:profit>0&&ratio>=1.2}}
function renderRanking(){const e=$('ranking');if(!e)return;const items=PAIRS.map(candidate).filter(Boolean).sort((a,b)=>b.score-a.score);e.innerHTML=items.length?items.map(x=>`<tr><td><b>${x.pair}</b></td><td>${x.score}/100</td><td class="${x.profit>0?'up':'down'}">${fmt(x.profit)} USDC</td><td class="down">${fmt(x.loss)} USDC</td><td>${fmt(x.ratio,2)}</td><td>${x.eligible?'Da valutare':'Attendi: margine/rischio insufficiente'}</td></tr>`).join(''):'<tr><td colspan="6">Nessun segnale d’acquisto idoneo. Attendere è una decisione valida.</td></tr>'}
function costRate(kind="taker"){return ((kind==="maker"?settings.maker:settings.fee)+(kind==="maker"?0:settings.slippage))/100}
function positionValue(p){const pos=state.positions[p];const price=market[p].price;return pos&&price?pos.qty*price*(1-costRate()):pos?pos.cost:0}
function render(){let equity=state.cash;for(const p of Object.keys(state.positions))equity+=positionValue(p);$('cash').textContent=fmt(state.cash)+' USDC';$('equity').textContent=fmt(equity)+' USDC';const pl=equity-INITIAL;$('pnl').textContent=(pl>=0?'+':'')+fmt(pl)+' USDC';$('pnl').className=pl>=0?'up':'down';$('feesTotal').textContent=fmt(state.fees)+' USDC';renderRanking();$('markets').innerHTML=PAIRS.map(p=>{const m=market[p];const c=m.signal==='Osserva acquisto'?'up':m.signal==='Debolezza'?'down':'neutral';return `<tr><td><b>${p}</b></td><td>${fmt(m.price,p.startsWith('XRP')?5:2)}</td><td>${m.rsi===null?'—':fmt(m.rsi,1)}</td><td>${m.trend===null?'—':fmt(m.trend,2)+'%'}</td><td class="${c}">${m.signal}</td><td>${m.score?m.score+'/100':'—'}</td><td><button class="secondary" data-pair="${p}">Valuta</button></td></tr>`}).join('');document.querySelectorAll('[data-pair]').forEach(b=>b.onclick=()=>{$('pair').value=b.dataset.pair;renderPreview()});const pos=Object.entries(state.positions);$('positions').innerHTML=pos.length?pos.map(([p,x])=>{const price=market[p].price;const v=positionValue(p),pl=v-x.cost;const change=price?100*(price/x.entry-1):null;const stop=x.entry*(1-settings.stop/100),take=x.entry*(1+settings.take/100);return `<div class="preview"><b>${p}</b><br>Quantità: ${fmt(x.qty,8)}<br>Prezzo medio: ${fmt(x.entry,5)}<br>Valore netto stimato: ${fmt(v)} USDC<br><span class="${pl>=0?'up':'down'}">P/L: ${fmt(pl)} USDC</span><br>Stop indicativo: ${fmt(stop,5)} · Target: ${fmt(take,5)}${change!==null&&change<=-settings.stop?'<br><b class="down">⚠ Stop indicativo raggiunto</b>':''}${change!==null&&change>=settings.take?'<br><b class="up">⚠ Target indicativo raggiunto</b>':''}</div>`}).join(''):'<p class="empty">Nessuna posizione aperta.</p>';$('pending').innerHTML=(state.pending||[]).length?state.pending.map(o=>`<div class="preview">${o.pair}: ${fmt(o.amount)} USDC · limite ${fmt(o.limit,5)} · in attesa</div>`).join(''):'<p class="empty">Nessun ordine in attesa.</p>'; $('history').innerHTML=state.history.slice().reverse().slice(0,100).map(h=>`<tr><td>${new Date(h.time).toLocaleString('it-IT')}</td><td>${h.side}</td><td>${h.pair}</td><td>${fmt(h.qty,8)}</td><td>${fmt(h.price,5)}</td><td>${fmt(h.fee)}</td><td>${h.pnl===null?'—':fmt(h.pnl)}</td></tr>`).join('')||'<tr><td colspan="7">Nessuna operazione simulata</td></tr>';renderPreview()}
function renderPreview(){const p=$('pair').value,m=market[p],a=safe($('amount').value);$('selected').textContent=p;if(!m.price){$('preview').textContent='Prezzo non disponibile. Attendere i dati live di Kraken.';return}const kind=$('orderType').value==='limit'?'maker':'taker',rate=costRate(kind),price=kind==='maker'?safe($('limitPrice').value):m.price;const qty=price>0?a*(1-rate)/price:0,breakEven=1/((1-rate)*(1-costRate()))-1;const expectedAtTake=a*(1-rate)*(1+settings.take/100)*(1-costRate());$('preview').innerHTML=`${m.signal==='Osserva acquisto'?'Segnale sperimentale: osserva acquisto':'Segnale: '+m.signal} <br>Prezzo corrente: <b>${fmt(m.price,5)} USDC</b><br>Quantità virtuale acquistabile: <b>${fmt(qty,8)}</b><br>Costo ingresso stimato: <b>${fmt(a*costRate())} USDC</b><br>Movimento minimo per pareggio: <b>${fmt(breakEven*100,2)}%</b><br>Profitto netto stimato al target +${fmt(settings.take,1)}%: <b>${fmt(expectedAtTake-a)} USDC</b><br><span class="neutral">Non è una previsione. Prezzi e spread possono cambiare.</span>`}
function trade(side){const p=$('pair').value,m=market[p];if(!m.price||Date.now()-lastPairUpdate[p]>STALE_MS){alert('Prezzo assente o non aggiornato: operazione bloccata.');return}const r=costRate();if(side==='BUY'){const a=safe($('amount').value);if(a<=0||a>settings.budget||a+(state.pending||[]).reduce((sum,o)=>sum+o.amount,0)>state.cash){alert('Importo non valido o superiore alla liquidità/budget.');return}if($('orderType').value==='limit'){const limit=safe($('limitPrice').value);if(limit<=0||limit>m.price){alert('Imposta un limite positivo non superiore al prezzo attuale.');return}const reserved=(state.pending||[]).reduce((sum,o)=>sum+o.amount,0);if(a+reserved>state.cash){alert('Liquidità insufficiente, considerando gli ordini in attesa.');return}if(!confirm(`SIMULAZIONE: inserire ordine limite virtuale ${p} a ${fmt(limit,5)} USDC per ${fmt(a)} USDC? Potrebbe non essere eseguito.`))return;state.pending.push({pair:p,limit,amount:a,created:Date.now()});persist();render();return}const qty=a*(1-r)/m.price;if(!confirm(`SIMULAZIONE: acquistare ${fmt(qty,8)} ${p} per ${fmt(a)} USDC? Nessun ordine reale.`))return;const old=state.positions[p]||{qty:0,cost:0,entry:0};old.qty+=qty;old.cost+=a;old.entry=old.cost/(old.qty*(1-r));state.positions[p]=old;state.cash-=a;state.fees+=a*settings.fee/100;state.history.push({time:Date.now(),side:'ACQUISTO SIM.',pair:p,qty,price:m.price,fee:a*settings.fee/100,pnl:null})}else{const pos=state.positions[p];if(!pos){alert('Non hai una posizione virtuale in questo mercato.');return}const gross=pos.qty*m.price,net=gross*(1-r),pnl=net-pos.cost;if(!confirm(`SIMULAZIONE: vendere tutta la posizione ${p}? Incasso stimato ${fmt(net)} USDC, P/L ${fmt(pnl)} USDC.`))return;state.cash+=net;state.fees+=gross*settings.fee/100;state.history.push({time:Date.now(),side:'VENDITA SIM.',pair:p,qty:pos.qty,price:m.price,fee:gross*settings.fee/100,pnl});delete state.positions[p]}persist();render()}
function readSettings(){const s={fee:safe($('fee').value),maker:safe($('maker').value),slippage:safe($('slippage').value),budget:safe($('budget').value),stop:safe($('stop').value),take:safe($('take').value)};if(s.fee<0||s.fee>5||s.maker<0||s.maker>5||s.slippage<0||s.slippage>5||s.budget<=0||s.stop<=0||s.take<=0){alert('Controlla i parametri inseriti.');return}settings=s;localStorage.setItem(SETKEY,JSON.stringify(s));render();alert('Impostazioni salvate (solo simulazione).')}
function exportCSV(){const rows=[['ora','tipo','mercato','quantita','prezzo','commissione','profitto_realizzato'],...state.history.map(h=>[new Date(h.time).toISOString(),h.side,h.pair,h.qty,h.price,h.fee,h.pnl??''])];const csv=rows.map(r=>r.join(';')).join('\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='kraken-simulazione.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
for(const k of ['fee','maker','slippage','budget','stop','take'])$(k).value=settings[k];$('saveSettings').onclick=readSettings;$('buy').onclick=()=>trade('BUY');$('sell').onclick=()=>trade('SELL');$('pair').onchange=()=>{if(market[$('pair').value].price)$('limitPrice').value=market[$('pair').value].price;renderPreview()};$('orderType').onchange=()=>{$('limitBox').style.display=$('orderType').value==='limit'?'block':'none';$('limitPrice').value=market[$('pair').value].price||'';renderPreview()};$('limitPrice').oninput=renderPreview;$('cancelPending').onclick=()=>{if(confirm('Annullare tutti gli ordini limite virtuali?')){state.pending=[];persist();render()}};$('amount').oninput=renderPreview;$('reconnect').onclick=()=>{lastFallback=0;connect()};$('export').onclick=exportCSV;$('reset').onclick=()=>{if(confirm('Azzerare TUTTA la simulazione e ripartire da 39,0104 USDC?')){state={cash:INITIAL,positions:{},history:[],fees:0,pending:[]};persist();render()}};render();connect();void loadHistory();
setInterval(()=>{
 try{
  render();
  const age=Date.now()-lastPriceReceived;
  if(!lastPriceReceived || age>STALE_MS){
   setStatus(lastPriceReceived?'Prezzi non aggiornati':'In attesa dei prezzi','down');
   void fallbackPrices();
  }else if(lastDataSource==='REST')setStatus('Prezzi Kraken REST · aggiornamento 2 s','neutral');
 }catch(err){console.error('Kraken Monitor render:',err);showConnectionIssue('Errore visualizzazione: '+err.message)}
},REFRESH_MS);


// Gli ordini limite sono una semplificazione: tocco del prezzo != esecuzione garantita.
function processPending(){if(!state.pending?.length)return;let changed=false;const remaining=[];for(const o of state.pending){const m=market[o.pair];if(!m.price||Date.now()<=o.created||m.price>o.limit||state.cash<o.amount){remaining.push(o);continue}const r=costRate('maker'),qty=o.amount*(1-r)/o.limit;const old=state.positions[o.pair]||{qty:0,cost:0,entry:0};old.qty+=qty;old.cost+=o.amount;old.entry=old.cost/(old.qty*(1-r));state.positions[o.pair]=old;state.cash-=o.amount;state.fees+=o.amount*settings.maker/100;state.history.push({time:Date.now(),side:'LIMITE SIM. (fill ipotetico)',pair:o.pair,qty,price:o.limit,fee:o.amount*settings.maker/100,pnl:null});changed=true}state.pending=remaining;if(changed)persist()}
function checkAlerts(){for(const p of PAIRS){const c=candidate(p);if(!c?.eligible)continue;if(Date.now()-(lastAlert[p]||0)<30*60*1000)continue;lastAlert[p]=Date.now();const msg=`${p}: segnale sperimentale ${c.score}/100, netto al target ${fmt(c.profit)} USDC, rapporto ${fmt(c.ratio,2)}`;alertLog.unshift(new Date().toLocaleTimeString('it-IT')+' · '+msg);alertLog=alertLog.slice(0,10);$('alertLog').textContent=alertLog.join('\n');if('Notification' in window&&Notification.permission==='granted')new Notification('Kraken Monitor · simulazione',{body:msg})}}
$('enableAlerts').onclick=async()=>{if(!('Notification' in window)){alert('Notifiche non supportate da questo browser.');return}try{const permission=await Notification.requestPermission();alert(permission==='granted'?'Notifiche abilitate finché la pagina rimane aperta.':'Permesso notifiche non concesso.')}catch{alert('Apri la pagina su HTTPS o localhost per usare le notifiche.')}};
// Backtest: usa soltanto candele chiuse. Il segnale viene calcolato su [0..i-1],
// ingresso alla open della candela i; stop ha precedenza sul target nella stessa candela.
function backtest(pair){const now=Date.now();const candles=[...market[pair].ohlc.entries()].filter(([ts,c])=>ts+300000<now&&c.open>0&&c.high>0&&c.low>0&&c.close>0).sort((a,b)=>a[0]-b[0]);const fee=costRate(),capital=INITIAL,allocation=Math.min(settings.budget,capital),trades=[];let balance=capital,peak=capital,maxDD=0,position=null;for(let i=22;i<candles.length;i++){const [ts,c]=candles[i];if(position){let exit=null,reason='';if(c.low<=position.stop){exit=position.stop;reason='stop'}else if(c.high>=position.take){exit=position.take;reason='target'}if(exit!==null){const proceeds=position.qty*exit*(1-fee),pnl=proceeds-position.amount;balance+=proceeds;trades.push({pnl,reason});position=null;peak=Math.max(peak,balance);maxDD=Math.max(maxDD,100*(peak-balance)/peak)}continue}const prev=candles.slice(i-22,i).map(x=>x[1].close),ma8=prev.slice(-8).reduce((a,b)=>a+b,0)/8,ma21=prev.slice(-21).reduce((a,b)=>a+b,0)/21,rv=rsi(prev);if(ma8<=ma21||rv<48||rv>68||balance<allocation)continue;const entry=c.open;if(!entry)continue;const qty=allocation*(1-fee)/entry;balance-=allocation;position={qty,amount:allocation,stop:entry*(1-settings.stop/100),take:entry*(1+settings.take/100)}; // verifica stop/target solo dalla candela successiva
}const last=candles.at(-1)?.[1].close;if(position&&last){const proceeds=position.qty*last*(1-fee);balance+=proceeds;trades.push({pnl:proceeds-position.amount,reason:'chiusura a fine storico'})}const wins=trades.filter(x=>x.pnl>0).length;return {pair,count:trades.length,wins,pnl:balance-capital,dd:maxDD,period:candles.length?`${new Date(candles[0][0]).toLocaleDateString('it-IT')} – ${new Date(candles.at(-1)[0]).toLocaleDateString('it-IT')}`:'—',candles:candles.length}}
$('runBacktest').onclick=()=>{const results=PAIRS.map(backtest);$('backtestRows').innerHTML=results.map(x=>`<tr><td>${x.pair}</td><td>${x.count}</td><td>${x.wins}</td><td class="${x.pnl>=0?'up':'down'}">${fmt(x.pnl)} USDC</td><td>${fmt(x.dd,2)}%</td><td>${x.period}</td></tr>`).join('');$('backtestSummary').textContent='Backtest completato su dati storici Kraken (fino a 720 candele a 5 minuti per mercato). Campione limitato, nessuna ottimizzazione o garanzia. Risultati per mercato indipendenti, ciascuno parte da 39,0104 USDC; non sommarli. Numero candele: '+results.map(x=>x.pair+' '+x.candles).join(' · ')};

// v1.3: diagnostica isolata; non modifica il portafoglio virtuale o gli ordini.
let diagnosticsExport=[];
function mean(a){return a.reduce((s,v)=>s+v,0)/a.length}
function atr14(rows, i){if(i<15)return null;let sum=0;for(let k=i-14;k<i;k++){const c=rows[k].c,prev=rows[k-1].c;sum+=Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close))}return sum/14}
function simulateV13(pair, mode, from, to){
 const now=Date.now();const rows=[...market[pair].ohlc.entries()].filter(([t,c])=>t+300000<now&&[c.open,c.high,c.low,c.close].every(v=>Number.isFinite(v)&&v>0)).sort((a,b)=>a[0]-b[0]).map(([t,c])=>({t,c}));
 const initial=INITIAL,allocation=Math.min(settings.budget,initial),rate=costRate();let cash=initial,peak=initial,dd=0,position=null;const trades=[];
 for(let i=Math.max(55,from);i<Math.min(to,rows.length);i++){
  const bar=rows[i],c=bar.c;
  if(position){let exit=null,why='';
   if(c.low<=position.stop){exit=Math.min(c.open,position.stop);why='Stop / gap'}
   else if(c.high>=position.target){exit=position.target;why='Target'}
   if(exit!==null){const gross=position.qty*exit,proceeds=gross*(1-rate),pnl=proceeds-position.amount;cash+=proceeds;peak=Math.max(peak,cash);dd=Math.max(dd,100*(peak-cash)/peak);trades.push({pair,mode,entryTime:position.ts,exitTime:bar.t,entry:position.entry,exit,why,fees:position.amount*rate+gross*rate,pnl});position=null}
   continue;
  }
  const closes=rows.slice(i-55,i).map(x=>x.c.close),ma8=mean(closes.slice(-8)),ma21=mean(closes.slice(-21)),rv=rsi(closes);
  if(!(ma8>ma21&&rv>=48&&rv<=68)||cash<allocation)continue;
  if(mode!=='base'){
   // 12 candele da 5 minuti = un'ora; confronto solo dati precedenti.
   const hour=mean(closes.slice(-12)),previousHour=mean(closes.slice(-24,-12));
   if(!(hour>previousHour&&closes.at(-1)>hour))continue;
  }
  const entry=c.open;let stop=settings.stop/100,target=settings.take/100;
  if(mode==='atr'){
   const atr=atr14(rows.map(x=>x),i);if(!atr)continue;
   stop=Math.max(.008,Math.min(.05,1.6*atr/entry));target=Math.max(.012,Math.min(.09,2.4*atr/entry));
  }
  const qty=allocation*(1-rate)/entry;cash-=allocation;
  position={qty,amount:allocation,entry,ts:bar.t,stop:entry*(1-stop),target:entry*(1+target)};
 }
 if(position){const bar=rows[Math.min(to,rows.length)-1];if(bar){const exit=bar.c.close,gross=position.qty*exit,proceeds=gross*(1-rate),pnl=proceeds-position.amount;cash+=proceeds;peak=Math.max(peak,cash);dd=Math.max(dd,100*(peak-cash)/peak);trades.push({pair,mode,entryTime:position.ts,exitTime:bar.t,entry:position.entry,exit,why:'Fine finestra',fees:position.amount*rate+gross*rate,pnl})}}
 return {pair,mode,from,to,count:trades.length,wins:trades.filter(t=>t.pnl>0).length,pnl:cash-initial,dd,trades,rows:rows.length};
}
function diagnosticsV13(){const result=[],details=[];for(const p of PAIRS){const n=[...market[p].ohlc.entries()].filter(([t,c])=>t+300000<Date.now()&&[c.open,c.high,c.low,c.close].every(v=>Number.isFinite(v)&&v>0)).length;const split=Math.floor(n*.7);for(const mode of ['base','trend','atr']){const train=simulateV13(p,mode,0,split),test=simulateV13(p,mode,split,n);result.push({...train,phase:'Esplorazione'}, {...test,phase:'Verifica'});details.push(...test.trades)}}diagnosticsExport=details;
 const names={base:'Originale',trend:'Filtro trend 1h',atr:'Trend + ATR'};
 $('diagnosticRows').innerHTML=result.map(x=>`<tr><td>${x.pair}</td><td>${names[x.mode]}</td><td>${x.phase}</td><td>${x.count}</td><td>${x.wins}</td><td class="${x.pnl>=0?'up':'down'}">${fmt(x.pnl)} USDC</td><td>${fmt(x.dd,2)}%</td></tr>`).join('');
 $('diagnosticTrades').innerHTML=details.length?details.map(x=>`<tr><td>${x.pair}</td><td>${names[x.mode]}</td><td>${new Date(x.entryTime).toISOString().slice(0,16)}</td><td>${new Date(x.exitTime).toISOString().slice(0,16)}</td><td>${fmt(x.entry,5)}</td><td>${fmt(x.exit,5)}</td><td>${x.why}</td><td>${fmt(x.fees)} USDC</td><td class="${x.pnl>=0?'up':'down'}">${fmt(x.pnl)} USDC</td></tr>`).join(''):'<tr><td colspan="9">Nessuna operazione nella finestra di verifica.</td></tr>';
 $('diagnosticSummary').textContent='Analisi completata. Ogni riga parte indipendentemente da 39,0104 USDC; non sommare i P/L come se fosse un portafoglio. La verifica copre il 30% finale delle candele disponibili (circa 1 giorno su 3). Una strategia senza trade non dimostra redditività. Campione troppo breve per valutare una strategia reale.';
}
$('runDiagnostics').onclick=diagnosticsV13;
$('exportDiagnostics').onclick=()=>{if(!diagnosticsExport.length){alert('Esegui prima l’analisi.');return}const rows=[['mercato','strategia','ingresso_utc','uscita_utc','prezzo_ingresso','prezzo_uscita','motivo','costi_stimati','profitto_netto'],...diagnosticsExport.map(x=>[x.pair,x.mode,new Date(x.entryTime).toISOString(),new Date(x.exitTime).toISOString(),x.entry,x.exit,x.why,x.fees,x.pnl])];const blob=new Blob(['﻿'+rows.map(r=>r.join(';')).join('\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='kraken-diagnostica-v1.3.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
// v1.6 — laboratorio intraday AUTOMATICO, esclusivamente virtuale.
// Laboratorio intraday v1.6.1: LONG e SHORT virtuali, mai ordini reali.
(() => {
  const STORE='ktm_intraday_v16';
  const WATCH=['BTC/USDC','ETH/USDC'];
  const START=INITIAL, MAX_TRADE=10, MIN_CANDLES=60;
  const defaultState=()=>({enabled:false,cash:START,position:null,trades:[],events:[],lastProcessed:{}});
  let auto;
  try { const raw=JSON.parse(localStorage.getItem(STORE));auto={...defaultState(),...(raw&&typeof raw==='object'?raw:{})}; }
  catch { auto=defaultState(); }
  auto.enabled=false; // Mai riavviare il trading automaticamente al reload.
  const save=()=>{try{localStorage.setItem(STORE,JSON.stringify(auto));}catch(e){console.warn('Salvataggio intraday non disponibile',e);}};
  const log=(msg,pair='—',direction='—')=>{
    auto.events.unshift({time:Date.now(),pair,direction,msg});
    auto.events=auto.events.slice(0,100);
  };
  const section=document.createElement('section');section.className='panel ranking-panel';
  section.innerHTML=`<div class="heading"><h2>Laboratorio intraday v1.6.1 · LONG / SHORT · SOLO SIMULAZIONE</h2><span id="autoStatus" class="pill neutral">In pausa</span></div>
    <p class="foot">BTC/USDC ed ETH/USDC · segnali su candele da 5 minuti chiuse · conferma con 12 candele da 5 minuti (proxy orario, non OHLC 1h). Una posizione virtuale alla volta, massimo 10 USDC. SHORT soltanto contabile: nessun prestito, leva o ordine Kraken. Il monitor deve restare aperto.</p>
    <div class="actions"><button id="autoStart" class="secondary" type="button">Avvia simulazione automatica</button><button id="autoStop" class="secondary" type="button" disabled>Metti in pausa</button><button id="autoExport" class="secondary" type="button">Esporta CSV</button><button id="autoReset" class="danger" type="button">Azzera solo laboratorio</button></div>
    <div id="autoSummary" class="preview" role="status" aria-live="polite"></div>
    <h3>Operazioni simulate (ultime 30)</h3><div class="tablewrap"><table><thead><tr><th>Data e ora</th><th>Mercato</th><th>Direzione</th><th>Evento</th><th>Prezzo</th><th>Importo</th><th>P/L netto</th><th>Motivo</th></tr></thead><tbody id="autoTrades"></tbody></table></div>
    <h3>Registro segnali</h3><div class="tablewrap"><table><thead><tr><th>Data e ora</th><th>Mercato</th><th>Direzione</th><th>Messaggio</th></tr></thead><tbody id="autoLog"></tbody></table></div>
    <p class="foot">Simulazione illustrativa: costi di finanziamento short, spread e slippage effettivi non verificati; stop e target non garantiti. Nessuna posizione short reale è disponibile tramite questa funzione. Non funziona a pagina chiusa, non è un backtest e non prova la redditività.</p>`;
  const main=document.querySelector('main');if(main)main.insertBefore(section,main.firstChild);
  const $a=id=>document.getElementById(id);
  const rate=()=>costRate();
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const closedRows=p=>[...market[p].ohlc.entries()].filter(([t,c])=>t+300000<=Date.now()&&[c.open,c.high,c.low,c.close].every(v=>Number.isFinite(v)&&v>0)).sort((a,b)=>a[0]-b[0]);
  // Short contabile senza leva: margine riservato; P/L = variazione inversa - costi ingresso/uscita.
  const unrealized=p=>{
    if(!p)return 0;
    const m=market[p.pair],price=m?.price>0?m.price:p.entry;
    if(p.direction==='SHORT')return p.qty*(p.entry-price)-p.amount*rate()-p.qty*price*rate();
    return p.qty*price*(1-rate())-p.amount;
  };
  const portfolio=()=>auto.cash+(auto.position?auto.position.amount+unrealized(auto.position):0);
  const num=n=>fmt(n,4);
  function display(){
    $a('autoStatus').textContent=auto.enabled?'Simulazione attiva':'In pausa';$a('autoStatus').className='pill '+(auto.enabled?'up':'neutral');
    $a('autoStart').disabled=auto.enabled;$a('autoStop').disabled=!auto.enabled;
    const closed=auto.trades.filter(t=>t.event==='CHIUSURA SIM.'||t.event==='VENDITA SIM.');
    const today=new Date().toLocaleDateString('it-IT');
    const daily=closed.filter(t=>new Date(t.time).toLocaleDateString('it-IT')===today);
    const sum=xs=>xs.reduce((v,t)=>v+(Number(t.pnl)||0),0);
    const wins=closed.filter(t=>t.pnl>0).length;
    const p=auto.position;
    const summary=$a('autoSummary');summary.replaceChildren();
    const lines=[`Liquidità virtuale: ${num(auto.cash)} USDC`, `Patrimonio stimato: ${num(portfolio())} USDC · P/L totale: ${num(portfolio()-START)} USDC`, `Oggi: ${daily.length} chiusure · P/L realizzato: ${num(sum(daily))} USDC`, `Totale: ${closed.length} chiusure, ${wins} positive · P/L realizzato: ${num(sum(closed))} USDC`, p?`Posizione ${p.direction||'LONG'}: ${p.pair} · ${num(p.amount)} USDC · ingresso ${fmt(p.entry,5)} · stop ${fmt(p.stop,5)} · target ${fmt(p.take,5)}`:'Nessuna posizione simulata aperta.'];
    for(const line of lines){const d=document.createElement('div');d.textContent=line;d.style.marginBottom='7px';summary.appendChild(d);}
    $a('autoTrades').innerHTML=auto.trades.slice(-30).reverse().map(t=>`<tr><td>${new Date(t.time).toLocaleString('it-IT')}</td><td>${esc(t.pair)}</td><td>${esc(t.direction||'LONG')}</td><td>${esc(t.event)}</td><td>${fmt(t.price,5)}</td><td>${num(t.amount)}</td><td class="${t.pnl===null?'':t.pnl>=0?'up':'down'}">${t.pnl===null?'—':num(t.pnl)}</td><td>${esc(t.reason)}</td></tr>`).join('')||'<tr><td colspan="8">Nessuna operazione automatica simulata.</td></tr>';
    $a('autoLog').innerHTML=auto.events.slice(0,30).map(e=>{
      if(typeof e==='string'){const match=e.match(/^(.*?) · (.*)$/);return `<tr><td>${esc(match?.[1]||'—')}</td><td>—</td><td>—</td><td>${esc(match?.[2]||e)}</td></tr>`;}
      return `<tr><td>${new Date(e.time).toLocaleString('it-IT')}</td><td>${esc(e.pair)}</td><td>${esc(e.direction)}</td><td style="white-space:normal;min-width:240px;overflow-wrap:anywhere">${esc(e.msg)}</td></tr>`;
    }).join('')||'<tr><td colspan="4">Nessun segnale registrato.</td></tr>';
  }
  function exit(price,reason){
    const p=auto.position;if(!p)return;
    const pnl=p.direction==='SHORT' ? p.qty*(p.entry-price)-p.amount*rate()-p.qty*price*rate() : p.qty*price*(1-rate())-p.amount;
    const released=p.amount+pnl;
    auto.cash+=released;
    auto.trades.push({time:Date.now(),pair:p.pair,direction:p.direction||'LONG',event:'CHIUSURA SIM.',price,amount:released,pnl,reason});
    log(`Chiusura virtuale (${reason}) · P/L ${num(pnl)} USDC`,p.pair,p.direction||'LONG');auto.position=null;save();
  }
  function tick(){
    if(!auto.enabled)return;
    if(auto.position){
      const p=auto.position,m=market[p.pair];
      if(m.price>0&&Date.now()-lastPairUpdate[p.pair]<=STALE_MS){
        if(p.direction==='SHORT'){
          if(m.price>=p.stop)exit(m.price,'Stop SHORT (ticker; possibile gap)');
          else if(m.price<=p.take)exit(m.price,'Target SHORT (ticker)');
        }else{
          if(m.price<=p.stop)exit(m.price,'Stop LONG (ticker; possibile gap)');
          else if(m.price>=p.take)exit(m.price,'Target LONG (ticker)');
        }
      }
    }
    for(const pair of WATCH){
      const rows=closedRows(pair),last=rows.at(-1);if(!last||rows.length<MIN_CANDLES)continue;
      const stamp=last[0];if(auto.lastProcessed[pair]===stamp)continue;
      auto.lastProcessed[pair]=stamp;
      const m=market[pair],closes=rows.slice(-55).map(x=>x[1].close);
      const ma8=closes.slice(-8).reduce((a,b)=>a+b,0)/8;
      const ma21=closes.slice(-21).reduce((a,b)=>a+b,0)/21;
      const rv=rsi(closes);
      const hour=closes.slice(-12).reduce((a,b)=>a+b,0)/12;
      const prior=closes.slice(-24,-12).reduce((a,b)=>a+b,0)/12;
      const long=ma8>ma21&&rv>=48&&rv<=68&&hour>prior&&closes.at(-1)>hour;
      const short=ma8<ma21&&rv>=32&&rv<=52&&hour<prior&&closes.at(-1)<hour;
      if(!long&&!short)continue;
      const direction=long?'LONG':'SHORT';
      const r=rate(),take=settings.take/100,stop=settings.stop/100;
      const expected=MAX_TRADE*((1-r)*(1+take)*(1-r)-1);
      const risk=MAX_TRADE*((1-r)*(1-stop)*(1-r)-1);
      // SHORT: qty nominale = amount / entry; si addebitano costi di ingresso e uscita.
      const shortExpected=MAX_TRADE*(take-r-r*(1-take));
      const shortRisk=-MAX_TRADE*(stop+r+r*(1+stop));
      const gain=long?expected:shortExpected,loss=long?risk:shortRisk;
      const ratio=loss<0?gain/(-loss):0;
      if(!(gain>0&&loss<0&&ratio>=1.2)){
        log(`Scartato: netto target ${num(gain)} USDC · perdita stop ${num(loss)} USDC · rapporto ${fmt(ratio,2)} (minimo 1,20)`,pair,direction);continue;
      }
      if(auto.position){log('Segnale valido, ma posizione virtuale già aperta',pair,direction);continue;}
      if(!(m.price>0)||Date.now()-lastPairUpdate[pair]>STALE_MS){log('Scartato: prezzo ticker non aggiornato',pair,direction);continue;}
      const amount=Math.min(MAX_TRADE,auto.cash);
      if(amount<5){log('Liquidità simulata insufficiente',pair,direction);continue;}
      const qty=long?amount*(1-r)/m.price:amount/m.price;
      auto.cash-=amount;
      auto.position={pair,direction,qty,amount,entry:m.price,stop:m.price*(long?1-stop:1+stop),take:m.price*(long?1+take:1-take)};
      auto.trades.push({time:Date.now(),pair,direction,event:'APERTURA SIM.',price:m.price,amount,pnl:null,reason:'Segnale 5m chiuso + filtro trend 1h proxy'});
      log(`Apertura virtuale ${num(amount)} USDC · netto target ${num(gain)} · perdita stop ${num(loss)} · rapporto ${fmt(ratio,2)} · nessun ordine reale`,pair,direction);
      break;
    }
    save();display();
  }
  $a('autoStart').onclick=()=>{auto.enabled=true;log('Laboratorio avviato manualmente');save();tick();display();};
  $a('autoStop').onclick=()=>{auto.enabled=false;log('Laboratorio in pausa; eventuale posizione virtuale rimane aperta');save();display();};
  $a('autoReset').onclick=()=>{if(!confirm('Azzerare SOLTANTO il laboratorio intraday? La simulazione manuale e il saldo Kraken reale non cambiano.'))return;auto=defaultState();save();display();};
  $a('autoExport').onclick=()=>{
    const rows=[['ora_utc','mercato','direzione','evento','prezzo','importo_usdc','pnl_netto_usdc','motivo'],...auto.trades.map(t=>[new Date(t.time).toISOString(),t.pair,t.direction||'LONG',t.event,t.price,t.amount,t.pnl??'',t.reason])];
    const blob=new Blob(['\ufeff'+rows.map(row=>row.join(';')).join('\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='kraken-intraday-simulato-v1.6.1.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  save();display();setInterval(()=>{try{tick();}catch(e){console.error('Laboratorio intraday:',e);auto.enabled=false;log('Errore interno: simulazione messa in pausa');save();display();}},REFRESH_MS);
})();

// v2.2 — Assistente decisionale locale, senza API AI e SENZA ordini reali.
// Le conferme registrano soltanto una proposta: nessuna chiamata Kraken privata.
(() => {
  const WATCH=['BTC/USDC','ETH/USDC'], STORE='ktm_advisor_v20';
  const MAX_AMOUNT=10, INTERVAL=15000, MAX_AGE=30000;
  const $b=id=>document.getElementById(id);
  const escapeHTML=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let store={history:[],dismissed:{}};
  try {const old=JSON.parse(localStorage.getItem(STORE));if(old&&typeof old==='object')store={...store,...old};}catch{}
  const save=()=>{try{localStorage.setItem(STORE,JSON.stringify(store));}catch{}};
  const root=document.createElement('section');root.className='panel ranking-panel';
  root.innerHTML=`<div class="heading"><h2>Assistente decisionale v2.2 · rischio dinamico ATR</h2><span id="advisorStatus" class="pill neutral">In attesa dati</span></div>
    <p class="foot">Analisi quantitativa locale gratuita, non AI generativa. Confronto LONG e SHORT ogni 15 secondi, con stop/target dinamici ATR su candele da 5 minuti chiuse e ticker aggiornati. Nessun ordine reale: la conferma salva solo una proposta. Funziona mentre questa pagina è aperta.</p>
    <div id="advisorClock" class="foot" aria-live="off">Ultima analisi: — · Prossima analisi: —</div>
    <div class="actions"><button id="advisorRefresh" class="secondary" type="button">Analizza ora</button><button id="advisorExport" class="secondary" type="button">Esporta decisioni CSV</button></div>
    <div class="tablewrap"><table><thead><tr><th>Mercato</th><th>Direzione</th><th>Valutazione</th><th>Rischio netto</th><th>Target netto</th><th>Rapporto</th><th>Stop / target</th><th>Motivazione</th><th>Azione</th></tr></thead><tbody id="advisorRows"></tbody></table></div>
    <h3>Registro decisioni</h3><div class="tablewrap"><table><thead><tr><th>Data e ora</th><th>Mercato</th><th>Direzione</th><th>Decisione</th></tr></thead><tbody id="advisorHistory"></tbody></table></div>
    <p class="foot">Le due direzioni sono sempre confrontate: i numeri sono scenari ipotetici, NON segnali di entrata. Le perdite indicate sono scenari a stop teorico, non perdite massime garantite. Lo SHORT è solo un'ipotesi contabile senza leva: su Kraken spot non equivale a una vendita allo scoperto. Nessuna probabilità di successo inventata. ATR e prezzi sono indicativi; gap e slippage reali possono causare perdite maggiori.</p>`;
  const main=document.querySelector('main');if(main)main.insertBefore(root,main.firstChild);
  let proposals={},lastAnalysis=0;
  const clock=()=>{const elapsed=lastAnalysis?Math.max(0,Math.floor((Date.now()-lastAnalysis)/1000)):0;const remaining=lastAnalysis?Math.max(0,Math.ceil((INTERVAL-(Date.now()-lastAnalysis))/1000)):0;$b('advisorClock').textContent=`Ultima analisi: ${lastAnalysis?new Date(lastAnalysis).toLocaleTimeString('it-IT'):'—'} · Prossima analisi: tra ${remaining} s · Aggiornamento automatico ogni 15 s`;};
  function record(pair,direction,message){store.history.unshift({time:Date.now(),pair,direction,message});store.history=store.history.slice(0,150);save();drawHistory();}
  function drawHistory(){
    $b('advisorHistory').innerHTML=store.history.slice(0,35).map(x=>`<tr><td>${new Date(x.time).toLocaleString('it-IT')}</td><td>${escapeHTML(x.pair)}</td><td>${escapeHTML(x.direction)}</td><td>${escapeHTML(x.message)}</td></tr>`).join('')||'<tr><td colspan="4">Nessuna decisione registrata.</td></tr>';
  }
  function evaluate(pair){
    const m=market[pair],last=lastPairUpdate[pair],now=Date.now();
    if(!(m.price>0)||now-last>MAX_AGE)return {pair,ready:false,why:'Ticker assente o non aggiornato'};
    const bars=[...m.ohlc.entries()].filter(([t,c])=>t+300000<=now&&[c.open,c.high,c.low,c.close].every(x=>Number.isFinite(x)&&x>0)).sort((a,b)=>a[0]-b[0]);
    if(bars.length<60)return {pair,ready:false,why:'Attendo almeno 60 candele chiuse da 5 minuti'};
    const closes=bars.slice(-55).map(x=>x[1].close),avg=arr=>arr.reduce((a,b)=>a+b,0)/arr.length;
    const fast=avg(closes.slice(-8)),slow=avg(closes.slice(-21)),rv=rsi(closes);
    const hour=avg(closes.slice(-12)),prior=avg(closes.slice(-24,-12));
    const long=fast>slow&&rv>=48&&rv<=68&&hour>prior&&closes.at(-1)>hour;
    const short=fast<slow&&rv>=32&&rv<=52&&hour<prior&&closes.at(-1)<hour;
    // ATR(14) calcolato ESCLUSIVAMENTE su candele 5m chiuse.
    const recent=bars.slice(-15).map(([,c])=>c);
    let trueRange=0;
    for(let i=1;i<recent.length;i++){
      const c=recent[i],prev=recent[i-1];
      trueRange+=Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close));
    }
    const atr=trueRange/14,atrPct=100*atr/m.price;
    const amount=MAX_AMOUNT,rate=costRate(),MAX_STOP_PCT=2,MAX_TARGET_PCT=8,MIN_RR=1.2;
    // Stop: tra 0,8% e il limite 2%, scelto in funzione di 1,6 ATR.
    // Il target segue 2,4 ATR, ma non viene aumentato artificialmente per far passare il filtro.
    const stopPct=Math.max(0.8,Math.min(MAX_STOP_PCT,1.6*atrPct));
    const targetPct=Math.max(1.2,Math.min(MAX_TARGET_PCT,2.4*atrPct));
    const stop=stopPct/100,take=targetPct/100;
    const gainLong=amount*((1-rate)*(1+take)*(1-rate)-1);
    const lossLong=amount*((1-rate)*(1-stop)*(1-rate)-1);
    const gainShort=amount*(take-rate-rate*(1-take));
    const lossShort=-amount*(stop+rate+rate*(1+stop));
    const trend=fast>slow?'rialzista':fast<slow?'ribassista':'laterale';
    const common=`RSI ${fmt(rv,1)} · trend ${trend} · ATR ${fmt(atrPct,2)}% · stop ${fmt(stopPct,2)}% / target ${fmt(targetPct,2)}%`;
    const make=(direction,signal,gain,loss)=>{
      const ratio=loss<0?gain/-loss:0;
      const viable=signal&&gain>0&&loss<0&&ratio>=MIN_RR;
      const why=!signal?`Indicatori non concordi per ${direction} · ${common}`:!viable?`Segnale tecnico ${direction}, ma costi/rendimento-rischio insufficienti · ${common}`:`Segnale tecnico ${direction} e filtro rischio superato · ${common}`;
      return {pair,ready:true,direction,signal,viable,price:m.price,amount,gain,loss,ratio,stopPct,targetPct,atrPct,why,stamp:bars.at(-1)[0]};
    };
    return {pair,ready:true,scenarios:[make('LONG',long,gainLong,lossLong),make('SHORT',short,gainShort,lossShort)]};
  }
  function refresh(){
    const results=WATCH.map(evaluate);proposals={};
    for(const x of results)if(x.ready)for(const scenario of x.scenarios)if(scenario.viable)proposals[`${x.pair}|${scenario.direction}`]=scenario;
    const complete=results.every(x=>x.ready);
    $b('advisorStatus').textContent=complete?'Analisi attiva':'Dati incompleti';
    $b('advisorStatus').className='pill '+(complete?'up':'neutral');
    $b('advisorRows').innerHTML=results.map(x=>{
      if(!x.ready)return `<tr><td><b>${x.pair}</b></td><td>—</td><td>ATTENDI</td><td>—</td><td>—</td><td>—</td><td>—</td><td colspan="2">${escapeHTML(x.why)}</td></tr>`;
      return x.scenarios.map(y=>{
        const status=y.viable?'DA VALUTARE':'ATTENDI';
        const key=`${x.pair}|${y.direction}`;
        const action=y.viable?`<button class="secondary" type="button" data-advisor="${key}">Esamina proposta</button>`:'—';
        return `<tr><td><b>${x.pair}</b></td><td>${y.direction}</td><td>${status}</td><td class="down">${fmt(y.loss)} USDC</td><td class="${y.gain>=0?'up':'down'}">${fmt(y.gain)} USDC</td><td>${fmt(y.ratio,2)}</td><td>${fmt(y.stopPct,2)}% / ${fmt(y.targetPct,2)}%</td><td>${escapeHTML(y.why)}</td><td>${action}</td></tr>`;
      }).join('');
    }).join('');
    root.querySelectorAll('[data-advisor]').forEach(btn=>btn.onclick=()=>{
      const x=proposals[btn.dataset.advisor];if(!x)return;
      if(Date.now()-lastPairUpdate[x.pair]>MAX_AGE){alert('Prezzo non più aggiornato. Ripeti l’analisi.');refresh();return;}
      const msg=`PROPOSTA TEORICA ${x.direction} ${x.pair}\nImporto: ${fmt(x.amount)} USDC\nPrezzo osservato: ${fmt(x.price,5)}\nTarget netto stimato: ${fmt(x.gain)} USDC\nPerdita allo stop teorico: ${fmt(x.loss)} USDC\nRapporto: ${fmt(x.ratio,2)}\nStop/target dinamici: ${fmt(x.stopPct,2)}% / ${fmt(x.targetPct,2)}%\nATR: ${fmt(x.atrPct,2)}%\n\nConfermare l’interesse per questa proposta? NON sarà inviato alcun ordine reale né simulato.`;
      if(confirm(msg))record(x.pair,x.direction,`Interesse confermato · solo registrazione · prezzo ${fmt(x.price,5)} · nessun ordine inviato`);
      else record(x.pair,x.direction,'Proposta non confermata');
    });
    lastAnalysis=Date.now();clock();
  }
  $b('advisorRefresh').onclick=refresh;
  $b('advisorExport').onclick=()=>{
    const clean=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
    const rows=[['ora_utc','mercato','direzione','decisione'],...store.history.map(x=>[new Date(x.time).toISOString(),x.pair,x.direction,x.message])];
    const csv='\ufeff'+rows.map(r=>r.map(clean).join(';')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='kraken-decisioni-v2.2.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  drawHistory();refresh();setInterval(clock,1000);setInterval(()=>{try{refresh();}catch(e){console.error('Assistente decisionale:',e);$b('advisorStatus').textContent='Errore analisi';}},INTERVAL);
})();
