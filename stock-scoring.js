'use strict';
/* Informational stock screening of user-provided observations. NO order placement. */
(function(root){
 const symbolOk=s=>/^[A-Z0-9._-]{1,20}:[A-Z0-9._-]{1,25}$/.test(String(s||'').toUpperCase());
 function scoreStock(input){
  const symbol=String(input.symbol||'').trim().toUpperCase();
  const price=Number(input.price),change=Number(input.changePct),drawdown=Number(input.drawdownPct),rsi=Number(input.rsi),volume=Number(input.volumeRatio),spread=Number(input.spreadPct),cost=Number(input.costPct);
  if(!symbolOk(symbol))throw Error('Simbolo BORSA:TICKER non valido');
  if(![price,change,drawdown,rsi,volume,spread,cost].every(Number.isFinite)||price<=0||change< -100||change>100||drawdown<0||drawdown>100||rsi<0||rsi>100||volume<0||volume>100||spread<0||spread>100||cost<0||cost>100)throw Error('Dati numerici mancanti o fuori intervallo');
  let score=50;const why=[];
  if(drawdown>=5&&drawdown<=20){score+=12;why.push('Ribasso dai massimi 5–20%');}
  else if(drawdown>35){score-=18;why.push('Ribasso molto profondo: rischio strutturale');}
  if(rsi>=35&&rsi<=55){score+=12;why.push('RSI in fascia di possibile recupero');}
  else if(rsi<25){score-=12;why.push('RSI estremamente debole');}
  else if(rsi>75){score-=14;why.push('RSI elevato');}
  if(change>0&&change<=4){score+=10;why.push('Variazione giornaliera positiva moderata');}
  else if(change<=-5){score-=12;why.push('Ribasso giornaliero pronunciato');}
  if(volume>=1.2&&change>0){score+=8;why.push('Volumi superiori alla media con rialzo');}
  if(spread+cost>=2){score-=15;why.push('Costi e spread elevati');}
  else if(spread+cost>=0.7){score-=7;why.push('Costi e spread da verificare');}
  score=Math.max(0,Math.min(100,score));
  // Conservative: screening score is never a buy recommendation or probability.
  const signal=score>=70&&change>=0&&rsi>=35&&rsi<=65&&spread+cost<0.7?'CANDIDATO DA APPROFONDIRE':score<40?'RISCHIO ELEVATO':'ATTENDI / VERIFICA';
  return {symbol,score,signal,why,price,changePct:change,drawdownPct:drawdown,spreadPct:spread,costPct:cost};
 }
 function parseCsv(text){
  const lines=String(text||'').trim().split(/\r?\n/).filter(Boolean);
  if(lines.length<2)throw Error('Servono intestazione e almeno una riga');
  if(lines.length>501)throw Error('Massimo 500 righe per valutazione');
  const keys=lines[0].split(';').map(s=>s.trim());
  const expected=['symbol','price','changePct','drawdownPct','rsi','volumeRatio','spreadPct','costPct'];
  if(keys.join('|')!==expected.join('|'))throw Error('Intestazione CSV non valida: '+expected.join(';'));
  const rows=[],errors=[];
  lines.slice(1).forEach((line,i)=>{try{const v=line.split(';');if(v.length!==keys.length)throw Error('numero colonne');const item={};keys.forEach((k,j)=>item[k]=v[j].trim());rows.push(scoreStock(item));}catch(e){errors.push('Riga '+(i+2)+': '+e.message);}});
  return {rows:rows.sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol)),errors};
 }
 root.StockScreening={scoreStock,parseCsv};
})(typeof module!=='undefined'&&module.exports?module.exports:window);
