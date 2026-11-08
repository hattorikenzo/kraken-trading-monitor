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
