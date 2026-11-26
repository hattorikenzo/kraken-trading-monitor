'use strict';
/* Radar Accelerazioni v4 — public market scanner, private balances read-only.
   No order payloads, no automated execution. */
(()=>{
 const $=id=>document.getElementById(id);
 const API='https://api.kraken.com/0/public/';
 const aliases={ZUSD:'USD',ZEUR:'EUR',XXBT:'BTC',XBT:'BTC',XETH:'ETH',XXRP:'XRP',XXDG:'DOGE',ZGBP:'GBP'};
 const norm=s=>aliases[s]||s;
 const fiat=new Set(['USD','EUR','GBP','USDC','USDT','CAD','CHF','AUD','JPY']);
 const fmt=(n,d=2)=>Number.isFinite(n)?n.toLocaleString('it-IT',{maximumFractionDigits:d,minimumFractionDigits:d}):'—';
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let balances=null,balancesAt=0,portfolio={},scanning=false,lastScan=null,rows=[],watchlist=[],watchBusy=false,watchAt=0,scanRotation=0,ohlcNextAt=0;
 const set=(id,s)=>{if($(id))$(id).textContent=s};
 const now=()=>Date.now();
 async function api(path,params={}){
  const u=new URL(API+path);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),16000);
  try{const r=await fetch(u,{signal:ctrl.signal,cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();if(j.error?.length)throw Error(j.error.join(', '));return j.result||{}}
  finally{clearTimeout(timer)}
 }
 function showBalances(){
  const vals=balances?Object.entries(balances).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]):[];
  const primary=balances?['EUR',balances.EUR||0]:null;
  set('realBalance',vals.length?vals.map(([k,v])=>fmt(v,8)+' '+k).join(' · '):balances?'Nessun saldo positivo':'—');
  set('simpleBalance',primary?fmt(primary[1],8)+' '+primary[0]:'Da leggere');
  set('balanceTime',balancesAt?new Date(balancesAt).toLocaleString('it-IT'):'Non ancora letto');
  const cash=primary&&['USD','USDC','EUR'].includes(primary[0])?primary:null;
  set('budgetValue',cash?fmt(Math.max(0,Math.min(10,cash[1]-5)))+' '+cash[0]:'Non disponibile');
 }
 window.addEventListener('kraken-balance',e=>{
  const raw=e.detail?.balances;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
  const out={};
  for(const [k,v] of Object.entries(raw)){const n=Number(v);if(Number.isFinite(n)&&n>=0)out[norm(k)]=(out[norm(k)]||0)+n}
  balances=out;balancesAt=now();showBalances();
 });
 window.addEventListener('kraken-portfolio',e=>{portfolio=e.detail?.holdings||{};});
 window.addEventListener('kraken-auth-logout',()=>{balances=null;balancesAt=0;portfolio={};showBalances();});
 async function refresh(){try{await window.krakenReadBalance?.()}catch(e){set('balanceTime','Saldo non verificato: '+e.message)}}
 $('refreshBalance')?.addEventListener('click',refresh);
 window.addEventListener('kraken-auth-ready',refresh);
 const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
 function rsi(v){if(v.length<16)return 50;let up=0,dn=0;for(let i=v.length-14;i<v.length;i++){const d=v[i]-v[i-1];up+=Math.max(d,0);dn+=Math.max(-d,0)}return dn===0?(up?100:50):100-100/(1+up/dn)}
 function candles(data,interval){
  const key=Object.keys(data).find(k=>k!=='last');const list=data[key];if(!Array.isArray(list))return [];
  const t=now()/1000;
  return list.filter(x=>Number(x[0])+interval*60<=t).map(x=>({t:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[6]})).filter(x=>x.c>0&&x.v>=0).sort((a,b)=>a.t-b.t);
 }
 async function pacedOhlc(pair,interval){
  const wait=Math.max(0,ohlcNextAt-now());ohlcNextAt=Math.max(now(),ohlcNextAt)+1100;
  if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
  return api('OHLC',{pair,interval});
 }
 async function momentum(m){
  const [r5,r60]=await Promise.all([pacedOhlc(m.id,5),pacedOhlc(m.id,60)]);
  const c5=candles(r5,5),c60=candles(r60,60);
  if(c5.length<45||c60.length<26||now()/1000-c5.at(-1).t>900||now()/1000-c60.at(-1).t>10800)return null;
  const closes=c5.map(x=>x.c),hour=c60.map(x=>x.c);
  const last=c5.at(-1),prev=c5.slice(-25,-1),baseline=prev.slice(-20).map(x=>x.v);
  const volumeRatio=avg(baseline)>0?last.v/avg(baseline):0;
  const resistance=Math.max(...prev.map(x=>x.h));
  const breakout=last.c>resistance&&last.c>last.o;
  const trend=hour.at(-1)>avg(hour.slice(-24))&&avg(hour.slice(-8))>avg(hour.slice(-24));
  const rs=rsi(closes),rsiOk=rs>=50&&rs<=75&&rs>rsi(closes.slice(0,-3));
  const volOk=volumeRatio>=3;
  const spreadOk=m.spread<=0.35&&m.turnover>=100000;
  const score=[volOk,breakout,trend,rsiOk,spreadOk].filter(Boolean).length;
  const move=100*(last.c/closes.at(-4)-1);
  const missing=[!volOk?'volume':null,!breakout?'breakout':null,!trend?'trend 1h':null,!rsiOk?'RSI':null,!spreadOk?'spread/liquidità':null].filter(Boolean);
  // 5/5 is a technical score, not a buy recommendation. Avoid chasing
  // a move when volume is weak or RSI is near the upper limit.
  const volumeConfirmed=volumeRatio>=3;
  const notExtended=rs<70&&move>0&&move<3;
  const eligible=score===5&&volumeConfirmed&&notExtended;
  const verdict=eligible?'DA VALUTARE':score>=4?'OSSERVA':'ATTENDI';
  const reason=missing.length?'Manca: '+missing.join(', '):!notExtended?'Movimento esteso o RSI elevato':'Segnali tecnici presenti';
  return {...m,score,volumeRatio,breakout,trend,rsi:rs,spreadOk,move,eligible,verdict,reason};
 }
 async function scan(){
  if(scanning)return;scanning=true;set('decisionStatus','ANALISI');set('decision','Radar in esecuzione: verifica volumi, rotture, RSI, trend e spread. Nessun ordine viene inviato.');
  $('scanNow').disabled=true;set('scanTime','Analisi in corso');
  try{
   const [pairs,tickers]=await Promise.all([api('AssetPairs'),api('Ticker')]);
   const candidates=[];let universe=0,excluded=0;
   for(const [id,p] of Object.entries(pairs)){
    if(p.status!=='online'||!p.wsname||!p.wsname.includes('/')||p.wsname.includes('.d'))continue;
    const [base,quote]=p.wsname.split('/');if(quote!=='EUR')continue;
    universe++;const t=tickers[id]||tickers[p.altname];if(!t){excluded++;continue;}
    const bid=+t.b?.[0],ask=+t.a?.[0],last=+t.c?.[0],v=+t.v?.[1];
    if(!(bid>0&&ask>=bid&&last>0&&v>0)){excluded++;continue;}
    const spread=100*(ask-bid)/((ask+bid)/2),turnover=v*last;
    
    candidates.push({id,name:p.wsname,base,quote,spread,turnover,change:+t.o>0?100*(last/+t.o-1):0});
   }
   candidates.sort((a,b)=>b.turnover-a.turnover);
   // Broad rotating coverage: always inspect 20 liquid leaders, plus 28 from
   // the remaining eligible markets, rotating each scan. OHLC is paced globally
   // at ~1 request/second to respect Kraken's public REST guidance.
   const core=[],tail=candidates,rotating=[];
   if(tail.length){
    const start=(scanRotation*48)%tail.length;
    for(let i=0;i<Math.min(48,tail.length);i++)rotating.push(tail[(start+i)%tail.length]);
   }
   scanRotation++;
   const selected=[...core,...rotating],out=[],failed=[];
   set('scanTime','0/'+selected.length+' mercati');
   set('coverage','Scansione avviata: 0/'+selected.length+' mercati. Il primo giro può richiedere circa 2 minuti; non chiudere la pagina.');
   set('watchRadar','Scansione iniziale in corso: '+selected.length+' mercati selezionati. Attendere il completamento.');
   for(let i=0;i<selected.length;i+=3){
    const batch=await Promise.allSettled(selected.slice(i,i+3).map(momentum));
    for(let j=0;j<batch.length;j++){
     const r=batch[j];
     if(r.status==='fulfilled'&&r.value)out.push(r.value);
     else failed.push(selected[i+j].name);
    }
    const done=Math.min(i+3,selected.length);
    set('scanTime',done+'/'+selected.length+' mercati');
    set('coverage','Scansione in corso: '+done+'/'+selected.length+' mercati controllati, '+out.length+' con dati validi, '+failed.length+' senza dati validi.');
    if(out.length){
     const preview=out.slice().sort((a,b)=>b.score-a.score||b.volumeRatio-a.volumeRatio).slice(0,10);
     const body=$('opportunities');
     if(body)body.innerHTML=preview.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+x.score+'/5</td><td>Volume ×'+fmt(x.volumeRatio,1)+' · RSI '+fmt(x.rsi,0)+'<br><small>'+esc(x.reason)+'</small></td><td>'+fmt(x.move,2)+'% (15 min)</td><td>'+x.verdict+'</td></tr>').join('');
    }
   }
   rows=out.sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score||b.volumeRatio-a.volumeRatio);watchlist=rows.slice(0,5).map(x=>({id:x.id,name:x.name,base:x.base,quote:x.quote}));
   lastScan=now();
   const best=rows.find(x=>x.eligible);
   const display=rows.slice(0,10);
   const tbody=$('opportunities');
   if(tbody)tbody.innerHTML=display.length?display.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+x.score+'/5</td><td>Volume ×'+fmt(x.volumeRatio,1)+' · RSI '+fmt(x.rsi,0)+'<br><small>'+esc(x.reason)+'</small></td><td>'+fmt(x.move,2)+'% (15 min)</td><td>'+x.verdict+'</td></tr>').join(''):'<tr><td colspan="5">Nessun dato tecnico recente disponibile.</td></tr>';
   set('marketCount',String(universe));
   set('coverage','Analizzati '+out.length+'/'+selected.length+' mercati selezionati (fino a 48 a rotazione equa); '+candidates.length+' mercati con ticker valido su '+universe+' EUR; esclusi per dati mancanti: '+excluded+'. Dati OHLC mancanti/non validi: '+failed.length+'. Copertura completa solo dopo più scansioni.');
   set('scanTime',new Date(lastScan).toLocaleTimeString('it-IT'));
   set('scanDetails','Punteggio: volume ≥3× media 20 candele, breakout confermato, trend 1h, RSI 50–75 in salita, spread ≤0,35%. Solo candele chiuse. Rotazione: '+selected.length+' mercati variabili per scansione; chiamate OHLC distanziate di 1,1 s. Non è una scansione esaustiva istantanea.');
   set('decisionStatus',best?'DA VALUTARE':'ATTENDI');
   set('decision',best?'Possibile accelerazione '+best.name+' ('+best.score+'/5), volume ×'+fmt(best.volumeRatio,1)+', RSI '+fmt(best.rsi,0)+'. DA VALUTARE, non acquistare senza verificare commissioni, minimo ordine e saldo.':rows[0]?'Miglior candidato '+rows[0].name+' '+rows[0].score+'/5: '+rows[0].reason+'. '+(rows[0].score>=4?'OSSERVA, non acquistare senza conferma di volume e rischio.':'ATTENDI: condizioni insufficienti.'):'Nessun segnale recente verificabile. ATTENDI.');
   set('simpleCryptoMarket',display.slice(0,3).map(x=>x.name+' '+x.score+'/5').join(' · ')||'Nessun candidato');
   set('analysisText','RADAR ACCELERAZIONI — '+new Date(lastScan).toLocaleString('it-IT')+'\nCopertura: '+out.length+'/'+selected.length+' analizzati, '+candidates.length+' mercati preliminari, '+failed.length+' senza OHLC valido. Rotazione #'+scanRotation+'\n'+rows.slice(0,10).map(x=>x.name+' | '+x.score+'/5 | volume x'+fmt(x.volumeRatio,1)+' | RSI '+fmt(x.rsi,1)+' | '+(x.verdict+' | '+x.reason)).join('\n'));
  }catch(e){set('decisionStatus','ERRORE');set('decision','Scansione non verificata: '+e.message);set('scanTime','Errore');set('coverage','Errore scanner: '+e.message);set('watchRadar','Errore scanner: '+e.message);}
  finally{scanning=false;$('scanNow').disabled=false}
 }
 // Watchlist: lightweight public Ticker + Depth checks every 30s. Not an execution signal.
 async function watch(){
  if(watchBusy||scanning||!watchlist.length||document.hidden)return;
  watchBusy=true;
  try{
   const tick=await api('Ticker',{pair:watchlist.map(x=>x.id).join(',')});
   const updates=[];
   for(const m of watchlist){
    const t=tick[m.id]||tick[m.name.replace('/','')];if(!t)continue;
    const bid=Number(t.b?.[0]),ask=Number(t.a?.[0]);
    if(!(bid>0&&ask>=bid))continue;
    const spread=100*(ask-bid)/((ask+bid)/2);
    updates.push({name:m.name,spread,price:Number(t.c?.[0])});
   }
   // Depth requests are deliberately limited to the first two candidates to reduce API usage.
   for(const m of watchlist.slice(0,2)){
    try{
     const d=await api('Depth',{pair:m.id,count:10});
     const book=Object.values(d)[0],u=updates.find(x=>x.name===m.name);
     if(!book||!u)continue;
     const sum=side=>(book[side]||[]).reduce((n,x)=>n+Number(x[0])*Number(x[1]),0);
     const buys=sum('bids'),sells=sum('asks');
     u.pressure=sells>0?buys/sells:null;
    }catch{}
   }
   watchAt=now();
   const host=$('watchRadar');if(host){
    host.textContent='Controllo rapido '+new Date(watchAt).toLocaleTimeString('it-IT')+' · '+updates.map(x=>x.name+': spread '+fmt(x.spread,2)+'%'+(x.pressure!==undefined&&x.pressure!==null?' · book acquisti/vendite ×'+fmt(x.pressure,2):'')).join(' | ')+' · Dati istantanei, non segnali di acquisto.';
   }
  }catch(e){set('watchRadar','Controllo rapido non disponibile: '+e.message)}
  finally{watchBusy=false}
 }
 $('scanNow')?.addEventListener('click',scan);
 $('prepareOrder')?.setAttribute('disabled','');
 window.krakenSelectedOrder=null;
 // No actionable order is generated by this scanner. LIVE backend remains separately locked.
 set('status','Release 10 EARLY ACCESS · EUR · sola analisi');
 showBalances();
 setTimeout(()=>scan(),1200);
 setInterval(()=>{if(!document.hidden)scan()},300000);setInterval(watch,30000);
})();