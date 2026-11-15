'use strict';
(function(root){
const mapping={'NASDAQ':'NASDAQ','NYSE':'NYSE','AMEX':'AMEX','MIL':'Borsa Italiana','LSE':'LSE','XETR':'XETR','EURONEXT':'EURONEXT'};
function validSymbols(text){const items=String(text||'').split(/[\s,;]+/).map(x=>x.trim().toUpperCase()).filter(Boolean);if(!items.length||items.length>8)throw Error('Indica da 1 a 8 simboli per scansione');if(items.some(x=>!/^[A-Z0-9._-]{1,20}:[A-Z0-9._-]{1,25}$/.test(x)))throw Error('Formato BORSA:SIMBOLO non valido');return [...new Set(items)];}
function rsi14(closes){if(closes.length<16)throw Error('Storico insufficiente per RSI');let gains=0,losses=0;for(let i=closes.length-14;i<closes.length;i++){const d=closes[i]-closes[i-1];gains+=Math.max(0,d);losses+=Math.max(0,-d);}return losses===0?(gains?100:50):100-100/(1+gains/losses);}
function fromSeries(symbol,data,costPct){
 if(data.status==='error'||data.code)throw Error(String(data.message||'Errore provider'));
 const values=data.values;if(!Array.isArray(values)||values.length<30)throw Error('Servono almeno 30 sedute');
 const rows=values.map(x=>({date:String(x.datetime),close:Number(x.close),volume:Number(x.volume)})).filter(x=>Number.isFinite(x.close)&&x.close>0&&/^\d{4}-\d{2}-\d{2}$/.test(x.date)).sort((a,b)=>a.date.localeCompare(b.date));
 if(rows.length<30)throw Error('Dati di chiusura insufficienti');
 const last=rows.at(-1),previous=rows.at(-2),recent=rows.slice(-100),max=Math.max(...recent.map(x=>x.close)),avgVol=rows.slice(-21,-1).map(x=>x.volume).filter(x=>Number.isFinite(x)&&x>0);
 if(!avgVol.length||!Number.isFinite(last.volume)||last.volume<=0)throw Error('Volumi non disponibili');
 const age=(Date.now()-Date.parse(last.date+'T23:59:59Z'))/86400000;
 if(!Number.isFinite(age)||age>7||age< -1)throw Error('Ultima seduta non recente: '+last.date);
 const closes=rows.map(x=>x.close),volAvg=avgVol.reduce((a,b)=>a+b,0)/avgVol.length;
 return {symbol,price:last.close,changePct:100*(last.close/previous.close-1),drawdownPct:100*(max-last.close)/max,rsi:rsi14(closes),volumeRatio:last.volume/volAvg,spreadPct:0,costPct,asOf:last.date,spreadMissing:true,drawdownWindow:recent.length};
}
async function fetchOne(symbol,key,costPct,signal){
 const [exchange,ticker]=symbol.split(':');
 const url=new URL('https://api.twelvedata.com/time_series');url.searchParams.set('symbol',ticker);url.searchParams.set('interval','1day');url.searchParams.set('outputsize','110');url.searchParams.set('apikey',key);if(mapping[exchange])url.searchParams.set('exchange',mapping[exchange]);
 const response=await fetch(url.toString(),{signal,cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);const data=await response.json();return fromSeries(symbol,data,costPct);
}
if(typeof module!=='undefined'&&module.exports){module.exports={validSymbols,fromSeries,fetchOne};}else{root.StockFeed={validSymbols,fromSeries,fetchOne};}
})(typeof module!=='undefined'&&module.exports?module.exports:window);
