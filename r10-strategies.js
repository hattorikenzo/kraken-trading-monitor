'use strict';
// Informational strategy evaluator. Closed candles only; no execution.
function evaluate(c, hourly, spread, turnover) {
 if (!Array.isArray(c)||!Array.isArray(hourly)||c.length<25||hourly.length<24||!Number.isFinite(spread)||spread<0||!Number.isFinite(turnover)||turnover<100000||spread>0.35) return [];
 if (![...c,...hourly].every(x=>[x.c,x.h,x.l,x.v].every(Number.isFinite)&&x.c>0&&x.l>0&&x.h>=x.c&&x.l<=x.c&&x.v>=0)) return [];
 const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
 const last=c.at(-1), prev=c.at(-2), hist=c.slice(-21,-1);
 const hi=Math.max(...hist.map(x=>x.h)),lo=Math.min(...hist.map(x=>x.l));
 const vol=avg(hist.map(x=>x.v));const ratio=vol>0?last.v/vol:0;
 const trend=hourly.at(-1).c>avg(hourly.slice(-24).map(x=>x.c));
 const move=last.c/c.at(-4).c-1;
 const cost=0.016+0.003+spread/100;
 const candidates=[
 ['breakout',last.c>hi&&ratio>=3&&trend, last.c*1.04,hi],
 ['momentum',trend&&move>0.005&&move<0.03&&ratio>=2,last.c*1.04,prev.l],
 ['recovery',prev.c<avg(hist.map(x=>x.c))&&last.c>prev.h&&ratio>=2&&trend,hi,Math.min(prev.l,last.l)],
 ['range',hi>lo&&last.c>prev.c&&last.c<=lo+(hi-lo)*0.25&&ratio>=1,hi,lo]
 ];
 return candidates.map(([strategy,signal,target,stop])=>{
 const reward=target/last.c-1-cost,risk=1-stop/last.c+cost;
 return {strategy,signal:Boolean(signal&&stop<last.c&&reward>0&&risk>0&&reward/risk>=1.25),reward,risk,ratio,cost};
 });
}
if(typeof module!=='undefined')module.exports={evaluate};
if(typeof window!=='undefined')window.krakenR10Strategies={evaluate};
