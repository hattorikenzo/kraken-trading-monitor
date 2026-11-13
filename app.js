'use strict';
// Kraken Opportunity Bot v3.8.0: segnali multi-timeframe, simulazione bid/ask corretta, spot con conferma.
(()=>{
 const $=id=>document.getElementById(id);
 const fmt=(n,d=3)=>Number.isFinite(n)?n.toLocaleString('it-IT',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const API='https://api.kraken.com/0/public/', SCAN_MS=300000, MAX_OHLC=50, MAX_FAST=15, CONCURRENCY=3;
 const MAX_TRADE=5, MIN_LIQUID_RESERVE=5;
 const FIAT=new Set(['USD','USDC','USDT','EUR','GBP','ZGBP','CHF','CAD','ZCAD','AUD','ZAUD','JPY','ZJPY','ZUSD','ZEUR','ZCHF','ZGBP','ZCAD','ZAR','BRL','TRY','PLN']);
 const isCrypto=s=>!FIAT.has(String(s).toUpperCase()); // limite del monitor; la funzione di validazione ha limiti propri.
 let balance=null,balanceAt=0,scanning=false,results=[],lastStats=''; let selectedLive=null; let holdings={},portfolioAt=0,openCount=null,heldSignals=[];
 let settings={maxTrade:5,fee:0.8,slippage:0.15}; let diagnostics=null;
 try{const s=JSON.parse(localStorage.getItem('kraken_bot_v3_settings'));if(s)settings={...settings,...s}}catch{}
 settings.maxTrade=Math.min(MAX_TRADE,Math.max(1,Number(settings.maxTrade)||MAX_TRADE));
 for(const k of ['maxTrade','fee','slippage'])if($(k))$(k).value=settings[k];
 const setStatus=s=>{$('status').textContent=s};
 function showBalance(){const fresh=balance!==null&&Date.now()-balanceAt<300000;$('realBalance').textContent=balance===null?'—':fmt(balance,6)+' USDC';$('balanceTime').textContent=balanceAt?new Date(balanceAt).toLocaleString('it-IT'):'Non ancora letto';$('budgetValue').textContent=fresh?fmt(Math.max(0,Math.min(MAX_TRADE,settings.maxTrade,balance-MIN_LIQUID_RESERVE)),2)+' USDC':'—';}
 window.addEventListener('kraken-balance',e=>{const v=e.detail?.balances?.USDC;balance=typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v)?Number(v):null;balanceAt=Date.parse(e.detail?.timestamp)||Date.now();showBalance();render()});
 window.addEventListener('kraken-portfolio',e=>{holdings=e.detail?.holdings||{};portfolioAt=Number(e.detail?.at)||Date.now();openCount=Number.isInteger(Number(e.detail?.openCount))&&e.detail?.openCount!=null?Number(e.detail.openCount):null;render();});
  window.addEventListener('kraken-auth-logout',()=>{holdings={};portfolioAt=0;openCount=null;balance=null;balanceAt=0;selectedLive=null;window.krakenSelectedOrder=null;showBalance();render()});
 window.addEventListener('kraken-auth-ready',()=>void readBalance());
 async function readBalance(){if(typeof window.krakenReadBalance!=='function')return;const b=$('refreshBalance');b.disabled=true;try{await window.krakenReadBalance()}catch(e){balance=null;balanceAt=0;showBalance();$('decision').textContent='Saldo non disponibile: '+e.message}finally{b.disabled=false}}
 $('refreshBalance').onclick=()=>void readBalance();
 $('saveSettings').onclick=()=>{const maxTrade=Number($('maxTrade').value),fee=Number($('fee').value),slippage=Number($('slippage').value);if(!Number.isFinite(maxTrade)||maxTrade<1||maxTrade>5||!Number.isFinite(fee)||fee<0||fee>5||!Number.isFinite(slippage)||slippage<0||slippage>5){alert('Importo 1–5 USDC; commissione e slippage 0–5%.');return}settings={maxTrade,fee,slippage};localStorage.setItem('kraken_bot_v3_settings',JSON.stringify(settings));showBalance();render()};
 async function api(path,params={}){const url=new URL(API+path);Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,String(v)));const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),18000);try{const r=await fetch(url,{cache:'no-store',signal:ctrl.signal});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();if(j.error?.length)throw Error(j.error.join('; '));return j.result||{}}finally{clearTimeout(timer)}}
 const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
 function rsi(c){if(c.length<16)return 50;let up=0,down=0;for(let i=c.length-14;i<c.length;i++){const d=c[i]-c[i-1];up+=Math.max(d,0);down+=Math.max(-d,0)}return down===0?(up?100:50):100-100/(1+up/down)}
 function markets(raw){return Object.entries(raw).filter(([id,p])=>p&&p.status==='online'&&p.wsname?.includes('/')&&!p.wsname.includes('.d')&&p.base&&p.quote&&isCrypto(p.base)).map(([id,p])=>({id,name:p.wsname,base:p.base,quote:p.quote,ordermin:Number(p.ordermin)||0,costmin:Number(p.costmin)||0}));}
 function tickerFor(tickers,p){return tickers[p.id]||tickers[p.name.replace('/','')]||null}
 function graphFrom(list,tickers){const graph=new Map(),market=[];const add=(a,e)=>{if(!graph.has(a))graph.set(a,[]);graph.get(a).push(e)};
  for(const p of list){const t=tickerFor(tickers,p);if(!t)continue;const bid=Number(t.b?.[0]),ask=Number(t.a?.[0]),last=Number(t.c?.[0]),volume=Number(t.v?.[1]);if(!(bid>0&&ask>=bid&&last>0&&volume>0))continue;const spread=100*(ask-bid)/((ask+bid)/2);if(spread>1.5)continue;const opening=Number(t.o),change24=opening>0?100*(last/opening-1):NaN;const m={...p,bid,ask,last,volume,spread,change24};market.push(m);
   add(p.quote,{from:p.quote,to:p.base,market:m,side:'buy',rate:1/ask});add(p.base,{from:p.base,to:p.quote,market:m,side:'sell',rate:bid});
  }return {graph,market};}
 // Le quotazioni per ogni lato sono già bid/ask. Nessun moltiplicatore spread aggiuntivo.
 function routes(graph){const out=[];const start=graph.get('USDC')||[];for(const a of start){if(a.to==='USDC')continue;out.push([a]);for(const b of graph.get(a.to)||[]){if(b.to==='USDC'||b.to===a.from||b.market.id===a.market.id)continue;out.push([a,b]);}}return out;}
 // Esegue un percorso spot ai bid/ask. Le commissioni e lo slippage sono applicati una volta per gamba.
 function routeMetrics(path,amount){
  let qty=amount,ok=Number.isFinite(amount)&&amount>0;
  const friction=(settings.fee+settings.slippage)/100;
  for(const e of path){const m=e.market;
   if(e.side==='buy'){
    if(qty+1e-9<Math.max(m.costmin,m.ordermin*m.ask))ok=false;
    qty=qty*(1-friction)/m.ask;
   }else{
    if(qty+1e-9<m.ordermin||qty*m.bid+1e-9<m.costmin)ok=false;
    qty=qty*m.bid*(1-friction);
   }
  }
  let back=qty;
  for(const e of [...path].reverse()){const m=e.market;
   if(e.side==='buy'){ // ritorno: vendiamo il token acquistato, al bid
    if(back+1e-9<m.ordermin||back*m.bid+1e-9<m.costmin)ok=false;
    back=back*m.bid*(1-friction);
   }else{ // ritorno: ricompriamo il token venduto, all'ask
    if(back+1e-9<Math.max(m.costmin,m.ordermin*m.ask))ok=false;
    back=back*(1-friction)/m.ask;
   }
  }
  return {ok,qty,back,costPct:amount?100*(1-back/amount):Infinity};
 }
 function closedCandles(raw,interval,min){
  const key=Object.keys(raw).find(k=>k!=='last');const candles=raw[key];if(!Array.isArray(candles))return null;
  const now=Date.now()/1000,sec=interval*60;
  const rows=candles.filter(c=>Number(c[0])+sec<=now).map(c=>({t:+c[0],h:+c[2],l:+c[3],c:+c[4]})).filter(c=>c.c>0&&c.h>0&&c.l>0).sort((a,b)=>a.t-b.t);
  return rows.length>=min&&now-rows.at(-1).t<=sec*3?rows:null;
 }
 function analyze(raw,route,amount){
  const last=route.at(-1),m=last.market,rows=closedCandles(raw,60,55);if(!rows)return null;
  const c=rows.map(x=>x.c),fast=mean(c.slice(-8)),slow=mean(c.slice(-24)),prev=mean(c.slice(-48,-24)),rv=rsi(c);
  let tr=0;for(let i=rows.length-14;i<rows.length;i++)tr+=Math.max(rows[i].h-rows[i].l,Math.abs(rows[i].h-rows[i-1].c),Math.abs(rows[i].l-rows[i-1].c));
  const atr=100*(tr/14)/c.at(-1),momentum=100*(c.at(-1)/c.at(-24)-1);
  const direction=last.side==='buy'?'LONG':'ROTAZIONE';
  const momentumContext=fast>slow&&rv>=43&&rv<=79&&momentum>0.15;
  const reboundContext=momentum<0&&momentum>-15&&rv>=25&&rv<=58&&c.at(-1)>c.at(-4);
  const trend=momentumContext||reboundContext;
  const strategy=momentumContext?'MOMENTUM':reboundContext?'RIMBALZO':'NESSUN SEGNALE';
  const metrics=routeMetrics(route,amount),spreadMax=Math.max(...route.map(e=>e.market.spread));
  const targetPct=Math.max(2.5,Math.min(10,3.5*atr));
  const stopPct=Math.max(1.2,Math.min(6,2*atr));
  // Scenario su un acquisto diretto USDC: il prezzo di vendita futuro è un bid ipotetico,
  // non un profitto previsto. Include bid/ask attuali, commissioni e slippage in entrambi i versi.
  const gain=metrics.back*(1+targetPct/100)-amount;
  const loss=metrics.back*(1-stopPct/100)-amount;
  const ratio=loss<0?gain/-loss:0;
  const direct=route.length===1&&last.side==='buy'&&m.quote==='USDC';
  const structural=direct&&metrics.ok&&spreadMax<=0.6&&gain>0&&loss<0&&ratio>=1.25&&amount>=5;
  // Un segnale a 15m chiuso è obbligatorio: i soli dati orari non autorizzano l'acquisto.
  return {name:last.to,path:route.map(e=>e.market.name+' '+(e.side==='buy'?'acquista':'vendi')).join(' → '),route,direction,
   strategy,eligible:false,trend,structural,fastChecked:false,fastOk:false,amount,gain,loss,ratio,rv,atr,momentum,targetPct,stopPct,
   costPct:metrics.costPct,spreadMax,score:(trend?45:0)+Math.min(20,Math.max(0,momentum*3))+Math.max(0,20-metrics.costPct*5)+Math.min(15,Math.max(0,ratio)*4),
   why:!direct?'Percorso indiretto: solo informativo':!metrics.ok?'Importo inferiore ai minimi Kraken':spreadMax>0.6?'Spread superiore allo 0,6%':gain<=0?'Target inferiore ai costi':loss>=0||ratio<1.25?'Rapporto rischio/rendimento insufficiente':!trend?'Contesto orario non confermato':'Attende conferma a 15 minuti'};
 }
 function confirmFast(x,raw){
  x.fastChecked=true;
  const rows=closedCandles(raw,15,40);if(!rows){x.why='Candele 15m mancanti o non aggiornate';return}
  const c=rows.map(r=>r.c),r=rsi(c),f=mean(c.slice(-6)),s=mean(c.slice(-20)),previous=mean(c.slice(-12,-6));
  const shortMove=100*(c.at(-1)/c.at(-5)-1);
  const momentum=f>s&&r>=48&&r<=76&&shortMove>0.08&&c.at(-1)>previous;
  const rebound=c.at(-1)>c.at(-4)&&c.at(-1)>f&&r>=35&&r<=65&&shortMove>0.1&&x.momentum<0;
  x.fastOk=momentum||rebound;
  x.strategy=momentum?'MOMENTUM 15m':rebound?'RIMBALZO 15m':x.strategy;
  x.eligible=x.structural&&x.fastOk&&x.trend;
  x.why=x.eligible?'Segnale 1h + 15m confermato':!x.structural?x.why:!x.trend?'Contesto orario non confermato':'Segnale 15m non confermato';
  x.score+=x.fastOk?25:0;
 }
 // Budget dinamico: utilizza soltanto segnali gia approvati, non trasforma segnali scartati in ordini.
 function dynamicBudget(candidate){
  // Conservative proposal only: account balance is NOT an authoritative atomic reservation.
  // Keep 5 USDC liquid, include estimated fee and slippage within the 5 USDC debit cap.
  const fresh=balance!==null&&Date.now()-balanceAt<300000;
  if(!candidate||!candidate.eligible||!fresh)return 0;
  const estimatedMultiplier=1+(Math.max(0,Number(settings.fee)||0)+Math.max(0,Number(settings.slippage)||0))/100;
  const liquid=Math.max(0,Number(balance)-MIN_LIQUID_RESERVE);
  const grossCap=Math.min(MAX_TRADE,Number(settings.maxTrade)||0,liquid);
  const notional=Math.floor(grossCap/estimatedMultiplier*100)/100;
  return notional>=2?notional:0;
 }
 function render(){const fresh=balance!==null&&Date.now()-balanceAt<300000;const top=results.filter(x=>x.route.length===1&&x.route[0].market.quote==='USDC').slice().sort((a,b)=>Number(b.eligible)-Number(a.eligible)||Number(b.fastOk)-Number(a.fastOk)||Number(b.trend)-Number(a.trend)||b.score-a.score).slice(0,5);
  $('opportunities').innerHTML=top.map(x=>`<tr><td>${esc(x.name)}<small style="display:block">${x.route.length} scambio/i</small></td><td>${x.direction} <small style="display:block">${esc(x.strategy||'')}</small></td><td class="${x.eligible?'up':''}">${esc(x.why)}</td><td class="${x.gain>=0?'up':'down'}">${x.route.length>1?'n.d.':fmt(x.gain,3)+' USDC'}</td><td>${fmt(x.costPct,2)}%</td></tr>`).join('')||'<tr><td colspan="5">Nessun percorso analizzato.</td></tr>';
   const sell=heldSignals.find(x=>{const m=x.route[0].market;const held=Number(holdings[m.base]||0);return held*m.bid>=Math.max(2,m.costmin,m.ordermin*m.bid)});
   const safePortfolio=portfolioAt>0&&Date.now()-portfolioAt<300000&&openCount===0;
   if(sell&&safePortfolio&&fresh){const m=sell.route[0].market;const held=Number(holdings[m.base]);const budget=Math.min(20,settings.maxTrade,held*m.bid*0.98);
    if(budget>=Math.max(2,m.costmin,m.ordermin*m.bid)){
      window.krakenSelectedOrder={pair:m.name.replace('/',''),side:'sell',budgetUSDC:String(budget)};
      $('prepareOrder').disabled=false;$('decisionStatus').textContent='VENDITA DA VALUTARE';
      $('decision').textContent=`Il bot propone di VENDERE parte di ${sell.name} già posseduto. Momentum 24h: ${fmt(sell.momentum,2)}%, RSI: ${fmt(sell.rv,1)}. Controvalore massimo: ${fmt(budget,2)} USDC. È un segnale di rischio, non un profitto garantito. Ordine spot LIMIT da validare e confermare manualmente.`;
      return;
    }
   }
  const best=results.filter(x=>x.eligible && x.route.length===1 && x.route[0].side==='buy' && x.route[0].market.quote==='USDC').sort((a,b)=>b.gain-a.gain||b.score-a.score)[0]; selectedLive=best||null; const chosenBudget=dynamicBudget(best); window.krakenSelectedOrder=best&&chosenBudget>=2?{pair:best.route[0].market.name.replace('/',''),side:'buy',budgetUSDC:String(chosenBudget)}:null; const orderBtn=$('prepareOrder');if(orderBtn)orderBtn.disabled=!best||chosenBudget<2||!fresh||!safePortfolio;
  if(!fresh){window.krakenSelectedOrder=null;if($('prepareOrder'))$('prepareOrder').disabled=true;$('decisionStatus').textContent='SALDO DA VERIFICARE';$('decision').textContent='Accedi e aggiorna il saldo reale. Le analisi pubbliche sono disponibili, ma non formuliamo importi con saldo non recente.';return}
  if(!best||chosenBudget<5){window.krakenSelectedOrder=null;if($('prepareOrder'))$('prepareOrder').disabled=true;$('decisionStatus').textContent='ATTENDI';$('decision').textContent='Nessun acquisto approvato. '+(diagnostics?.summary||'Diagnostica non ancora disponibile.')+' Conservare USDC è una scelta valida; nessun ordine viene inviato.';return}
  if(!safePortfolio){window.krakenSelectedOrder=null;$('prepareOrder').disabled=true;$('decisionStatus').textContent='PORTAFOGLIO DA VERIFICARE';$('decision').textContent='È disponibile un segnale, ma il portafoglio o gli ordini aperti non sono stati verificati recentemente. Premi Controlla ordini Kraken.';return}
   $('decisionStatus').textContent='ACQUISTO DA VALUTARE';$('decision').textContent=`Strategia: ${best.strategy}\nDestinazione: ${best.name}\nPercorso: USDC → ${best.route.map(e=>e.to).join(' → ')}\nGambe: ${best.path}\nImporto scelto dal bot: ${fmt(chosenBudget,2)} USDC (saldo totale; disponibilità effettiva da verificare)\nCosto stimato di andata e ritorno: ${fmt(best.costPct,2)}%\nScenario ipotetico sul mercato finale: +${fmt(best.targetPct,2)}% · Stop teorico: −${fmt(best.stopPct,2)}%\nRisultato ipotetico al target: ${fmt(best.gain,3)} USDC · allo stop: ${fmt(best.loss,3)} USDC\nRSI: ${fmt(best.rv,1)} · Momentum 24h: ${fmt(best.momentum,2)}%\nATTENZIONE: il target riguarda l'ultima coppia e NON garantisce il risultato in USDC di un percorso multi-gamba. Prezzi, liquidità e minimi devono essere ricontrollati prima di qualunque scambio. Nessun ordine viene inviato.`;
 }
 async function scan(){if(scanning)return;scanning=true;results=[];diagnostics=null;selectedLive=null;window.krakenSelectedOrder=null;$('prepareOrder').disabled=true;$('scanNow').disabled=true;setStatus('Analisi di tutte le coppie spot…');try{
  const all=markets(await api('AssetPairs'));$('marketCount').textContent=String(all.length);
  // Ticker senza parametro pair: snapshot di tutti i mercati. Nessuna richiesta OHLC per migliaia di coppie.
  const tickers=await api('Ticker');const {graph,market}=graphFrom(all,tickers);const paths=routes(graph);const amount=balance!==null?Math.max(0,Math.min(MAX_TRADE,settings.maxTrade,balance-MIN_LIQUID_RESERVE)/1.03):Math.min(MAX_TRADE,settings.maxTrade);
  // Valutiamo TUTTI i percorsi a prezzi bid/ask, poi usiamo OHLC solo sui candidati più praticabili.
  const eligiblePaths=paths.map(path=>({path,metrics:routeMetrics(path,amount)})).filter(x=>x.metrics.ok&&x.metrics.costPct<5&&x.path.every(e=>e.market.spread<=1));
   // Diversificazione: non scegliere i 50 OHLC soltanto in base allo spread.
   // Le variazioni 24h del ticker sono un filtro preliminare, NON segnali di acquisto.
   const direct=eligiblePaths.filter(x=>x.path.length===1&&x.path[0].side==='buy'&&x.path[0].market.quote==='USDC');
   const other=eligiblePaths.filter(x=>!(x.path.length===1&&x.path[0].side==='buy'&&x.path[0].market.quote==='USDC'));
   const change24=x=>{const m=x.path.at(-1).market;return Number.isFinite(m.change24)?m.change24:0};
   const liquidity=x=>{const m=x.path.at(-1).market;return m.quote==='USDC'?m.volume*m.last:0};
   const selected=[],seen=new Set();
   function addCandidates(pool,limit){for(const x of pool){const id=x.path.at(-1).market.id;if(seen.has(id))continue;seen.add(id);selected.push(x);if(selected.length>=limit)break}}
   const byMomentum=[...direct].sort((a,b)=>change24(b)-change24(a));
   const byDip=[...direct].filter(x=>change24(x)<0).sort((a,b)=>change24(a)-change24(b));
   const byLiquidity=[...direct].sort((a,b)=>liquidity(b)-liquidity(a));
   const byCost=[...direct].sort((a,b)=>a.metrics.costPct-b.metrics.costPct);
   // Priorità a mercati USDC di asset realmente posseduti, per valutare anche vendite.
   const heldAssets=new Set(Object.entries(holdings).filter(([asset,qty])=>asset!=='USDC'&&Number(qty)>0).map(([asset])=>asset));
   const heldDirect=[...direct].filter(x=>heldAssets.has(x.path[0].market.base));
   addCandidates(heldDirect,Math.min(12,MAX_OHLC));
   addCandidates(byMomentum,Math.max(selected.length,18));
   addCandidates(byDip,30);
   addCandidates(byLiquidity,42);
   addCandidates(byCost,MAX_OHLC);
   // Le rotazioni sono monitorate soltanto come contesto, non abilitate al trading.
   addCandidates([...other].sort((a,b)=>a.metrics.costPct-b.metrics.costPct),MAX_OHLC);
  $('coverage').textContent=`${market.length} ticker validi · ${paths.length} percorsi ≤2 scambi · ${selected.length} OHLC`;
  const found=[];let ok=0,errors=0;for(let i=0;i<selected.length;i+=CONCURRENCY){await Promise.all(selected.slice(i,i+CONCURRENCY).map(async x=>{try{const raw=await api('OHLC',{pair:x.path.at(-1).market.id,interval:60});const item=analyze(raw,x.path,amount);if(item){found.push(item);ok++}else errors++}catch(e){errors++;console.warn('OHLC',x.path.at(-1).market.name,e.message)}}));}
  // Seconda fase: fino a 15 candele 15m per i migliori mercati USDC diretti.
  // Mai scambiare un segnale basato solo sulla candela oraria.
  const fastPool=found.filter(x=>x.route.length===1&&x.route[0].market.quote==='USDC'&&x.structural)
    .sort((a,b)=>Number(b.trend)-Number(a.trend)||b.score-a.score).slice(0,MAX_FAST);
  let fastErrors=0;
  for(let i=0;i<fastPool.length;i+=CONCURRENCY){await Promise.all(fastPool.slice(i,i+CONCURRENCY).map(async x=>{
   try{const raw=await api('OHLC',{pair:x.route[0].market.id,interval:15});confirmFast(x,raw)}
   catch(e){fastErrors++;x.why='Errore conferma 15m';console.warn('OHLC 15m',x.name,e.message)}
  }))}
  results=found;
  heldSignals=found.filter(x=>x.route.length===1&&x.route[0].side==='buy'&&x.route[0].market.quote==='USDC'&&Number(holdings[x.route[0].market.base]||0)>0)
   .filter(x=>x.momentum< -1.5&&x.rv<46&&x.route[0].market.spread<=0.6)
   .sort((a,b)=>a.momentum-b.momentum);

   // Diagnostica esaustiva del campione: categorie mutuamente esclusive per ogni mercato diretto.
   // Non confondere una mancanza di segnale con un problema di fondi o di eseguibilità.
   const directFound=found.filter(x=>x.route.length===1&&x.route[0].side==='buy'&&x.route[0].market.quote==='USDC');
   const rejected={segnale:0,fast:0,minimi:0,spread:0,costi:0,rischio:0,idonei:0};
   for(const x of directFound){
    if(!routeMetrics(x.route,x.amount).ok)rejected.minimi++;
    else if(x.spreadMax>0.6)rejected.spread++;
    else if(x.gain<=0)rejected.costi++;
    else if(x.loss>=0||x.ratio<1.25)rejected.rischio++;
    else if(!x.trend)rejected.segnale++;
    else if(!x.fastOk)rejected.fast++;
    else if(x.eligible)rejected.idonei++;
    else rejected.segnale++;
   }
   const candidates=[...directFound].sort((a,b)=>Number(b.structural)-Number(a.structural)||Number(b.trend)-Number(a.trend)||b.score-a.score);
   const bestRejected=candidates.find(x=>!x.eligible);
   const missedOHLC=selected.length-found.length;
   const operational=[];
   if(balance===null||Date.now()-balanceAt>=300000)operational.push('saldo USDC non aggiornato');
   if(portfolioAt===0||Date.now()-portfolioAt>=300000)operational.push('portafoglio non aggiornato');
   if(openCount===null)operational.push('numero ordini aperti sconosciuto');
   else if(openCount>0)operational.push(openCount+' ordini aperti');
   const summary=rejected.idonei?'Segnali idonei: '+rejected.idonei+'.'+(operational.length?' Operatività bloccata: '+operational.join(', ')+'.':''):
    'Su '+directFound.length+' mercati USDC diretti esaminati: '+rejected.segnale+' senza contesto orario, '+rejected.fast+' senza conferma 15m, '+rejected.minimi+' sotto i minimi, '+rejected.spread+' esclusi per spread, '+rejected.costi+' con target non sufficiente ai costi, '+rejected.rischio+' con rischio/rendimento insufficiente.'+
    (bestRejected?' Miglior candidato escluso: '+bestRejected.name+' ('+bestRejected.why+', momentum '+fmt(bestRejected.momentum,2)+'%, costo stimato A/R '+fmt(bestRejected.costPct,2)+'%).':'')+
    (operational.length?' Controlli operativi da completare: '+operational.join(', ')+'.':'');
   diagnostics={summary,rejected,operational};
   lastStats=`DIAGNOSTICA v3.8.0 — ${summary}\n\nCopertura: ${all.length} coppie spot, ${market.length} ticker validi, ${paths.length} percorsi da USDC; ${eligiblePaths.length} percorsi praticabili al controllo preliminare.\nAnalisi 1h: ${found.length} risultati validi su ${selected.length} richieste (mancanti/non validi: ${missedOHLC}; errori API: ${errors}). Conferme 15m: ${fastPool.filter(x=>x.fastChecked).length}/${fastPool.length}; errori: ${fastErrors}.\nMercati diretti USDC analizzati: ${directFound.length}; percorsi indiretti solo informativi: ${found.length-directFound.length}.\nLimite: ${MAX_OHLC} OHLC 1h e ${MAX_FAST} OHLC 15m per scansione ogni 5 minuti; non rappresenta l'intero mercato.\nImpostazioni: commissione stimata ${fmt(settings.fee,2)}% per lato, slippage ${fmt(settings.slippage,2)}% per lato; non sono necessariamente le commissioni reali del tuo account.\nPosizioni con segnale di vendita: ${heldSignals.length}.\nUn segnale non dimostra un profitto futuro. Nessun ordine automatico.`;
  $('scanDetails').textContent=lastStats;$('scanTime').textContent='Ultima analisi: '+new Date().toLocaleTimeString('it-IT');setStatus('Analisi completata');render();
 }catch(e){setStatus('Errore analisi');$('scanDetails').textContent='Errore API pubblica Kraken: '+e.message;console.error(e)}finally{scanning=false;$('scanNow').disabled=false}}
 $('scanNow').onclick=()=>void scan();showBalance();render();void scan();setInterval(()=>void scan(),SCAN_MS);setInterval(()=>{if(balance!==null&&Date.now()-balanceAt>240000)void readBalance();else render()},60000);
})();
