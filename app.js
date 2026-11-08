'use strict';
// Kraken Opportunity Bot v3.2: solo API pubbliche Kraken + evento saldo da auth.js. ZERO ordini.
(()=>{
 const $=id=>document.getElementById(id), fmt=(x,n=4)=>Number.isFinite(x)?x.toLocaleString('it-IT',{maximumFractionDigits:n,minimumFractionDigits:n}):'—';
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const API='https://api.kraken.com/0/public/', SCAN_MS=300000, MAX_OHLC=120, CONCURRENCY=3;
 let balance=null,balanceAt=0,balanceValid=false,scanning=false,pairs=[],lastResults=[],settings={maxTrade:10,fee:.8,slippage:.15};
 try{const x=JSON.parse(localStorage.getItem('kraken_bot_v3_settings'));if(x)settings={...settings,...x}}catch{}
 for(const k of ['maxTrade','fee','slippage'])$(k).value=settings[k];
 function status(s){$('status').textContent=s}
 function getUsdc(b){ // Kraken può esporre USDC con suffissi: non sommare asset diversi arbitrariamente.
  const entries=Object.entries(b||{}).filter(([k,v])=>k==='USDC'&&/^\d+(?:\.\d+)?$/.test(String(v)));
  return entries.length?Number(entries[0][1]):null;
 }
 function showBalance(){const n=balanceValid?balance:null;$('realBalance').textContent=n===null?'—':fmt(n,6)+' USDC';$('balanceTime').textContent=balanceAt?new Date(balanceAt).toLocaleString('it-IT'):'Non ancora letto';$('budgetValue').textContent=n===null?'—':fmt(Math.min(settings.maxTrade,n),2)+' USDC';}
 window.addEventListener('kraken-balance',e=>{balance=getUsdc(e.detail?.balances);balanceAt=Date.parse(e.detail?.timestamp)||Date.now();balanceValid=balance!==null;showBalance();render();});
 window.addEventListener('kraken-auth-logout',()=>{balance=null;balanceValid=false;balanceAt=0;showBalance();render();});
 window.addEventListener('kraken-auth-ready',()=>{void readBalance()});
 async function readBalance(){if(typeof window.krakenReadBalance!=='function')return;const btn=$('refreshBalance');btn.disabled=true;try{await window.krakenReadBalance()}catch(e){balanceValid=false;balance=null;showBalance();$('decision').textContent='Saldo non verificato: '+e.message;console.warn(e)}finally{btn.disabled=false}}
 $('refreshBalance').onclick=readBalance;
 $('saveSettings').onclick=()=>{const maxTrade=Number($('maxTrade').value),fee=Number($('fee').value),slippage=Number($('slippage').value);if(!Number.isFinite(maxTrade)||maxTrade<1||maxTrade>1000||!Number.isFinite(fee)||fee<0||fee>5||!Number.isFinite(slippage)||slippage<0||slippage>5){alert('Impostazioni non valide');return}settings={maxTrade,fee,slippage};localStorage.setItem('kraken_bot_v3_settings',JSON.stringify(settings));showBalance();render();};
 async function api(path,params={}){const url=new URL(API+path);for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),14000);try{const r=await fetch(url,{cache:'no-store',signal:ctrl.signal});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();if(j.error?.length)throw Error(j.error.join(', '));return j.result||{}}finally{clearTimeout(timer)}}
 const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
 function rsi(values){if(values.length<16)return null;let g=0,l=0;for(let i=values.length-14;i<values.length;i++){const d=values[i]-values[i-1];g+=Math.max(0,d);l+=Math.max(0,-d)}return l===0?(g?100:50):100-100/(1+g/l)}
 function getPairs(raw){return Object.entries(raw).filter(([id,p])=>p?.status==='online'&&!p.wsname?.includes('.d')&&p.quote==='USDC'&&p.wsname?.includes('/')).map(([id,p])=>({id,name:p.wsname,minimum:Number(p.ordermin)||0,costmin:Number(p.costmin)||0,lotDecimals:Number(p.lot_decimals)||8})).filter(p=>p.name?.endsWith('/USDC'));}
 function tickerMap(raw,listed){return listed.map(p=>{const t=raw[p.id]||raw[Object.keys(raw).find(k=>k.toUpperCase()===p.id.toUpperCase())];if(!t)return null;const bid=Number(t.b?.[0]),ask=Number(t.a?.[0]),last=Number(t.c?.[0]),volume=Number(t.v?.[1]);if(!(bid>0&&ask>=bid&&last>0&&volume>0))return null;const spread=100*(ask-bid)/((ask+bid)/2);return {...p,bid,ask,last,spread,volume,notional:volume*last};}).filter(Boolean)}
 function analyze(p,raw,amount){const key=Object.keys(raw).find(k=>k!=='last'),data=raw[key];if(!Array.isArray(data))return [];
  const now=Date.now()/1000,rows=data.filter(c=>Number(c[0])+300<=now).map(c=>({t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4]})).filter(c=>[c.o,c.h,c.l,c.c].every(x=>Number.isFinite(x)&&x>0)).sort((a,b)=>a.t-b.t);
  if(rows.length<60||now-rows.at(-1).t>1200)return [];
  const closes=rows.map(x=>x.c),fast=avg(closes.slice(-8)),slow=avg(closes.slice(-21)),hour=avg(closes.slice(-12)),prior=avg(closes.slice(-24,-12)),rv=rsi(closes);
  let tr=0;for(let i=rows.length-14;i<rows.length;i++){const c=rows[i],prev=rows[i-1];tr+=Math.max(c.h-c.l,Math.abs(c.h-prev.c),Math.abs(c.l-prev.c))}
  const atrPct=100*(tr/14)/p.last,stopPct=Math.max(1,Math.min(4,1.8*atrPct)),takePct=Math.max(1.5,Math.min(10,3.2*atrPct));
  const long=fast>slow&&rv>=48&&rv<=68&&hour>prior&&closes.at(-1)>hour;
  const short=fast<slow&&rv>=32&&rv<=52&&hour<prior&&closes.at(-1)<hour;
  const fee=(settings.fee+settings.slippage)/100,spread=p.spread/100;
  // LONG: ask in ingresso, bid in uscita; fee/slippage per lato. SHORT solo scenario, NON eseguibile in spot.
  const make=(direction,signal)=>{const isLong=direction==='LONG',move=takePct/100,stop=stopPct/100;
   const gain=isLong?amount*((1-fee)*(1+move)*(1-spread)*(1-fee)-1):amount*(move-spread-2*fee);
   const loss=isLong?amount*((1-fee)*(1-stop)*(1-spread)*(1-fee)-1):-amount*(stop+spread+2*fee);
   const ratio=loss<0?gain/-loss:0;
   const eligible=signal&&gain>0&&loss<0&&ratio>=1.2&&p.spread<=.6&&amount>=Math.max(p.costmin,p.minimum*p.ask)&&amount>=5;
   return {...p,direction,signal,eligible,gain,loss,ratio,stopPct,takePct,atrPct,rsi:rv,amount,why:!signal?'Trend non confermato':p.spread>.6?'Spread elevato':amount<Math.max(p.costmin,p.minimum*p.ask)?'Ordine minimo non rispettato':!eligible?'Rendimento/rischio insufficiente':isLong?'LONG spot valutabile':'SHORT solo teorico'};
  };
  return [make('LONG',long),make('SHORT',short)];
 }
 function render(){const tbody=$('opportunities');const sorted=lastResults.slice().sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.ratio-a.ratio||b.gain-a.gain);const best=sorted.find(x=>x.eligible&&x.direction==='LONG');const bestShort=sorted.find(x=>x.eligible&&x.direction==='SHORT');
  tbody.innerHTML=sorted.filter(x=>x.signal).filter((x,i,a)=>a.findIndex(y=>y.id===x.id)===i).slice(0,5).map(x=>`<tr><td>${esc(x.name)}</td><td>${x.direction}</td><td class="${x.eligible?'up':''}">${x.eligible?(x.direction==='SHORT'?'SOLO TEORICO':'DA VALUTARE'):'ATTENDI'}</td><td class="${x.gain>0?'up':'down'}">${fmt(x.gain)} USDC</td><td class="down">${fmt(x.loss)} USDC</td><td>${fmt(x.ratio,2)}</td><td>${fmt(x.spread,2)}%</td></tr>`).join('')||'<tr><td colspan="7">Nessuna analisi valida disponibile.</td></tr>';
  const fresh=balanceValid&&Date.now()-balanceAt<5*60*1000;
  if(!fresh){$('decisionStatus').textContent='SALDO DA VERIFICARE';$('decision').textContent='Accedi e aggiorna il saldo reale Kraken. Senza saldo recente non vengono formulate proposte di importo.';return}
  if(!best){$('decisionStatus').textContent='ATTENDI';$('decision').textContent='Nessun LONG spot supera i filtri di rischio e costo. '+(bestShort?'Segnale ribassista migliore: '+bestShort.name+' (SHORT teorico, non eseguibile in spot).':'Nessun segnale SHORT sufficientemente favorevole.')+' Nessun investimento suggerito.';return}
  $('decisionStatus').textContent='DA VALUTARE';$('decision').textContent=`Mercato: ${best.name}\nDirezione: LONG (spot)\nImporto di riferimento: ${fmt(best.amount,2)} USDC (saldo totale, disponibilità effettiva da verificare)\nPrezzo ask indicativo: ${fmt(best.ask,8)} USDC\nStop teorico: −${fmt(best.stopPct,2)}% · Target teorico: +${fmt(best.takePct,2)}%\nProfitto netto al target: ${fmt(best.gain)} USDC\nPerdita teorica allo stop: ${fmt(best.loss)} USDC\nRapporto target/stop: ${fmt(best.ratio,2)}\nRSI: ${fmt(best.rsi,1)} · ATR: ${fmt(best.atrPct,2)}% · Spread: ${fmt(best.spread,2)}%\n${bestShort?'Miglior segnale ribassista: '+bestShort.name+' (SHORT teorico, non eseguibile in spot).\n':''}Nessun ordine verrà inviato. Verifica disponibilità, prezzo e commissioni direttamente su Kraken prima di agire.`;
 }
 async function scan(){if(scanning)return;scanning=true;$('scanNow').disabled=true;status('Analisi Kraken in corso…');try{
  const rawPairs=await api('AssetPairs');pairs=getPairs(rawPairs);$('marketCount').textContent=String(pairs.length);
  if(!pairs.length)throw Error('Nessuna coppia USDC online riconosciuta');
  const tickers={};for(let i=0;i<pairs.length;i+=45){try{Object.assign(tickers,await api('Ticker',{pair:pairs.slice(i,i+45).map(p=>p.id).join(',')}))}catch(e){console.warn('Ticker batch',i,e.message)}}const listed=tickerMap(tickers,pairs).filter(p=>p.spread<=1.5).sort((a,b)=>b.notional-a.notional);
  const selected=listed.slice(0,MAX_OHLC);const amount=balanceValid?Math.min(settings.maxTrade,10,balance):0;
  $('coverage').textContent=`${listed.length} con ticker e spread ≤1,5%; ${selected.length} analizzati su OHLC`;
  const results=[];let completed=0,failed=0;
  for(let i=0;i<selected.length;i+=CONCURRENCY){await Promise.all(selected.slice(i,i+CONCURRENCY).map(async p=>{try{const rows=await api('OHLC',{pair:p.id,interval:5});results.push(...analyze(p,rows,amount));completed++}catch(e){failed++;console.warn('OHLC',p.name,e.message)}}));}
  lastResults=results;$('scanTime').textContent='Ultima analisi: '+new Date().toLocaleTimeString('it-IT');$('scanDetails').textContent=`Mercati USDC trovati: ${pairs.length}. Con ticker valido: ${listed.length}. OHLC interrogati: ${completed}/${selected.length}; errori: ${failed}. Sono analizzati tutti i mercati con ticker valido entro il limite tecnico di ${MAX_OHLC}; le richieste fallite sono escluse. Aggiornamento ogni 5 minuti a pagina aperta.`;
  status('Analisi completata');render();
 }catch(e){status('Errore analisi');$('scanDetails').textContent='Kraken API: '+e.message;console.error(e)}finally{scanning=false;$('scanNow').disabled=false}}
 $('scanNow').onclick=()=>void scan();showBalance();render();void scan();setInterval(()=>void scan(),SCAN_MS);setInterval(()=>{if(balanceValid&&Date.now()-balanceAt>4*60*1000)void readBalance();else render()},60000);
})();
