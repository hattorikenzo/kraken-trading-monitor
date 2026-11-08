'use strict';
// Kraken Opportunity Bot v3.7.1: diagnostica trasparente, scanner spot, esecuzione solo con conferma e blocco server.
(()=>{
 const $=id=>document.getElementById(id);
 const fmt=(n,d=3)=>Number.isFinite(n)?n.toLocaleString('it-IT',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const API='https://api.kraken.com/0/public/', SCAN_MS=300000, MAX_OHLC=50, CONCURRENCY=3;
 const MAX_TRADE=10;
 const FIAT=new Set(['USD','USDC','USDT','EUR','GBP','ZGBP','CHF','CAD','ZCAD','AUD','ZAUD','JPY','ZJPY','ZUSD','ZEUR','ZCHF','ZGBP','ZCAD','ZAR','BRL','TRY','PLN']);
 const isCrypto=s=>!FIAT.has(String(s).toUpperCase()); // limite del monitor; la funzione di validazione ha limiti propri.
 let balance=null,balanceAt=0,scanning=false,results=[],lastStats=''; let selectedLive=null; let holdings={},portfolioAt=0,openCount=null,heldSignals=[];
 let settings={maxTrade:10,fee:0.8,slippage:0.15}; let diagnostics=null;
 try{const s=JSON.parse(localStorage.getItem('kraken_bot_v3_settings'));if(s)settings={...settings,...s}}catch{}
 for(const k of ['maxTrade','fee','slippage'])if($(k))$(k).value=settings[k];
 const setStatus=s=>{$('status').textContent=s};
 function showBalance(){const fresh=balance!==null&&Date.now()-balanceAt<300000;$('realBalance').textContent=balance===null?'—':fmt(balance,6)+' USDC';$('balanceTime').textContent=balanceAt?new Date(balanceAt).toLocaleString('it-IT'):'Non ancora letto';$('budgetValue').textContent=fresh?fmt(Math.min(MAX_TRADE,settings.maxTrade,balance),2)+' USDC':'—';}
 window.addEventListener('kraken-balance',e=>{const v=e.detail?.balances?.USDC;balance=typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v)?Number(v):null;balanceAt=Date.parse(e.detail?.timestamp)||Date.now();showBalance();render()});
 window.addEventListener('kraken-portfolio',e=>{holdings=e.detail?.holdings||{};portfolioAt=Number(e.detail?.at)||Date.now();openCount=Number.isInteger(Number(e.detail?.openCount))&&e.detail?.openCount!=null?Number(e.detail.openCount):null;render();});
  window.addEventListener('kraken-auth-logout',()=>{holdings={};portfolioAt=0;openCount=null;balance=null;balanceAt=0;selectedLive=null;window.krakenSelectedOrder=null;showBalance();render()});
 window.addEventListener('kraken-auth-ready',()=>void readBalance());
 async function readBalance(){if(typeof window.krakenReadBalance!=='function')return;const b=$('refreshBalance');b.disabled=true;try{await window.krakenReadBalance()}catch(e){balance=null;balanceAt=0;showBalance();$('decision').textContent='Saldo non disponibile: '+e.message}finally{b.disabled=false}}
 $('refreshBalance').onclick=()=>void readBalance();
 $('saveSettings').onclick=()=>{const maxTrade=Number($('maxTrade').value),fee=Number($('fee').value),slippage=Number($('slippage').value);if(!Number.isFinite(maxTrade)||maxTrade<1||maxTrade>10||!Number.isFinite(fee)||fee<0||fee>5||!Number.isFinite(slippage)||slippage<0||slippage>5){alert('Importo 1–10 USDC; commissione e slippage 0–5%.');return}settings={maxTrade,fee,slippage};localStorage.setItem('kraken_bot_v3_settings',JSON.stringify(settings));showBalance();render()};
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
 function routeMetrics(path,amount){let qty=amount,ok=true;const fee=(settings.fee+settings.slippage)/100;
  for(const e of path){const m=e.market;if(e.side==='buy'){const cost=qty;if(cost+1e-9<Math.max(m.costmin,m.ordermin*m.ask))ok=false;qty=qty*(1-fee)/m.ask;}else{if(qty+1e-9<m.ordermin||qty*m.bid+1e-9<m.costmin)ok=false;qty=qty*m.bid*(1-fee);}}
  // Ritorno stimato su coppie inverse: per stimare costi di uscita, NON è un ordine protettivo.
  let back=qty;for(const e of path.slice().reverse()){const m=e.market;if(e.side==='buy'){if(back+1e-9<m.ordermin||back*m.bid+1e-9<m.costmin)ok=false;back=back*m.bid*(1-fee)}else{if(back+1e-9<Math.max(m.costmin,m.ordermin*m.ask))ok=false;back=back*(1-fee)/m.ask}}
  return {ok,qty,back,costPct:amount?100*(1-back/amount):Infinity};
 }
 function analyze(raw,route,amount){const last=route.at(-1),m=last.market;const key=Object.keys(raw).find(k=>k!=='last');const candles=raw[key];if(!Array.isArray(candles))return null;
  const now=Date.now()/1000,rows=candles.filter(c=>Number(c[0])+3600<=now).map(c=>({t:+c[0],h:+c[2],l:+c[3],c:+c[4]})).filter(c=>c.c>0&&c.h>0&&c.l>0).sort((a,b)=>a.t-b.t);if(rows.length<55||now-rows.at(-1).t>10800)return null;
  const c=rows.map(x=>x.c),fast=mean(c.slice(-8)),slow=mean(c.slice(-24)),prev=mean(c.slice(-48,-24)),rv=rsi(c);let tr=0;for(let i=rows.length-14;i<rows.length;i++)tr+=Math.max(rows[i].h-rows[i].l,Math.abs(rows[i].h-rows[i-1].c),Math.abs(rows[i].l-rows[i-1].c));
  const atr=100*(tr/14)/c.at(-1),momentum=100*(c.at(-1)/c.at(-24)-1);
  // Trend dell'asset di destinazione rispetto al mercato finale; nei percorsi a due gambe
  // NON rappresenta una previsione del rendimento dell'intero percorso in USDC.
  const direction=last.side==='buy'?'LONG':'ROTAZIONE';const bullish=fast>slow&&slow>prev&&rv>=50&&rv<=75&&momentum>0;const dip=rv>=32&&rv<=47&&fast>slow&&c.at(-1)>c.at(-4)&&momentum<0&&momentum>-9;const trend=bullish||dip;const strategy=bullish?'RIALZO':dip?'RIMBALZO DA RIBASSO':'NESSUN SEGNALE';
  const metrics=routeMetrics(route,amount);const targetPct=Math.max(1.5,Math.min(8,3*atr));const stopPct=Math.max(1,Math.min(5,2*atr));
  const gain=metrics.back*(1+targetPct/100)-amount,loss=metrics.back*(1-stopPct/100)-amount,ratio=loss<0?gain/-loss:0;
  const spreadMax=Math.max(...route.map(e=>e.market.spread));
  const eligible=trend&&metrics.ok&&gain>0&&loss<0&&ratio>=1.3&&spreadMax<=0.6&&route.length===1&&last.side==='buy'&&amount>=5; // I percorsi a due gambe restano osservazioni: target su una sola coppia non basta.
  return {name:route.at(-1).to,path:route.map(e=>e.market.name+' '+(e.side==='buy'?'acquista':'vendi')).join(' → '),route,direction,strategy,eligible,trend,amount,gain,loss,ratio,rv,atr,momentum,targetPct,stopPct,costPct:metrics.costPct,spreadMax,score:(trend?50:0)+Math.min(20,Math.max(0,momentum*4))+Math.max(0,20-metrics.costPct*5)+Math.min(10,ratio*3),why:route.length>1?'Rotazione: eseguire separatamente dopo verifica':!metrics.ok?'Importo inferiore ai minimi Kraken':!trend?'Trend non confermato':spreadMax>.6?'Spread superiore allo 0,6%':gain<=0?'Target inferiore ai costi':loss>=0||ratio<1.3?'Rapporto rischio/rendimento insufficiente':!eligible?'Non idoneo':'Candidato idoneo'};
 }
 function render(){const fresh=balance!==null&&Date.now()-balanceAt<300000;const top=results.slice().sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.gain-a.gain||b.score-a.score).slice(0,5);
  $('opportunities').innerHTML=top.map(x=>`<tr><td>${esc(x.name)}<small style="display:block">${x.route.length} scambio/i</small></td><td>${x.direction} <small style="display:block">${esc(x.strategy||'')}</small></td><td class="${x.eligible?'up':''}">${esc(x.why)}</td><td class="${x.gain>=0?'up':'down'}">${x.route.length>1?'n.d.':fmt(x.gain,3)+' USDC'}</td><td>${fmt(x.costPct,2)}%</td></tr>`).join('')||'<tr><td colspan="5">Nessun percorso analizzato.</td></tr>';
   const sell=heldSignals.find(x=>{const m=x.route[0].market;const held=Number(holdings[m.base]||0);return held*m.bid>=Math.max(2,m.costmin,m.ordermin*m.bid)});
   const safePortfolio=portfolioAt>0&&Date.now()-portfolioAt<300000&&openCount===0;
   if(sell&&safePortfolio&&fresh){const m=sell.route[0].market;const held=Number(holdings[m.base]);const budget=Math.min(9.5,settings.maxTrade,held*m.bid*0.98);
    if(budget>=Math.max(2,m.costmin,m.ordermin*m.bid)){
      window.krakenSelectedOrder={pair:m.name.replace('/',''),side:'sell',budgetUSDC:String(budget)};
      $('prepareOrder').disabled=false;$('decisionStatus').textContent='VENDITA DA VALUTARE';
      $('decision').textContent=`Il bot propone di VENDERE parte di ${sell.name} già posseduto. Momentum 24h: ${fmt(sell.momentum,2)}%, RSI: ${fmt(sell.rv,1)}. Controvalore massimo: ${fmt(budget,2)} USDC. È un segnale di rischio, non un profitto garantito. Ordine spot LIMIT da validare e confermare manualmente.`;
      return;
    }
   }
  const best=results.filter(x=>x.eligible && x.route.length===1 && x.route[0].side==='buy' && x.route[0].market.quote==='USDC').sort((a,b)=>b.gain-a.gain||b.score-a.score)[0]; selectedLive=best||null; window.krakenSelectedOrder=best?{pair:best.route[0].market.name.replace('/',''),side:'buy',budgetUSDC:String(Math.min(9.5,settings.maxTrade,balance||0))}:null; const orderBtn=$('prepareOrder');if(orderBtn)orderBtn.disabled=!best||!fresh||!safePortfolio;
  if(!fresh){window.krakenSelectedOrder=null;if($('prepareOrder'))$('prepareOrder').disabled=true;$('decisionStatus').textContent='SALDO DA VERIFICARE';$('decision').textContent='Accedi e aggiorna il saldo reale. Le analisi pubbliche sono disponibili, ma non formuliamo importi con saldo non recente.';return}
  if(!best){window.krakenSelectedOrder=null;if($('prepareOrder'))$('prepareOrder').disabled=true;$('decisionStatus').textContent='ATTENDI';$('decision').textContent='Nessun acquisto approvato. '+(diagnostics?.summary||'Diagnostica non ancora disponibile.')+' Conservare USDC è una scelta valida; nessun ordine viene inviato.';return}
  if(!safePortfolio){window.krakenSelectedOrder=null;$('prepareOrder').disabled=true;$('decisionStatus').textContent='PORTAFOGLIO DA VERIFICARE';$('decision').textContent='È disponibile un segnale, ma il portafoglio o gli ordini aperti non sono stati verificati recentemente. Premi Controlla ordini Kraken.';return}
   $('decisionStatus').textContent='ACQUISTO DA VALUTARE';$('decision').textContent=`Strategia: ${best.strategy}\nDestinazione: ${best.name}\nPercorso: USDC → ${best.route.map(e=>e.to).join(' → ')}\nGambe: ${best.path}\nImporto di riferimento: ${fmt(best.amount,2)} USDC (saldo totale; disponibilità effettiva da verificare)\nCosto stimato di andata e ritorno: ${fmt(best.costPct,2)}%\nTarget teorico sul mercato finale: +${fmt(best.targetPct,2)}% · Stop teorico: −${fmt(best.stopPct,2)}%\nRisultato teorico al target: ${fmt(best.gain,3)} USDC · allo stop: ${fmt(best.loss,3)} USDC\nRSI: ${fmt(best.rv,1)} · Momentum 24h: ${fmt(best.momentum,2)}%\nATTENZIONE: il target riguarda l'ultima coppia e NON garantisce il risultato in USDC di un percorso multi-gamba. Prezzi, liquidità e minimi devono essere ricontrollati prima di qualunque scambio. Nessun ordine viene inviato.`;
 }
 async function scan(){if(scanning)return;scanning=true;results=[];diagnostics=null;selectedLive=null;window.krakenSelectedOrder=null;$('prepareOrder').disabled=true;$('scanNow').disabled=true;setStatus('Analisi di tutte le coppie spot…');try{
  const all=markets(await api('AssetPairs'));$('marketCount').textContent=String(all.length);
  // Ticker senza parametro pair: snapshot di tutti i mercati. Nessuna richiesta OHLC per migliaia di coppie.
  const tickers=await api('Ticker');const {graph,market}=graphFrom(all,tickers);const paths=routes(graph);const amount=balance!==null?Math.min(MAX_TRADE,settings.maxTrade,balance):Math.min(MAX_TRADE,settings.maxTrade);
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
   addCandidates(byCost,48);
   // Le rotazioni sono monitorate soltanto come contesto, non abilitate al trading.
   addCandidates([...other].sort((a,b)=>a.metrics.costPct-b.metrics.costPct),MAX_OHLC);
  $('coverage').textContent=`${market.length} ticker validi · ${paths.length} percorsi ≤2 scambi · ${selected.length} OHLC`;
  const found=[];let ok=0,errors=0;for(let i=0;i<selected.length;i+=CONCURRENCY){await Promise.all(selected.slice(i,i+CONCURRENCY).map(async x=>{try{const raw=await api('OHLC',{pair:x.path.at(-1).market.id,interval:60});const item=analyze(raw,x.path,amount);if(item){found.push(item);ok++}else errors++}catch(e){errors++;console.warn('OHLC',x.path.at(-1).market.name,e.message)}}));}
  results=found;
  heldSignals=found.filter(x=>x.route.length===1&&x.route[0].side==='buy'&&x.route[0].market.quote==='USDC'&&Number(holdings[x.route[0].market.base]||0)>0)
   .filter(x=>x.momentum< -1.5&&x.rv<46&&x.route[0].market.spread<=0.6)
   .sort((a,b)=>a.momentum-b.momentum);

   // Diagnostica esaustiva del campione: categorie mutuamente esclusive per ogni mercato diretto.
   // Non confondere una mancanza di segnale con un problema di fondi o di eseguibilità.
   const directFound=found.filter(x=>x.route.length===1&&x.route[0].side==='buy'&&x.route[0].market.quote==='USDC');
   const rejected={segnale:0,minimi:0,spread:0,costi:0,rischio:0,idonei:0};
   for(const x of directFound){
    if(!x.trend)rejected.segnale++;
    else if(!routeMetrics(x.route,x.amount).ok)rejected.minimi++;
    else if(x.spreadMax>0.6)rejected.spread++;
    else if(x.gain<=0)rejected.costi++;
    else if(x.loss>=0||x.ratio<1.3)rejected.rischio++;
    else if(x.eligible)rejected.idonei++;
    else rejected.minimi++;
   }
   const candidates=[...directFound].sort((a,b)=>Number(b.trend)-Number(a.trend)||b.score-a.score);
   const bestRejected=candidates.find(x=>!x.eligible);
   const missedOHLC=selected.length-found.length;
   const operational=[];
   if(balance===null||Date.now()-balanceAt>=300000)operational.push('saldo USDC non aggiornato');
   if(portfolioAt===0||Date.now()-portfolioAt>=300000)operational.push('portafoglio non aggiornato');
   if(openCount===null)operational.push('numero ordini aperti sconosciuto');
   else if(openCount>0)operational.push(openCount+' ordini aperti');
   const summary=rejected.idonei?'Segnali idonei: '+rejected.idonei+'.'+(operational.length?' Operatività bloccata: '+operational.join(', ')+'.':''):
    'Su '+directFound.length+' mercati USDC diretti esaminati: '+rejected.segnale+' senza segnale tecnico, '+rejected.minimi+' sotto i minimi, '+rejected.spread+' esclusi per spread, '+rejected.costi+' con target non sufficiente ai costi, '+rejected.rischio+' con rischio/rendimento insufficiente.'+
    (bestRejected?' Miglior candidato escluso: '+bestRejected.name+' ('+bestRejected.why+', momentum '+fmt(bestRejected.momentum,2)+'%, costo stimato A/R '+fmt(bestRejected.costPct,2)+'%).':'')+
    (operational.length?' Controlli operativi da completare: '+operational.join(', ')+'.':'');
   diagnostics={summary,rejected,operational};
   lastStats=`DIAGNOSTICA v3.7.1 — ${summary}\n\nCopertura: ${all.length} coppie spot, ${market.length} ticker validi, ${paths.length} percorsi da USDC; ${eligiblePaths.length} percorsi praticabili al controllo preliminare.\nAnalisi OHLC: ${found.length} risultati validi su ${selected.length} richieste (mancanti/non validi: ${missedOHLC}; errori API: ${errors}).\nMercati diretti USDC analizzati: ${directFound.length}; percorsi indiretti solo informativi: ${found.length-directFound.length}.\nLimite: ${MAX_OHLC} OHLC per scansione ogni 5 minuti; non rappresenta l'intero mercato.\nImpostazioni: commissione stimata ${fmt(settings.fee,2)}% per lato, slippage ${fmt(settings.slippage,2)}% per lato; non sono necessariamente le commissioni reali del tuo account.\nPosizioni con segnale di vendita: ${heldSignals.length}.\nUn segnale non dimostra un profitto futuro. Nessun ordine automatico.`;
  $('scanDetails').textContent=lastStats;$('scanTime').textContent='Ultima analisi: '+new Date().toLocaleTimeString('it-IT');setStatus('Analisi completata');render();
 }catch(e){setStatus('Errore analisi');$('scanDetails').textContent='Errore API pubblica Kraken: '+e.message;console.error(e)}finally{scanning=false;$('scanNow').disabled=false}}
 $('scanNow').onclick=()=>void scan();showBalance();render();void scan();setInterval(()=>void scan(),SCAN_MS);setInterval(()=>{if(balance!==null&&Date.now()-balanceAt>240000)void readBalance();else render()},60000);
})();
