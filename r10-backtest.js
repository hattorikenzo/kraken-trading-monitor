'use strict';
// Historical simulation, independent virtual portfolios; no orders.
function simulate(candles,hourly,evaluate,{capital=35,cap=10,reserve=5}={}){
 const names=['breakout','momentum','recovery','range'];
 const books=Object.fromEntries(names.map(n=>[n,{cash:capital,position:null,trades:[],equity:capital}]));
 for(let i=25;i<candles.length;i++){
  const bar=candles[i],prior=candles.slice(0,i);
  const hours=hourly.filter(h=>h.t+3600<=bar.t);
  const signals=evaluate(prior,hours,0.35,bar.turnover??0);
  for(const name of names){
   const b=books[name],s=signals.find(x=>x.strategy===name);
   if(b.position){
    const p=b.position;
    if(bar.l<=p.stop||bar.h>=p.target){
     const exit=bar.l<=p.stop?Math.min(bar.o,p.stop):p.target;
     const proceeds=p.qty*exit*(1-p.cost/2);
     b.cash+=proceeds;b.trades.push({entry:p.entry,exit,pnl:proceeds-p.debit});b.position=null;
    }
   }else if(s?.signal&&Number.isFinite(bar.o)&&bar.o>0){
    const debit=Math.min(cap,Math.max(0,b.cash-reserve));
    if(debit>0&&debit>= (bar.minCost??Infinity)){
     const entry=bar.o,reference=prior.at(-1).c;
     if(Math.abs(entry/reference-1)>0.005)continue;
     b.position={entry,debit,qty:debit/(entry*(1+s.cost/2)),cost:s.cost,stop:reference*(1-s.risk+s.cost),target:reference*(1+s.reward+s.cost)};
     b.cash-=debit;
    }
   }
   b.equity=b.cash+(b.position?b.position.qty*bar.c*(1-b.position.cost/2):0);
  }
 }
 return books;
}
if(typeof module!=='undefined')module.exports={simulate};
