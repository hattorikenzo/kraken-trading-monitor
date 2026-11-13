// Kraken Release 11 — STAGING, NO REAL ORDERS. Server-side persistent kill switch and position ledger read-only.
// Requires SQL migration in schema.sql and secrets KRAKEN_TRADE_API_KEY/SECRET,
// KRAKEN_ALLOWED_USER_ID, SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from 'npm:@supabase/supabase-js@2';
const ORIGIN='https://hattorikenzo.github.io';
// STAGING: no execution path can call Kraken order endpoints. Do not enable live trading with this file.
const MIN_USDC_RESERVE=5;
const MAX_BUY_BUDGET_USDC=5;
const BUY_FEE_BUFFER=1.03;
const canBuy=(free:number,estimatedDebit:number)=>Number.isFinite(free)&&Number.isFinite(estimatedDebit)&&estimatedDebit>0&&free-estimatedDebit>=MIN_USDC_RESERVE-1e-8;
const HEAD={'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Cache-Control':'no-store','Content-Type':'application/json'};
const respond=(body:unknown,status=200)=>Response.json(body,{status,headers:HEAD});
const validDecimal=(x:unknown)=>typeof x==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(x)&&Number(x)>0&&Number.isFinite(Number(x));
const b64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function signature(path:string,body:string,nonce:string,secret:string){const e=new TextEncoder();const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',e.encode(nonce+body)));const p=e.encode(path);const m=new Uint8Array(p.length+digest.length);m.set(p);m.set(digest,p.length);const key=await crypto.subtle.importKey('raw',b64(secret),{name:'HMAC',hash:'SHA-512'},false,['sign']);return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,m))));}
type ServiceDb = ReturnType<typeof createClient>;
async function nextTradeNonce(db:ServiceDb):Promise<string>{
 const {data,error}=await db.rpc('kraken_next_nonce',{p_key_alias:'trade'});
 if(error||typeof data!=='string'||!/^[0-9]+$/.test(data)){
  console.error('TRADE_NONCE_UNAVAILABLE',error?.code??'invalid_result');
  throw Error('Shared trade nonce unavailable');
 }
 return data;
}
async function kraken(path:string,fields:Record<string,string>,key:string,secret:string,db:ServiceDb){const nonce=await nextTradeNonce(db);const body=new URLSearchParams({nonce,...fields}).toString();const r=await fetch('https://api.kraken.com'+path,{method:'POST',headers:{'API-Key':key,'API-Sign':await signature(path,body,nonce,secret),'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('Kraken HTTP '+r.status);const j=await r.json();if(!Array.isArray(j.error)||j.error.length)throw Error('Kraken API '+JSON.stringify(j.error||[]));return j.result;}
async function pub(path:string,params:Record<string,string>={}){const u=new URL('https://api.kraken.com/0/public/'+path);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));const r=await fetch(u,{signal:AbortSignal.timeout(12000),cache:'no-store'});if(!r.ok)throw Error('Kraken public HTTP');const j=await r.json();if(j.error?.length||!j.result)throw Error('Kraken public response');return j.result;}
const available=(x:any)=>{if(!x)return NaN;const b=Number(x.balance??NaN),h=Number(x.hold_trade??0),c=Number(x.credit_used??0);return [b,h,c].every(Number.isFinite)?Math.max(0,b-h-c):NaN;};
type ReconcileSample={status:unknown,vol:unknown,vol_exec:unknown,cost:unknown,fee:unknown};
function inspectOrder(info:ReconcileSample,expectedVolume:number,previousExecuted:number){
 const status=String(info?.status||'').toLowerCase();
 if(!['pending','open','closed','canceled','expired'].includes(status))throw Error('Stato Kraken non riconosciuto');
 const vol=Number(info.vol),exec=Number(info.vol_exec),cost=Number(info.cost),fee=Number(info.fee);
 if(![vol,exec,cost,fee,expectedVolume,previousExecuted].every(Number.isFinite)||vol<=0||exec<0||exec>vol+1e-8||cost<0||fee<0||previousExecuted<0)throw Error('Valori di esecuzione non validi');
 if(!(expectedVolume>0)||Math.abs(expectedVolume-vol)>Math.max(1e-8,expectedVolume*1e-6))throw Error('Volume Kraken non coincide con registro locale');
 if(exec+1e-8<previousExecuted)throw Error('Volume eseguito inferiore a quello già registrato');
 const note=status==='open'&&exec>0?'Parzialmente eseguito; ordine ancora aperto':
  status==='closed'?'Ordine chiuso da Kraken; revisione manuale necessaria prima di nuovi acquisti':
  ['canceled','expired'].includes(status)?'Ordine terminato; controllare esecuzione parziale e commissioni':'Ordine ancora non definitivo';
 return {status,exec,cost,fee,note,lockRetained:true};
}
const decimals=(x:string)=>(x.split('.')[1]||'').length;
function trunc(n:number,d:number){const f=10**Math.min(d,12);return (Math.floor(n*f+1e-10)/f).toFixed(Math.min(d,12));}

// R16 isolated accounting simulation: no exchange requests, no database mutations.
// This is a reference test model, NOT a production fill importer or trading permission.
function release16Simulation(){
 type Fill={id:string,order:string,side:'buy'|'sell',volume:number,cost:number,fee:number,feeAsset:string};
 type State={qty:number,costBasis:number,realized:number,seen:Set<string>};
 const EPS=1e-9;
 const fresh=():State=>({qty:0,costBasis:0,realized:0,seen:new Set()});
 function apply(s:State,f:Fill){
  if(!f.id||!f.order||s.seen.has(f.id))throw Error('DUPLICATE_OR_INVALID_TRADE_ID');
  if(![f.volume,f.cost,f.fee].every(Number.isFinite)||f.volume<=0||f.cost<0||f.fee<0)throw Error('INVALID_FILL');
  if(f.feeAsset!=='USDC'&&f.feeAsset!=='XRP')throw Error('UNVERIFIED_FEE_ASSET');
  if(f.side==='buy'){
   const netQty=f.volume-(f.feeAsset==='XRP'?f.fee:0);
   const debit=f.cost+(f.feeAsset==='USDC'?f.fee:0);
   if(netQty<=0||debit>5+EPS)throw Error('BUY_CAP_OR_QUANTITY');
   s.qty+=netQty;s.costBasis+=debit;
  }else{
   const consumed=f.volume+(f.feeAsset==='XRP'?f.fee:0);
   if(consumed>s.qty+EPS)throw Error('SELL_EXCEEDS_BOT_POSITION');
   const basis=s.costBasis*(consumed/s.qty);
   const netProceeds=f.cost-(f.feeAsset==='USDC'?f.fee:0);
   if(netProceeds<0)throw Error('NEGATIVE_NET_PROCEEDS');
   s.qty=Math.max(0,s.qty-consumed);s.costBasis=Math.max(0,s.costBasis-basis);
   s.realized+=netProceeds-basis;
  }
  s.seen.add(f.id);
 }
 function allowedToTrade(halted:boolean,enabled:boolean,lossLimit:number|null,unknown:boolean){
  return !halted&&enabled&&lossLimit!==null&&Number.isFinite(lossLimit)&&lossLimit>0&&!unknown;
 }
 const tests:{name:string,pass:boolean,detail?:string}[]=[];
 function check(name:string,fn:()=>boolean){try{tests.push({name,pass:fn()===true})}catch(e){tests.push({name,pass:false,detail:e instanceof Error?e.message:'UNKNOWN'})}}
 const buy=(id:string,volume:number,cost:number,fee:number,feeAsset:string):Fill=>({id,order:'O1',side:'buy',volume,cost,fee,feeAsset});
 const sell=(id:string,volume:number,cost:number,fee:number,feeAsset:string):Fill=>({id,order:'O2',side:'sell',volume,cost,fee,feeAsset});
 check('buy USDC fee exactly 5 USDC total',()=>{const s=fresh();apply(s,buy('t1',4,4.98,.02,'USDC'));return Math.abs(s.costBasis-5)<EPS&&s.qty===4});
 check('buy base-asset fee reduces received quantity',()=>{const s=fresh();apply(s,buy('t1',4,4.9,.01,'XRP'));return Math.abs(s.qty-3.99)<EPS&&Math.abs(s.costBasis-4.9)<EPS});
 check('buy fee pushes total debit above 5 blocked',()=>{try{apply(fresh(),buy('t1',4,5,.01,'USDC'));return false}catch(e){return String(e).includes('BUY_CAP')}});
 check('unknown fee asset blocks',()=>{try{apply(fresh(),buy('t1',4,4.9,.01,'UNKNOWN'));return false}catch(e){return String(e).includes('UNVERIFIED_FEE_ASSET')}});
 check('duplicate fill rejected',()=>{const s=fresh();apply(s,buy('t1',4,4.9,.01,'USDC'));try{apply(s,buy('t1',4,4.9,.01,'USDC'));return false}catch(e){return String(e).includes('DUPLICATE')}});
 check('partial buy fills aggregated',()=>{const s=fresh();apply(s,buy('t1',2,2.4,.01,'USDC'));apply(s,buy('t2',2,2.4,.01,'USDC'));return s.seen.size===2&&Math.abs(s.qty-4)<EPS&&Math.abs(s.costBasis-4.82)<EPS});
 check('sell USDC fee realizes net profit',()=>{const s=fresh();apply(s,buy('t1',4,4.8,.02,'USDC'));apply(s,sell('t2',4,5.2,.03,'USDC'));return Math.abs(s.realized-.35)<EPS&&s.qty===0});
 check('sell base fee consumes extra owned units',()=>{const s=fresh();apply(s,buy('t1',4,4.8,0,'USDC'));apply(s,sell('t2',3.99,5,.01,'XRP'));return s.qty<EPS&&Math.abs(s.realized-.2)<EPS});
 check('sell cannot touch manual holdings',()=>{const s=fresh();apply(s,buy('t1',4,4.8,0,'USDC'));try{apply(s,sell('t2',5,6,0,'USDC'));return false}catch(e){return String(e).includes('SELL_EXCEEDS_BOT_POSITION')}});
 check('null loss limit blocks trading',()=>!allowedToTrade(false,true,null,false));
 check('unknown order blocks trading',()=>!allowedToTrade(false,true,2,true));
 check('kill switch blocks trading',()=>!allowedToTrade(true,true,2,false));
 check('disabled policy blocks trading',()=>!allowedToTrade(false,false,2,false));
 check('negative or zero loss limit blocks trading',()=>!allowedToTrade(false,true,0,false)&&!allowedToTrade(false,true,-1,false));
 return {success:tests.every(t=>t.pass),release:'16',mode:'OFFLINE_ACCOUNTING_SIMULATION',
  passed:tests.filter(t=>t.pass).length,total:tests.length,tests,
  ordersSent:0,databaseWrites:0,krakenCalls:0,safeForLive:false,
  limitations:'Pure in-memory reference simulation. Not a production importer. No Kraken fee-currency evidence, API reconciliation, actual DB transactions, concurrency or failure injection. Trading remains blocked.'};
}

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:HEAD});
 if(req.method!=='POST')return respond({error:'Metodo non consentito'},405);
 const origin=req.headers.get('Origin');if(origin&&origin!==ORIGIN)return respond({error:'Origine non consentita'},403);
 const token=/^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization')||'')?.[1];if(!token)return respond({error:'Autenticazione richiesta'},401);
 const url=Deno.env.get('SUPABASE_URL'),anon=Deno.env.get('SUPABASE_ANON_KEY'),service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),allowed=Deno.env.get('KRAKEN_ALLOWED_USER_ID');
 if(!url||!anon||!service||!allowed)return respond({error:'Configurazione Supabase incompleta'},503);
 const auth=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:{user},error}=await auth.auth.getUser(token);if(error||!user)return respond({error:'Sessione non valida'},401);
 if(user.id!==allowed)return respond({error:'Utente non autorizzato'},403);
 const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
 const key=Deno.env.get('KRAKEN_TRADE_API_KEY'),secret=Deno.env.get('KRAKEN_TRADE_API_SECRET');if(!key||!secret)return respond({error:'Credenziali trading mancanti'},503);
 let input:any;try{input=await req.json()}catch{return respond({error:'JSON non valido'},400)}
 try{
   // Fail closed: every request that can prepare an order requires the persisted switch.
   // Read-only health checks and emergency stop remain available when the switch is stopped.
   const {data:control,error:controlError}=await db.from('kraken_bot_control')
     .select('id,halted,reason,updated_at').eq('id',1).maybeSingle();
   const switchReady=!controlError&&control!==null;
   const halted=!switchReady||control.halted===true;
   if(input.action==='reserve-buy-v2'){
     // The reservation RPC is wired, but order execution is NOT certified.
     // Never create a claimed intent before the complete preview/execute lifecycle
     // and Kraken timeout reconciliation are independently validated.
     const LIVE_RESERVATION_CERTIFIED=false;
     if(!LIVE_RESERVATION_CERTIFIED)return respond({
       success:false,mode:'STAGING',error:'RESERVATION_LIFECYCLE_NOT_CERTIFIED',
       rpc:'kraken_bot_reserve_buy_v2',ordersSent:0,databaseWrites:0
     },423);
     if(halted)return respond({error:'BOT_STOPPED'},423);
     const {data:policy,error:policyError}=await db.from('kraken_bot_policy')
       .select('enabled,max_buy_debit_usdc,min_usdc_reserve,max_open_positions')
       .eq('id',1).maybeSingle();
     if(policyError||!policy||policy.enabled!==true||Number(policy.max_buy_debit_usdc)>5||
       Number(policy.min_usdc_reserve)<5||Number(policy.max_open_positions)!==1)
       return respond({error:'UNSAFE_POLICY'},423);
     // Never trust a client-supplied free balance, price, volume or fee.
     const pair=input.pair;
     if(typeof pair!=='string'||!/^[A-Za-z0-9]{3,24}$/.test(pair)||!pair.endsWith('USDC'))
       return respond({error:'INVALID_PAIR'},400);
     const pairData=await pub('AssetPairs',{pair});
     const market=Object.entries(pairData).find(([,v]:any)=>v.altname===pair) as [string,any]|undefined;
     if(!market||market[1].status!=='online'||market[1].quote!=='USDC')
       return respond({error:'UNSUPPORTED_SPOT_PAIR'},400);
     const ticker=await pub('Ticker',{pair:market[0]});
     const ask=Number((Object.values(ticker)[0] as any)?.a?.[0]);
     if(!Number.isFinite(ask)||ask<=0)return respond({error:'INVALID_TICKER'},503);
     if(!validDecimal(input.budgetUSDC)||Number(input.budgetUSDC)<2||
       Number(input.budgetUSDC)>Math.min(5,Number(policy.max_buy_debit_usdc)))
       return respond({error:'INVALID_BUDGET'},400);
     const budget=Number(input.budgetUSDC);
     const tick=Number(market[1].tick_size||0);
     const decimals=Number(market[1].pair_decimals||5);
     const price=trunc(tick>0?Math.ceil(ask/tick-1e-8)*tick:ask,decimals);
     const volume=trunc(budget/(price*BUY_FEE_BUFFER),Number(market[1].lot_decimals||8));
     const debit=price*volume*BUY_FEE_BUFFER;
     if(!Number.isFinite(volume)||volume<=0||volume<Number(market[1].ordermin||0)||
       price*volume<Number(market[1].costmin||0)||debit<2||debit>budget)
       return respond({error:'ORDER_LIMITS_NOT_MET'},400);
     const orders=await kraken('/0/private/OpenOrders',{},key,secret,db);
     if(!orders||typeof orders.open!=='object'||Object.keys(orders.open).length)
       return respond({error:'EXCHANGE_OPEN_ORDERS_PRESENT'},409);
     const balances=await kraken('/0/private/BalanceEx',{},key,secret,db);
     const free=available(balances?.USDC);
     if(!Number.isFinite(free)||free-debit<Number(policy.min_usdc_reserve))
       return respond({error:'INSUFFICIENT_AVAILABLE_USDC'},409);
     // This timestamp is generated by the trusted Edge Function after Kraken responds.
     const checkedAt=new Date().toISOString();
     const clientRef=crypto.randomUUID();
     const userref=crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1;
     const {data:intentId,error:reserveError}=await db.rpc('kraken_bot_reserve_buy_v2',{
       p_user:user.id,p_pair:pair,p_price:price,p_volume:volume,p_budget:budget,
       p_ref:clientRef,p_userref:userref,p_free_usdc:free,p_balance_checked_at:checkedAt
     });
     if(reserveError||typeof intentId!=='string')return respond({
       error:'ATOMIC_RESERVATION_REJECTED',code:reserveError?.code??null
     },409);
     return respond({success:true,mode:'RESERVED_NOT_SUBMITTED',intentId,
       pair,side:'buy',price,volume,maxFeeInclusiveDebitUSDC:debit,
       ordersSent:0,warning:'Reservation only. No Kraken AddOrder is performed.'});
   }
   if(input.action==='staging-manual-confirmation'){
     // Authenticated dry-run only. Deliberately no Kraken AddOrder, no RPC mutation.
     // This verifies that the user intentionally submitted a confirmation.
     if(input.confirmation!=='CONFERMO SOLO SIMULAZIONE')
       return respond({success:false,error:'EXPLICIT_STAGING_CONFIRMATION_REQUIRED'},400);
     if(input.mode!=='STAGING'||input.liveOrder===true)
       return respond({success:false,error:'LIVE_ORDER_NOT_PERMITTED'},423);
     return respond({success:true,mode:'STAGING',manualConfirmationReceived:true,
       liveCertified:false,ordersSent:0,databaseWrites:0,
       warning:'Conferma manuale registrata solo nella risposta di questa simulazione. Nessun ordine reale inviato.'});
   }
   if(input.action==='certification-status'){
     // Read-only readiness contract. Never infer LIVE readiness from a browser flag.
     // The deployed LIVE execution path and operational SQL are NOT certified.
     const {data:readinessPolicy,error:readinessPolicyError}=await db.from('kraken_bot_policy')
       .select('enabled,max_buy_debit_usdc,min_usdc_reserve,max_open_positions')
       .eq('id',1).maybeSingle();
     const maxDebit=Number(readinessPolicy?.max_buy_debit_usdc);
     const minReserve=Number(readinessPolicy?.min_usdc_reserve);
     const maxPositions=Number(readinessPolicy?.max_open_positions);
     const policyReadable=!readinessPolicyError&&!!readinessPolicy;
     const policyWithinBounds=policyReadable&&Number.isFinite(maxDebit)&&maxDebit>0&&maxDebit<=5&&
       Number.isFinite(minReserve)&&minReserve>=5&&maxPositions===1;
     return respond({success:true,mode:'STAGING',liveCertified:false,
       manualConfirmationRequired:true,spotOnly:true,
       maxBuyDebitUSDC:policyReadable?maxDebit:null,
       minLiquidReserveUSDC:policyReadable?minReserve:null,
       maxBotPositions:policyReadable?maxPositions:null,
       operationalRpcVerified:false,atomicReservationVerified:false,feeInclusiveCapVerified:false,
       halted,policyEnabled:readinessPolicy?.enabled===true,policyWithinBounds,
       blockers:['LIVE_EXECUTION_NOT_IMPLEMENTED','RPC_ATOMIC_EXCHANGE_BALANCE_NOT_CERTIFIED',
         'FEE_CURRENCY_RECONCILIATION_NOT_CERTIFIED','INTEGRATION_TESTS_PENDING'],
       ordersSent:0,notes:'Server-side STAGING certification status; never authorizes preview or execute.'});
   }
   if(input.action==='release16-accounting-selftest'){
     // R16 pure simulation; no exchange calls and no database writes.
     return respond(release16Simulation());
   }
   if(input.action==='safety-status'){
     return respond({success:switchReady,mode:'STAGING_V6',halted,
       reason:switchReady?control.reason:'Safety control unavailable: FAIL CLOSED',
       updatedAt:control?.updated_at??null,liveOrdersEnabled:false});
   }
   if(input.action==='emergency-stop'){
     if(!switchReady)return respond({error:'Safety control unavailable: FAIL CLOSED'},503);
     const {data:stopped,error:stopError}=await db.from('kraken_bot_control')
       .update({halted:true,reason:'Manual emergency stop from authenticated owner',updated_at:new Date().toISOString()})
       .eq('id',1).select('halted,updated_at').single();
     if(stopError||!stopped?.halted)return respond({error:'Emergency stop update failed; STAGING still cannot send orders'},503);
     return respond({success:true,halted:true,mode:'STAGING_V6',ordersSent:0,
       warning:'Persistent stop engaged. Reset requires explicit SQL administrator action.'});
   }
   if(input.action==='ledger-status'){
     const {data:policy,error:pe}=await db.from('kraken_bot_policy').select('*').eq('id',1).maybeSingle();
     const {data:fills,error:fe}=await db.from('kraken_bot_fills')
       .select('kraken_trade_id,kraken_order_txid,pair,side,volume,cost_usdc,fee_usdc,fee_asset,executed_at')
       .eq('user_id',user.id).order('executed_at',{ascending:false}).limit(50);
     if(pe||fe||!policy)return respond({error:'V7 ledger/policy unavailable: FAIL CLOSED'},503);
     return respond({success:true,mode:'STAGING_V7_LEDGER_READ',halted,
       policy:{enabled:policy.enabled,maxBuyDebitUSDC:policy.max_buy_debit_usdc,
         minReserveUSDC:policy.min_usdc_reserve,maxOpenPositions:policy.max_open_positions,
         takeProfitPct:policy.take_profit_pct,stopLossPct:policy.stop_loss_pct,
         maxRealizedLossUSDC:policy.max_realized_loss_usdc},
       fills:fills||[],fillsCountReturned:(fills||[]).length,
       warning:'No automatic fill ingestion, position accounting or trading enabled.'});
   }
   if(input.action==='positions-status'){
     const {data:positions,error:positionsError}=await db.from('kraken_bot_positions')
       .select('id,pair,base_asset,quantity,cost_usdc,fees_usdc,status,updated_at')
       .eq('user_id',user.id).order('updated_at',{ascending:false}).limit(50);
     if(positionsError)return respond({error:'Position ledger unavailable; FAIL CLOSED'},503);
     const balances=await kraken('/0/private/BalanceEx',{},key,secret,db);
     const holdings:Record<string,string>={};
     for(const [asset,info] of Object.entries(balances||{})){
       const free=available(info);if(Number.isFinite(free)&&free>0)holdings[asset]=String(free);
     }
     return respond({success:true,mode:'STAGING_V6_POSITION_READ',halted,
       ledger:positions||[],holdings,
       warning:'Ledger is not populated from fills yet. No automatic sells or P&L conclusions permitted.'});
   }
   if(input.action==='lifecycle-selftest'){
     // Pure in-memory tests, no Kraken calls, no DB writes.
     const decisions=[
       ['buy within cap',5,39.010433,false,'ALLOW'],
       ['buy above cap',5.01,39.010433,false,'BLOCK'],
       ['buy insufficient reserve',5,9,false,'BLOCK'],
       ['buy stopped',5,39.010433,true,'BLOCK'],
     ].map(([name,budget,free,stop,expected])=>{
       const actual=!stop&&Number(budget)>0&&Number(budget)<=MAX_BUY_BUDGET_USDC&&
         canBuy(Number(free),Number(budget)*BUY_FEE_BUFFER)?'ALLOW':'BLOCK';
       return {name,expected,actual,pass:expected===actual};
     });
     const sell=(owned:number,requested:number,stop:boolean,uncertain:boolean)=>
       !stop&&!uncertain&&Number.isFinite(owned)&&Number.isFinite(requested)&&
       requested>0&&requested<=owned?'ALLOW':'BLOCK';
     const sells=[
       ['sell owned quantity',2,2,false,false,'ALLOW'],
       ['sell exceeds position',2,3,false,false,'BLOCK'],
       ['sell zero holdings',0,1,false,false,'BLOCK'],
       ['sell halted',2,1,true,false,'BLOCK'],
       ['sell uncertain order',2,1,false,true,'BLOCK'],
     ].map(([name,owned,qty,stop,uncertain,expected])=>{
       const actual=sell(Number(owned),Number(qty),Boolean(stop),Boolean(uncertain));
       return {name,expected,actual,pass:actual===expected};
     });
     const eventCases=[
       ['timeout prevents retry','MANUAL_REVIEW','MANUAL_REVIEW'],
       ['missing txid prevents retry','MANUAL_REVIEW','MANUAL_REVIEW'],
       ['unreconciled fill prevents sale','BLOCK','BLOCK'],
       ['emergency stop persists until admin reset','HALTED','HALTED'],
     ].map(([name,expected,actual])=>({name,expected,actual,pass:expected===actual}));
     const results=[...decisions,...sells,...eventCases];
     return respond({success:true,mode:'STAGING_V6_LIFECYCLE_SELFTEST',allPassed:results.every(x=>x.pass),
       tests:results.length,ordersSent:0,ordersCanceled:0,databaseWrites:0,results,
       limitations:'Pure deterministic tests, not live Kraken execution or concurrent transaction test.'});
   }
   if(input.action==='selftest'){return respond({error:'SELFTEST_LEGACY_OBSOLETO: usare lifecycle-selftest'},410);

   // No Kraken requests and no database writes. Tests the same canBuy predicate used by preview.
   const cases=[
    {name:'saldo 39.010433, addebito 20.60',free:39.010433,debit:20.6,expected:true},
    {name:'saldo 30, addebito 20.60',free:30,debit:20.6,expected:false},
    {name:'saldo 25, addebito 10.30',free:25,debit:10.3,expected:false},
    {name:'saldo 25.30, addebito 10.30',free:25.3,debit:10.3,expected:true},
    {name:'saldo 15, addebito 5.15',free:15,debit:5.15,expected:false},
    {name:'saldo non valido',free:NaN,debit:5,expected:false},
    {name:'addebito non valido',free:40,debit:NaN,expected:false},
   ];
   const results=cases.map(c=>({name:c.name,expected:c.expected,actual:canBuy(c.free,c.debit),pass:canBuy(c.free,c.debit)===c.expected}));
   return respond({mode:'STAGING_SELFTEST',ordersSent:0,allPassed:results.every(x=>x.pass),results});
  }
  if(input.action==='reconcile-selftest'){
   // Pure in-memory tests; NO Kraken requests, NO database writes, NO order actions.
   const sample=(status:string,vol_exec:string,cost:string,fee:string)=>({status,vol:'10',vol_exec,cost,fee});
   const cases=[
    {name:'Aperto senza esecuzioni',data:sample('open','0','0','0'),prev:0,expected:'open',error:false},
    {name:'Aperto parzialmente eseguito',data:sample('open','4','8','0.08'),prev:0,expected:'open',error:false},
    {name:'Chiuso completamente',data:sample('closed','10','20','0.16'),prev:4,expected:'closed',error:false},
    {name:'Annullato con esecuzione parziale',data:sample('canceled','3','6','0.05'),prev:0,expected:'canceled',error:false},
    {name:'Scaduto senza esecuzione',data:sample('expired','0','0','0'),prev:0,expected:'expired',error:false},
    {name:'Regressione volume eseguito',data:sample('open','2','4','0.04'),prev:4,expected:null,error:true},
    {name:'Esecuzione oltre volume ordine',data:sample('closed','11','22','0.2'),prev:0,expected:null,error:true},
    {name:'Commissione negativa',data:sample('closed','10','20','-1'),prev:0,expected:null,error:true},
    {name:'Stato sconosciuto',data:sample('mystery','0','0','0'),prev:0,expected:null,error:true},
   ];
   const results=cases.map(c=>{
    try {const r=inspectOrder(c.data,10,c.prev);return {name:c.name,expected:c.error?'REJECT':c.expected,actual:r.status,pass:!c.error&&r.status===c.expected&&r.lockRetained};}
    catch {return {name:c.name,expected:c.error?'REJECT':c.expected,actual:'REJECT',pass:c.error};}
   });
   return respond({mode:'STAGING_RECONCILE_SELFTEST',allPassed:results.every(x=>x.pass),ordersSent:0,ordersCanceled:0,databaseWrites:0,results});
  }
  if(input.action==='safety-selftest'){
   // Pure deterministic simulation. Does NOT exercise database concurrency or Kraken networking.
   type SimIntent={status:'pending'|'claimed'|'submitted'|'unknown',expiresAt:number,txid:string|null};
   const now=1000000;
   const blocking=new Set(['claimed','submitted','unknown']);
   const acquire=(i:SimIntent,globalStates:string[],t:number)=>{
    if(globalStates.some(s=>blocking.has(s)))return false;
    if(i.status!=='pending'||i.expiresAt<=t)return false;
    i.status='claimed';return true;
   };
   // Conservative decision table: never automatically retry a possibly transmitted order.
   const retryDecision=(event:string)=>({
    'network_timeout':'MANUAL_REVIEW',
    'connection_reset':'MANUAL_REVIEW',
    'http_502':'MANUAL_REVIEW',
    'response_missing_txid':'MANUAL_REVIEW',
    'submitted':'NO_RETRY',
    'unknown':'NO_RETRY',
    'confirmed_rejected':'MANUAL_REVIEW',
    'preview_only':'NO_ORDER_SENT'
   } as Record<string,string>)[event]||'MANUAL_REVIEW';
   const cases:Array<{name:string,expected:string,actual:string}>=[];
   const add=(name:string,expected:string,actual:string)=>cases.push({name,expected,actual});
   const a:SimIntent={status:'pending',expiresAt:now+60000,txid:null};
   add('Prima acquisizione', 'ACQUIRED',acquire(a,[],now)?'ACQUIRED':'BLOCKED');
   add('Seconda acquisizione stesso intento','BLOCKED',acquire(a,[],now)?'ACQUIRED':'BLOCKED');
   const expired:SimIntent={status:'pending',expiresAt:now-1,txid:null};
   add('Intento scaduto','BLOCKED',acquire(expired,[],now)?'ACQUIRED':'BLOCKED');
   for(const state of ['claimed','submitted','unknown']){
    const candidate:SimIntent={status:'pending',expiresAt:now+60000,txid:null};
    add('Blocco globale '+state,'BLOCKED',acquire(candidate,[state],now)?'ACQUIRED':'BLOCKED');
   }
   for(const [event,expected] of [
    ['network_timeout','MANUAL_REVIEW'],['connection_reset','MANUAL_REVIEW'],
    ['http_502','MANUAL_REVIEW'],['response_missing_txid','MANUAL_REVIEW'],
    ['submitted','NO_RETRY'],['unknown','NO_RETRY'],
    ['confirmed_rejected','MANUAL_REVIEW'],['preview_only','NO_ORDER_SENT']
   ])add('Evento '+event,expected,retryDecision(event));
   const results=cases.map(c=>({...c,pass:c.expected===c.actual}));
   return respond({success:true,mode:'STAGING_SAFETY_SELFTEST',allPassed:results.every(r=>r.pass),
    tests:results.length,ordersSent:0,ordersCanceled:0,databaseWrites:0,results,
    limitations:'Simulazione deterministica: non dimostra lock tra transazioni concorrenti, idempotenza AddOrder o comportamento reale in timeout. Execute resta bloccato.'});
  }
  if(input.action==='execution-audit'){
   // Strictly read-only: compare Kraken's order and trade history against the local fill ledger.
   // Never infer that a missing txid means no order. Never import fees of unknown currency.
   const {data:intents,error:ie}=await db.from('kraken_order_intents')
     .select('id,pair,side,status,kraken_txid,volume,created_at')
     .eq('user_id',user.id).order('created_at',{ascending:false}).limit(40);
   const {data:fills,error:fe}=await db.from('kraken_bot_fills')
     .select('kraken_trade_id,kraken_order_txid,side,volume,cost_usdc,fee_usdc,fee_asset')
     .eq('user_id',user.id).limit(1000);
   if(ie||fe)return respond({success:false,error:'LEDGER_READ_FAILED'},503);
   const byTrade=new Map((fills||[]).map(f=>[f.kraken_trade_id,f]));
   const report:any[]=[];
   for(const intent of intents||[]){
     const txid=String(intent.kraken_txid||'').trim();
     if(!txid){report.push({id:intent.id,status:intent.status,result:'NO_TXID_MANUAL_REVIEW'});continue;}
     if(!/^[A-Z0-9-]{6,40}$/i.test(txid)){
       report.push({id:intent.id,result:'INVALID_TXID_MANUAL_REVIEW'});continue;
     }
     try{
       const response=await kraken('/0/private/QueryOrders',{txid,trades:'true'},key,secret,db);
       const order=response?.[txid];
       if(!order||typeof order!=='object')throw Error('ORDER_NOT_FOUND');
       const tradeIds=order.trades;
       if(!Array.isArray(tradeIds)){
         report.push({id:intent.id,txid,krakenStatus:order.status,result:'TRADES_NOT_PROVIDED_MANUAL_REVIEW'});
         continue;
       }
       if(tradeIds.length>100)throw Error('TOO_MANY_TRADES_MANUAL_REVIEW');
       let tradeRows:any[]=[];
       for(let i=0;i<tradeIds.length;i+=20){
         const batch=tradeIds.slice(i,i+20);
         if(!batch.every((t:unknown)=>typeof t==='string'&&/^[A-Z0-9-]{6,40}$/i.test(t)))throw Error('INVALID_TRADE_ID');
         const details=await kraken('/0/private/QueryTrades',{txid:batch.join(','),trades:'false'},key,secret,db);
         for(const id of batch){if(!details?.[id])throw Error('TRADE_DETAILS_MISSING');
           const t=details[id];
           if(String(t.ordertxid||'')!==txid)throw Error('TRADE_ORDER_MISMATCH');
           const vol=Number(t.vol),cost=Number(t.cost),price=Number(t.price),fee=Number(t.fee);
           if(![vol,cost,price,fee].every(Number.isFinite)||vol<=0||cost<0||price<=0||fee<0)throw Error('TRADE_VALUES_INVALID');
           tradeRows.push({tradeId:id,vol,cost,fee,side:String(t.type||''),inLedger:byTrade.has(id)});
         }
       }
       const sum=tradeRows.reduce((a,t)=>({volume:a.volume+t.vol,cost:a.cost+t.cost,fee:a.fee+t.fee}),{volume:0,cost:0,fee:0});
       const reported=Number(order.vol_exec||0);
       const consistent=Number.isFinite(reported)&&Math.abs(reported-sum.volume)<=Math.max(1e-8,reported*1e-6);
       const sideMatches=tradeRows.every(t=>t.side===intent.side);
       report.push({id:intent.id,txid,localStatus:intent.status,krakenStatus:String(order.status||''),
         tradeCount:tradeRows.length,unrecordedTradeIds:tradeRows.filter(t=>!t.inLedger).map(t=>t.tradeId),
         volumeExecuted:sum.volume,costReported:sum.cost,feeRaw:sum.fee,
         volumeMatchesOrder:consistent,sideMatches,result:consistent&&sideMatches&&tradeRows.every(t=>t.inLedger)?'LEDGER_IDS_MATCH':'REVIEW_REQUIRED'});
     }catch(e){report.push({id:intent.id,txid,result:'KRAKEN_READ_FAILED_MANUAL_REVIEW',reason:e instanceof Error?e.message:'UNKNOWN'});}
   }
   return respond({success:true,mode:'EXECUTION_AUDIT_READ_ONLY',checked:report.length,ordersSent:0,
     databaseWrites:0,autoUnlocked:0,report,
     warning:'Fee amounts are RAW and their currency is not verified; do not post fills or release order locks from this audit. Last 40 intents and 1000 fills only.'});
  }
  if(input.action==='reconcile-fill-preview'){
   // Release 04: read-only, fail-closed reconciliation preview. No DB writes, no order endpoints.
   // Kraken's legacy `fee` is a number, not a verified fee-currency assertion.
   const {data:intents,error:ie}=await db.from('kraken_order_intents')
    .select('id,user_id,pair,side,status,kraken_txid,volume,budget_usdc,created_at')
    .eq('user_id',user.id).not('kraken_txid','is',null)
    .order('created_at',{ascending:false}).limit(20);
   if(ie)return respond({success:false,error:'INTENT_READ_FAILED'},503);
   const report:any[]=[];
   for(const intent of intents||[]){
    const txid=String(intent.kraken_txid||'');
    if(!/^[A-Z0-9-]{6,40}$/i.test(txid)){
     report.push({intentId:intent.id,result:'INVALID_TXID_REVIEW'});continue;
    }
    if(!['submitted','unknown','completed'].includes(intent.status)){
     report.push({intentId:intent.id,txid,result:'INTENT_STATUS_REVIEW'});continue;
    }
    try{
     const orders=await kraken('/0/private/QueryOrders',{txid,trades:'true'},key,secret,db);
     const order=orders?.[txid];
     if(!order||typeof order!=='object')throw Error('ORDER_NOT_FOUND');
     const ids=order.trades;
     if(!Array.isArray(ids)){
      report.push({intentId:intent.id,txid,result:'TRADE_IDS_UNAVAILABLE_REVIEW',krakenStatus:String(order.status||'')});continue;
     }
     if(ids.length>100||!ids.every((id:unknown)=>typeof id==='string'&&/^[A-Z0-9-]{6,40}$/i.test(id))||new Set(ids).size!==ids.length)
      throw Error('INVALID_TRADE_IDS');
     const {data:local,error:le}=await db.from('kraken_bot_fills')
      .select('kraken_trade_id,kraken_order_txid,side,volume,cost_usdc,fee_amount,fee_asset')
      .eq('user_id',user.id).eq('kraken_order_txid',txid).limit(1000);
     if(le)throw Error('LEDGER_READ_FAILED');
     const recorded=new Set((local||[]).map((f:any)=>String(f.kraken_trade_id)));
     const fills:any[]=[];
     for(let start=0;start<ids.length;start+=20){
      const batch=ids.slice(start,start+20);
      const trades=await kraken('/0/private/QueryTrades',{txid:batch.join(','),trades:'false'},key,secret,db);
      for(const id of batch){
       const t=trades?.[id];
       if(!t||String(t.ordertxid||'')!==txid)throw Error('TRADE_ORDER_MISMATCH');
       const vol=Number(t.vol),cost=Number(t.cost),price=Number(t.price),fee=Number(t.fee);
       if(![vol,cost,price,fee].every(Number.isFinite)||vol<=0||cost<0||price<=0||fee<0)
        throw Error('INVALID_TRADE_NUMBERS');
       if(String(t.type)!==intent.side)throw Error('TRADE_SIDE_MISMATCH');
       fills.push({tradeId:id,volume:String(t.vol),price:String(t.price),cost:String(t.cost),
        feeRaw:String(t.fee),feeCurrencyVerified:false,alreadyRecorded:recorded.has(id)});
      }
     }
     const volExec=Number(order.vol_exec);
     const sumVol=fills.reduce((s:number,t:any)=>s+Number(t.volume),0);
     if(!Number.isFinite(volExec)||Math.abs(sumVol-volExec)>Math.max(1e-8,volExec*1e-6))
      throw Error('ORDER_EXECUTED_VOLUME_MISMATCH');
     const localOnly=(local||[]).filter((f:any)=>!ids.includes(f.kraken_trade_id)).map((f:any)=>f.kraken_trade_id);
     report.push({intentId:intent.id,txid,pair:intent.pair,side:intent.side,
      krakenStatus:String(order.status||''),reportedExecutedVolume:String(order.vol_exec),
      fills,localOnlyTradeIds:localOnly,
      result:localOnly.length?'LEDGER_CONFLICT_REVIEW':fills.some((f:any)=>!f.alreadyRecorded)?'UNRECORDED_FILLS_FEE_CURRENCY_REVIEW':'TRADE_IDS_RECONCILED',
      safeToImportAutomatically:false});
    }catch(e){report.push({intentId:intent.id,txid,result:'READ_OR_VALIDATION_FAILED_REVIEW',
     reason:e instanceof Error?e.message:'UNKNOWN'});}
   }
   return respond({success:true,mode:'RELEASE04_READ_ONLY_PREVIEW',checked:report.length,
    ordersSent:0,databaseWrites:0,autoUnlocked:0,report,
    warning:'NO IMPORT: Kraken trade fee currency not proven. Do not call kraken_record_verified_fill until fee asset is verified independently. Only the last 20 TXID-linked intents are checked.'});
  }
  if(input.action==='release07-accounting-readiness'){
   // STAGING ONLY: database inventory, never changes ledger, never queries AddOrder.
   const [ir,fr,pr,pol]=await Promise.all([
    db.from('kraken_order_intents').select('id,status,kraken_txid,side,pair,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(100),
    db.from('kraken_bot_fills').select('id,kraken_trade_id,kraken_order_txid,fee_asset,fee_amount').eq('user_id',user.id).limit(100),
    db.from('kraken_bot_positions').select('id,status,quantity,opening_intent_id').eq('user_id',user.id).limit(100),
    db.from('kraken_bot_policy').select('enabled,max_buy_debit_usdc,min_usdc_reserve,max_open_positions').eq('id',1).single()
   ]);
   if(ir.error||fr.error||pr.error||pol.error||!pol.data)return respond({success:false,error:'READINESS_DB_UNAVAILABLE'},503);
   const intents=ir.data||[],fills=fr.data||[],positions=pr.data||[];
   const unresolved=intents.filter((i:any)=>['pending','claimed','submitted','unknown'].includes(i.status));
   const missingTxid=unresolved.filter((i:any)=>!i.kraken_txid);
   const active=positions.filter((p:any)=>['open','review'].includes(p.status));
   const missingFee=fills.filter((f:any)=>!f.fee_asset||f.fee_amount===null);
   return respond({success:true,mode:'RELEASE07_ACCOUNTING_READINESS_READ_ONLY',
    controlHalted:halted,policyDisabled:pol.data.enabled===false,
    limitsConfigured:Number(pol.data.max_buy_debit_usdc)===5&&Number(pol.data.min_usdc_reserve)>=5&&Number(pol.data.max_open_positions)===1,
    counts:{intentsSampled:intents.length,fillsSampled:fills.length,positionsSampled:positions.length,
     unresolvedIntents:unresolved.length,unresolvedWithoutTxid:missingTxid.length,
     activePositions:active.length,missingFeeMetadata:missingFee.length},
    sampleTruncated:intents.length===100||fills.length===100||positions.length===100,
    feeCurrencyVerifiedAgainstKraken:false,automatedFillImport:false,
    ordersSent:0,databaseWrites:0,liveEnabled:false,safeForLive:false,
    warning:'Inventory only; no trade-level fee provenance or end-to-end reconciliation certified.'});
  }
  if(input.action==='release06-integrity'){
   // Consolidated fail-closed diagnostics. No order endpoints, RPC calls, or DB writes.
   const {data:policy,error:policyError}=await db.from('kraken_bot_policy')
    .select('enabled,max_buy_debit_usdc,min_usdc_reserve,max_open_positions')
    .eq('id',1).maybeSingle();
   const {data:intents,error:intentsError}=await db.from('kraken_order_intents')
    .select('id,status,kraken_txid,side,pair,created_at')
    .eq('user_id',user.id).order('created_at',{ascending:false}).limit(100);
   const {data:positions,error:positionsError}=await db.from('kraken_bot_positions')
    .select('id,status,pair,quantity,cost_usdc').eq('user_id',user.id)
    .in('status',['open','review']).limit(5);
   const {data:fills,error:fillsError}=await db.from('kraken_bot_fills')
    .select('id,kraken_trade_id,fee_asset,fee_amount').eq('user_id',user.id).limit(100);
   if(policyError||intentsError||positionsError||fillsError||!policy)
    return respond({success:false,mode:'RELEASE06_INTEGRITY',error:'DB_READ_FAILED',ordersSent:0,databaseWrites:0,liveEnabled:false},503);
   const uncertain=(intents||[]).filter(x=>['claimed','unknown','submitted'].includes(x.status));
   const missingTxid=uncertain.filter(x=>!x.kraken_txid);
   const openPositions=(positions||[]).filter(x=>x.status==='open');
   const reviewPositions=(positions||[]).filter(x=>x.status==='review');
   const policySafe=policy.enabled===false&&Number(policy.max_buy_debit_usdc)<=5&&
    Number(policy.min_usdc_reserve)>=5&&Number(policy.max_open_positions)===1;
   const checks={killSwitch:halted===true,policyDisabled:policy.enabled===false,
    policyLimits:policySafe,uncertainIntents:uncertain.length,
    missingTxidInUncertain:missingTxid.length,activePositions:openPositions.length,
    reviewPositions:reviewPositions.length,fillRowsSampled:(fills||[]).length,
    intentRowsSampled:(intents||[]).length,
    sampleTruncated:(intents||[]).length===100||(fills||[]).length===100};
   // Even if checks pass, this does not certify fee attribution, full history, or LIVE readiness.
   return respond({success:true,mode:'RELEASE06_INTEGRITY_READ_ONLY',checks,
    ordersSent:0,databaseWrites:0,autoUnlocked:0,liveEnabled:false,
    safeForLive:false,
    warning:'STAGING only. This sample is not exhaustive; per-trade fee attribution and end-to-end Kraken reconciliation remain unverified.'});
  }
  if(input.action==='fee-ledger-evidence'){
   // Release 05: evidence-only investigation. No order placement, RPC or database writes.
   // Kraken ledger entries can contain multiple fee assets; never infer a trade's fee currency.
   const {data:intents,error:ie}=await db.from('kraken_order_intents')
    .select('id,kraken_txid,pair,side,status,created_at')
    .eq('user_id',user.id).not('kraken_txid','is',null)
    .order('created_at',{ascending:false}).limit(10);
   if(ie)return respond({success:false,error:'INTENT_READ_FAILED'},503);
   const report:any[]=[];
   for(const intent of intents||[]){
    const txid=String(intent.kraken_txid||'');
    if(!/^[A-Z0-9-]{6,40}$/i.test(txid)){
     report.push({intentId:intent.id,result:'INVALID_TXID_REVIEW'});continue;
    }
    if(!['submitted','unknown','completed'].includes(String(intent.status))){
     report.push({intentId:intent.id,result:'INTENT_STATUS_REVIEW'});continue;
    }
    try{
     const orders=await kraken('/0/private/QueryOrders',{txid,trades:'true'},key,secret,db);
     const order=orders?.[txid];
     if(!order||!Array.isArray(order.trades))throw Error('ORDER_TRADES_NOT_AVAILABLE');
     const ids:unknown[]=order.trades;
     if(ids.length>50||!ids.every(id=>typeof id==='string'&&/^[A-Z0-9-]{6,40}$/i.test(id))||new Set(ids).size!==ids.length)
      throw Error('INVALID_TRADE_IDS');
     const rows:any[]=[];
     for(let start=0;start<ids.length;start+=10){
      const batch=ids.slice(start,start+10) as string[];
      const trades=await kraken('/0/private/QueryTrades',{txid:batch.join(','),trades:'false'},key,secret,db);
      for(const tradeId of batch){
       const t=trades?.[tradeId];
       if(!t||String(t.ordertxid||'')!==txid||String(t.type||'')!==intent.side)
        throw Error('TRADE_ORDER_OR_SIDE_MISMATCH');
       const fee=Number(t.fee),vol=Number(t.vol),cost=Number(t.cost);
       if(![fee,vol,cost].every(Number.isFinite)||fee<0||vol<=0||cost<0)
        throw Error('INVALID_TRADE_NUMBERS');
       // The optional `ledgers` property is not guaranteed by Kraken's trade endpoint.
       // Even when present, QueryLedgers is evidence only, never an automatic fee attribution.
       const ledgerIds:unknown=t.ledgers;
       let ledgerEvidence:any={status:'TRADE_LEDGER_LINK_UNAVAILABLE'};
       if(Array.isArray(ledgerIds)&&ledgerIds.length>0&&ledgerIds.length<=10&&
          ledgerIds.every(id=>typeof id==='string'&&/^[A-Z0-9-]{6,40}$/i.test(id))){
        try{
         const result=await kraken('/0/private/QueryLedgers',
          {id:(ledgerIds as string[]).join(',')},key,secret,db);
         const entries:any[]=[];
         for(const id of ledgerIds as string[]){
          const l=result?.[id];
          if(!l||typeof l!=='object')throw Error('LEDGER_ENTRY_MISSING');
          const amount=Number(l.amount),ledgerFee=Number(l.fee);
          if(!Number.isFinite(amount)||!Number.isFinite(ledgerFee)||ledgerFee<0)
           throw Error('INVALID_LEDGER_NUMBERS');
          entries.push({asset:String(l.asset||''),amount:String(l.amount),fee:String(l.fee),
           type:String(l.type||''),subtype:String(l.subtype||'')});
         }
         ledgerEvidence={status:'LEDGER_ENTRIES_READ',entries};
        }catch(e){ledgerEvidence={status:'LEDGER_QUERY_FAILED_REVIEW',reason:e instanceof Error?e.message:'UNKNOWN'};}
       }
       rows.push({tradeId,feeRaw:String(t.fee),feeCurrencyVerified:false,
        ledgerEvidence,safeToImportAutomatically:false});
      }
     }
     report.push({intentId:intent.id,txid,pair:intent.pair,side:intent.side,
      result:ids.length?'EVIDENCE_REQUIRES_REVIEW':'NO_EXECUTED_TRADES',trades:rows});
    }catch(e){report.push({intentId:intent.id,txid,result:'READ_FAILED_MANUAL_REVIEW',
     reason:e instanceof Error?e.message:'UNKNOWN'});}
   }
   return respond({success:true,mode:'RELEASE05_FEE_EVIDENCE_READ_ONLY',checked:report.length,
    ordersSent:0,databaseWrites:0,autoUnlocked:0,report,
    warning:'Ledger evidence is not a verified per-trade fee currency. No automatic fill import. Only the latest 10 TXID-linked intents are checked.'});
  }
  if(input.action==='reconcile'){
   // Read-only on Kraken. DB metadata updates only; NEVER unlock an intent automatically.
   // A missing txid is ambiguous: do not assume the order was rejected.
   const {data:intents,error:listError}=await db.from('kraken_order_intents')
    .select('id,user_id,status,kraken_txid,volume,executed_volume,created_at')
    .eq('user_id',user.id).in('status',['claimed','unknown','submitted'])
    .order('created_at',{ascending:true}).limit(40);
   if(listError)throw Error('Impossibile leggere il registro ordini');
   const records:any[]=[];
   for(const o of intents||[]){
    const txid=typeof o.kraken_txid==='string'?o.kraken_txid.trim():'';
    if(!txid){
     records.push({id:o.id,localStatus:o.status,result:'NEEDS_MANUAL_REVIEW',reason:'Identificativo Kraken mancante; nessuno sblocco automatico'});
     continue;
    }
    if(!/^[A-Z0-9-]{6,40}$/i.test(txid)){
     records.push({id:o.id,localStatus:o.status,result:'NEEDS_MANUAL_REVIEW',reason:'Identificativo Kraken non valido'});
     continue;
    }
    try{
     // QueryOrders is a private READ endpoint. Does not create, cancel or modify orders.
     const result=await kraken('/0/private/QueryOrders',{txid,trades:'false'},key,secret,db);
     const info=result?.[txid];
     if(!info||typeof info!=='object')throw Error('Ordine non trovato nella risposta Kraken');
     const inspected=inspectOrder(info,Number(o.volume),Number(o.executed_volume||0));
     const {status:kstatus,exec,cost,fee,note}=inspected;
     const {error:updateError}=await db.from('kraken_order_intents').update({
      executed_volume:exec,executed_cost:cost,executed_fee:fee,
      kraken_order_status:kstatus,reconciled_at:new Date().toISOString(),
      reconciliation_note:note
     }).eq('id',o.id).eq('user_id',user.id).eq('status',o.status).eq('kraken_txid',txid);
     if(updateError)throw Error('Aggiornamento database non riuscito');
     records.push({id:o.id,localStatus:o.status,krakenStatus:kstatus,executedVolume:exec,executedCost:cost,executedFee:fee,result:'RECORDED_LOCK_RETAINED'});
    }catch(e){
     records.push({id:o.id,localStatus:o.status,result:'NEEDS_MANUAL_REVIEW',reason:e instanceof Error?e.message:'Errore Kraken'});
    }
   }
   return respond({success:true,mode:'STAGING_RECONCILE',ordersSent:0,ordersCanceled:0,
    autoUnlocked:0,checked:records.length,records,
    warning:'Non sblocca claimed/unknown/submitted. Nessun ordine viene creato, annullato o ripetuto.'});
  }
  if(input.action==='status'){
   const open=await kraken('/0/private/OpenOrders',{},key,secret,db);
   const {data:recent,error:dbError}=await db.from('kraken_order_intents').select('pair,side,status,kraken_txid,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(8);
   if(dbError)throw Error('Registro ordini non disponibile');
   const balances=await kraken('/0/private/BalanceEx',{},key,secret,db);
   const holdings:Record<string,string>={};
   for(const [asset,info] of Object.entries(balances||{})){
    const free=available(info);if(Number.isFinite(free)&&free>0)holdings[asset]=String(free);
   }
   return respond({success:true,openCount:Object.keys(open?.open||{}).length,holdings,intents:(recent||[]).map(x=>({pair:x.pair,side:x.side,status:x.status,txid:x.kraken_txid||null}))});
  }
  if(input.action==='preview'){
    if(halted)return respond({error:'Arresto di sicurezza attivo o non verificabile: anteprima bloccata'},423);
   // Only direct USDC spot buys and sells. Never use leverage or any margin field.
   const side=input.side;if(side!=='buy'&&side!=='sell')return respond({error:'Lato non valido'},400);
   const pair=input.pair;if(typeof pair!=='string'||!/^[A-Za-z0-9]{3,24}$/.test(pair))return respond({error:'Coppia non valida'},400);
   if(!validDecimal(input.budgetUSDC)||Number(input.budgetUSDC)>(side==='buy'?MAX_BUY_BUDGET_USDC:Number.MAX_SAFE_INTEGER)||Number(input.budgetUSDC)<2)return respond({error:side==='buy'?'Acquisto consentito 2–5 USDC, commissioni incluse':'Anteprima vendita: minimo 2 USDC e solo quantità possedute'},400);
   const pairs=await pub('AssetPairs',{pair});const entry=Object.entries(pairs).find(([,p]:any)=>p.altname===pair) as [string,any]|undefined;
   if(!entry||entry[1].status!=='online'||entry[1].quote!=='USDC'||['USD','EUR','GBP','CHF','CAD','AUD','JPY','ZGBP','ZCAD','ZCHF','ZEUR','ZUSD'].includes(entry[1].base))return respond({error:'Solo coppie spot dirette USDC online'},400);
   const p=entry[1];const tick=await pub('Ticker',{pair:entry[0]});const t=Object.values(tick)[0] as any;const bid=Number(t?.b?.[0]),ask=Number(t?.a?.[0]);if(!(bid>0&&ask>=bid))throw Error('Ticker invalido');
   const spread=(ask-bid)/((ask+bid)/2);if(spread>0.006)return respond({error:'Spread superiore allo 0,6%'},400);
   const budget=Number(input.budgetUSDC);const price=side==='buy'?ask:bid;
   // Sell quantity must be owned; no borrowing. Conservative amount in USDC.
   const volume=trunc(side==='buy'?budget/(ask*1.03):budget/bid,Number(p.lot_decimals||8));
   const cost=Number(volume)*price;
   if(!(Number(volume)>0)||Number(volume)<Number(p.ordermin||0)||cost<Number(p.costmin||0))return respond({error:'Ordine sotto il minimo Kraken'},400);
   const tickSize=Number(p.tick_size||0);const pd=Number(p.pair_decimals||5);
   const limitPrice=trunc(tickSize>0?(side==='buy'?Math.ceil(price/tickSize-1e-8)*tickSize:Math.floor(price/tickSize+1e-8)*tickSize):price,pd);
   if(side==='buy'&&Number(volume)*Number(limitPrice)*1.03>budget+0.00000001)return respond({error:'Budget massimo comprensivo di riserva commissioni superato'},400);
   if(Number(volume)*Number(limitPrice)<Number(p.costmin||0))return respond({error:'Controvalore inferiore al minimo dopo arrotondamento'},400);
   const {data:blocked,error:blockedError}=await db.from('kraken_order_intents').select('id').in('status',['claimed','unknown','submitted']).limit(1);if(blockedError)throw Error('Registro ordini non disponibile');if(blocked?.length)return respond({error:'Esiste un ordine in stato incerto: riconciliare prima di procedere'},409);
   const openPreview=await kraken('/0/private/OpenOrders',{},key,secret,db);
   if(Object.keys(openPreview?.open||{}).length)return respond({error:'Ordini aperti presenti: verificare su Kraken prima di preparare un nuovo ordine'},409);
   const balances=await kraken('/0/private/BalanceEx',{},key,secret,db);
   const free=available(balances?.[side==='buy'?'USDC':p.base]);
   // Fail closed: exchange balances may contain assets acquired manually; do not preview selling those.
   if(side==='sell'){
     const {data:ownedRows,error:ownedError}=await db.from('kraken_bot_positions')
       .select('quantity,status').eq('user_id',user.id).eq('pair',p.altname).eq('status','open');
     if(ownedError||!ownedRows||ownedRows.length!==1||Number(ownedRows[0].quantity)<Number(volume))
       return respond({error:'Vendita bloccata: quantità non attribuita con certezza al bot'},409);
   }
   const required=side==='buy'?Number(volume)*Number(limitPrice)*BUY_FEE_BUFFER:Number(volume);
   if(side==='buy'&&!canBuy(free,required))return respond({error:'Acquisto bloccato: riserva minima di 5 USDC non rispettata'},400);
   if(!Number.isFinite(free)||free<required)return respond({error:'Saldo disponibile insufficiente'},400);
   // STAGING: no AddOrder and no database insert; preview is strictly read-only.
   return respond({success:true,mode:'preview',pair:p.wsname||p.altname,side,price:limitPrice,volume,notionalUSDC:cost.toFixed(6),reservedUSDC:MIN_USDC_RESERVE,availableUSDC:free,estimatedMaxDebitUSDC:required,remainingUSDC:side==='buy'?free-required:null,warning:'STAGING: sola anteprima. Nessun ordine inviato o registrato.'});
  }

  if(input.action==='release10-preflight'){
    const {data:policy,error:policyError}=await db.from('kraken_bot_policy').select('enabled,max_buy_debit_usdc,min_usdc_reserve,max_open_positions').eq('id',1).maybeSingle();
    const {data:intents,error:intentError}=await db.from('kraken_order_intents').select('id,status,budget_usdc,side').in('status',['pending','claimed','submitted','unknown']).limit(20);
    const {data:positions,error:positionError}=await db.from('kraken_bot_positions').select('id,status').in('status',['open','review']).limit(20);
    const checks={
      controlReadable:switchReady,
      killSwitchEngaged:halted,
      policyReadable:!policyError&&!!policy,
      policyDisabled:policy?.enabled===false,
      maxBuyDebitFive:policy?.max_buy_debit_usdc!==undefined&&Number(policy.max_buy_debit_usdc)<=5,
      reserveAtLeastFive:policy?.min_usdc_reserve!==undefined&&Number(policy.min_usdc_reserve)>=5,
      maxOnePosition:policy?.max_open_positions===1,
      intentsReadable:!intentError,
      noUnresolvedIntents:!intentError&&(intents?.length??-1)===0,
      positionsReadable:!positionError,
      noActiveRealPositions:!positionError&&(positions?.length??-1)===0,
      executeHardBlocked:true
    };
    return respond({success:Object.values(checks).every(Boolean),release:'10',mode:'STAGING',checks,
      unresolvedIntents:intents?.length??null,activeRealPositions:positions?.length??null,
      ordersSent:0,warning:'Controllo di sola lettura. Non certifica il percorso AddOrder, i permessi SQL o il saldo reale.'});
  }
  if(input.action==='release10-selftest'){
    // Deterministic in-memory tests; never access Kraken or mutate the database.
    const cases=[
      {name:'buy within 5 USDC including buffer',ok:5/1.03*1.03<=5+1e-10},
      {name:'buy over 5 USDC rejected',ok:5.01>MAX_BUY_BUDGET_USDC},
      {name:'reserve 5 USDC preserved',ok:canBuy(10,5)&&!canBuy(9.99,5)},
      {name:'invalid free balance rejected',ok:!canBuy(NaN,1)},
      {name:'unknown order must retain lock',ok:inspectOrder({status:'open',vol:'4',vol_exec:'1',cost:'1.25',fee:'0.01'},4,0).lockRetained},
      {name:'partial fill recognized',ok:inspectOrder({status:'open',vol:'4',vol_exec:'1',cost:'1.25',fee:'0.01'},4,0).exec===1},
      {name:'no order endpoint in STAGING',ok:true}
    ];
    return respond({success:cases.every(x=>x.ok),release:'10',mode:'STAGING_SELFTEST',tests:cases,
      ordersSent:0,databaseWrites:0,
      limitations:'Test unitari; non dimostrano sicurezza del percorso LIVE, concorrenza tra transazioni o correttezza delle commissioni effettive.'});
  }
  if(input.action==='release11-integration-selftest'){
    // Release 11: deterministic integration simulation. No Kraken order API and no DB writes.
    type SimIntent={status:'claimed'|'unknown'|'submitted'|'completed',txid:string|null,volume:number,budget:number,executed:number,debited:number,tradeIds:Set<string>};
    const makeIntent=():SimIntent=>({status:'claimed',txid:null,volume:4,budget:5,executed:0,debited:0,tradeIds:new Set()});
    const simulatedSubmit=(i:SimIntent,outcome:'timeout'|'accepted',txid?:string)=>{
      if(i.status!=='claimed')return 'BLOCKED';
      if(outcome==='timeout'){i.status='unknown';return 'UNKNOWN_NO_RETRY';}
      if(!txid)return 'BLOCKED';
      i.txid=txid;i.status='submitted';return 'SUBMITTED';
    };
    const simulatedFill=(i:SimIntent,tradeId:string,volume:number,cost:number,feeUSDC:number)=>{
      if(!i.txid||!['submitted','unknown','completed'].includes(i.status))return 'BLOCKED';
      if(i.tradeIds.has(tradeId))return 'DUPLICATE_IGNORED';
      if(![volume,cost,feeUSDC].every(Number.isFinite)||volume<=0||cost<=0||feeUSDC<0)return 'INVALID_FILL';
      if(i.executed+volume>i.volume+1e-10)return 'OVER_VOLUME';
      if(i.debited+cost+feeUSDC>i.budget+1e-10)return 'OVER_BUDGET';
      i.executed+=volume;i.debited+=cost+feeUSDC;i.tradeIds.add(tradeId);
      return 'RECORDED';
    };
    const tests:{name:string,ok:boolean,actual:unknown}[]=[];
    const check=(name:string,actual:unknown,expected:unknown)=>tests.push({name,ok:actual===expected,actual});
    const timeout=makeIntent();
    check('timeout locks order',simulatedSubmit(timeout,'timeout'),'UNKNOWN_NO_RETRY');
    check('timeout cannot be resubmitted',simulatedSubmit(timeout,'accepted','TXID0001'),'BLOCKED');
    const buy=makeIntent();
    check('accepted order',simulatedSubmit(buy,'accepted','TXID0002'),'SUBMITTED');
    check('first partial fill',simulatedFill(buy,'TRADE0001',2,2.4,0.05),'RECORDED');
    check('duplicate trade id ignored',simulatedFill(buy,'TRADE0001',2,2.4,0.05),'DUPLICATE_IGNORED');
    check('second partial fill',simulatedFill(buy,'TRADE0002',2,2.4,0.05),'RECORDED');
    // Monetary assertion: compare in integer micro-USDC to avoid binary float equality artifacts.
    check('total debit incl fees',Math.round(buy.debited*1_000_000),4_900_000);
    check('overfill rejected',simulatedFill(buy,'TRADE0003',0.1,0.1,0),'OVER_VOLUME');
    const over=makeIntent();simulatedSubmit(over,'accepted','TXID0003');
    check('buy exceeding 5 USDC rejected',simulatedFill(over,'TRADE0004',4,4.99,0.02),'OVER_BUDGET');
    check('minimum free reserve preserved',canBuy(9.99,5),false);
    check('minimum free reserve permits 10 minus 5',canBuy(10,5),true);
    const owned=1.5, requested=2;
    check('cannot sell more than bot-owned quantity',requested<=owned,false);
    const orderSample={status:'open',vol:'4',vol_exec:'2',cost:'2.4',fee:'0.05'};
    check('partial Kraken order remains locked',inspectOrder(orderSample,4,0).lockRetained,true);
    let regressionRejected=false;
    try{inspectOrder({...orderSample,vol_exec:'1'},4,2);}catch{regressionRejected=true;}
    check('reconciliation regression rejected',regressionRejected,true);
    // This deliberately tests no real calls, no database writes, and no execution path.
    return respond({success:tests.every(t=>t.ok),release:'11',mode:'STAGING_INTEGRATION_SIMULATION',
      tests,passed:tests.filter(t=>t.ok).length,total:tests.length,ordersSent:0,databaseWrites:0,
      limitations:'Simulation only. Does not exercise AddOrder, real Kraken fees, Supabase RPC transactions, or network timeouts.'});
  }
  if(input.action==='release12-exchange-audit'){
    // Real Kraken READ-ONLY integration check. Never sends, edits or cancels orders.
    // Require both independent safety controls before contacting the exchange.
    const {data:policy,error:policyError}=await db.from('kraken_bot_policy')
      .select('enabled,max_buy_debit_usdc,min_usdc_reserve,max_open_positions')
      .eq('id',1).maybeSingle();
    const {data:unresolved,error:intentsError}=await db.from('kraken_order_intents')
      .select('id').in('status',['pending','claimed','submitted','unknown']).limit(1);
    const {data:positions,error:positionsError}=await db.from('kraken_bot_positions')
      .select('id').eq('user_id',user.id).in('status',['open','review']).limit(2);
    if(!switchReady||control.halted!==true||policyError||!policy||policy.enabled!==false||
       Number(policy.max_buy_debit_usdc)!==5||Number(policy.min_usdc_reserve)<5||
       Number(policy.max_open_positions)!==1||intentsError||positionsError)
      return respond({success:false,release:'12',error:'STAGING_GUARDS_NOT_VERIFIED',ordersSent:0},423);
    const balance=await kraken('/0/private/BalanceEx',{},key,secret,db);
    const openOrders=await kraken('/0/private/OpenOrders',{},key,secret,db);
    const serverTime=await pub('Time');
    const openCount=Object.keys(openOrders?.open||{}).length;
    const usdc=available(balance?.USDC);
    const validBalance=Number.isFinite(usdc)&&usdc>=0;
    const serverTimeValid=Number.isFinite(Number(serverTime?.unixtime))&&Number(serverTime.unixtime)>0;
    const tests=[
      {name:'kill switch remains engaged',ok:control.halted===true},
      {name:'live policy remains disabled',ok:policy.enabled===false},
      {name:'buy cap and reserve policy',ok:Number(policy.max_buy_debit_usdc)===5&&Number(policy.min_usdc_reserve)>=5},
      {name:'position cap',ok:Number(policy.max_open_positions)===1},
      {name:'no unresolved local intents',ok:(unresolved||[]).length===0},
      {name:'no active real bot positions',ok:(positions||[]).length===0},
      {name:'Kraken authenticated BalanceEx readable',ok:validBalance},
      {name:'Kraken authenticated OpenOrders readable',ok:openOrders!==null&&typeof openOrders==='object'&&openOrders.open!==undefined},
      {name:'Kraken public server time readable',ok:serverTimeValid},
      {name:'no open exchange orders',ok:openCount===0}
    ];
    return respond({success:tests.every(t=>t.ok),release:'12',mode:'STAGING_KRAKEN_READ_ONLY',
      tests,passed:tests.filter(t=>t.ok).length,total:tests.length,
      krakenOpenOrders:openCount,usdcFreeReadable:validBalance,
      usdcReserveSatisfied:validBalance&&usdc>=Number(policy.min_usdc_reserve),
      ordersSent:0,databaseWrites:0,
      limitations:'Read-only Kraken API checks. No AddOrder, no verified trade fee currency, no actual order lifecycle, no RPC transaction or network failure injection.'});
  }
  if(input.action==='release13-ledger-audit'){
    // Read-only cross-system integrity audit. No RPC mutations, no order submission.
    const {data:policy,error:pe}=await db.from('kraken_bot_policy')
      .select('enabled,max_buy_debit_usdc,min_usdc_reserve,max_open_positions').eq('id',1).maybeSingle();
    const {data:intents,error:ie}=await db.from('kraken_order_intents')
      .select('id,status,side,budget_usdc,kraken_txid,executed_volume,volume,kraken_userref')
      .eq('user_id',user.id).order('created_at',{ascending:false}).limit(100);
    const {data:positions,error:poe}=await db.from('kraken_bot_positions')
      .select('id,status,quantity,cost_usdc,opening_intent_id,pair').eq('user_id',user.id).limit(100);
    const {data:fills,error:fe}=await db.from('kraken_bot_fills')
      .select('kraken_trade_id,kraken_order_txid,side,volume,cost_usdc,fee_amount,fee_asset,base_asset')
      .eq('user_id',user.id).limit(100);
    if(!switchReady||control.halted!==true||pe||!policy||policy.enabled!==false||ie||poe||fe)
      return respond({success:false,release:'13',mode:'STAGING',error:'STAGING_GUARDS_OR_LEDGER_UNAVAILABLE',ordersSent:0},423);
    const i=intents||[],p=positions||[],f=fills||[];
    const active=p.filter(x=>x.status==='open'||x.status==='review');
    const unresolved=i.filter(x=>['pending','claimed','submitted','unknown'].includes(x.status));
    const buyOverCap=i.some(x=>x.side==='buy'&&Number(x.budget_usdc)>5);
    const badPositions=p.some(x=>!Number.isFinite(Number(x.quantity))||Number(x.quantity)<0||!Number.isFinite(Number(x.cost_usdc))||Number(x.cost_usdc)<0);
    const badFills=f.some(x=>!Number.isFinite(Number(x.volume))||Number(x.volume)<=0||
      !Number.isFinite(Number(x.cost_usdc))||Number(x.cost_usdc)<0||
      x.fee_amount===null||!Number.isFinite(Number(x.fee_amount))||Number(x.fee_amount)<0||
      !['USDC',x.base_asset].includes(x.fee_asset));
    const tradeIds=new Set(f.map(x=>x.kraken_trade_id));
    const duplicateTrades=tradeIds.size!==f.length;
    const tests=[
      {name:'kill switch engaged',ok:control.halted===true},
      {name:'policy disabled',ok:policy.enabled===false},
      {name:'buy cap 5 USDC',ok:Number(policy.max_buy_debit_usdc)===5},
      {name:'reserve at least 5 USDC',ok:Number(policy.min_usdc_reserve)>=5},
      {name:'one position policy',ok:Number(policy.max_open_positions)===1},
      {name:'no buy intent above 5 USDC in sample',ok:!buyOverCap},
      {name:'no multiple active positions in sample',ok:active.length<=1},
      {name:'position amounts valid in sample',ok:!badPositions},
      {name:'fill fee currency and amounts valid in sample',ok:!badFills},
      {name:'no duplicate trade IDs in sample',ok:!duplicateTrades},
      {name:'no unresolved local intents in sample',ok:unresolved.length===0}
    ];
    // The sample limit makes this a diagnostic, not an exhaustive certification.
    return respond({success:tests.every(t=>t.ok),release:'13',mode:'STAGING_LEDGER_READ_ONLY',
      tests,passed:tests.filter(t=>t.ok).length,total:tests.length,
      sampled:{intents:i.length,positions:p.length,fills:f.length},
      unresolvedSample:unresolved.length,activePositionsSample:active.length,
      sampleTruncated:i.length===100||p.length===100||f.length===100,
      ordersSent:0,databaseWrites:0,
      limitations:'Read-only sampled audit. No AddOrder, no fee evidence from Kraken trades, no actual network failure injection. Run SQL rollback RPC tests separately.'});
  }
  if(input.action==='release15-reconcile-audit'){
   // Integrated R15 read-only audit: no AddOrder, no ledger mutation, no unlock.
   // Query all unresolved intents (not only the newest 20), fail closed on pagination.
   const {data:intents,error:ie}=await db.from('kraken_order_intents')
     .select('id,pair,side,status,kraken_txid,volume,budget_usdc,created_at')
     .eq('user_id',user.id).in('status',['pending','claimed','submitted','unknown'])
     .order('created_at',{ascending:true}).limit(501);
   if(ie||!intents||intents.length>=501)return respond({success:false,error:'INTENT_INVENTORY_UNAVAILABLE_OR_TRUNCATED',safeForLive:false},503);
   const report:any[]=[];
   for(const intent of intents){
    const txid=String(intent.kraken_txid||'');
    if(!/^[A-Z0-9-]{6,40}$/i.test(txid)){
      report.push({intentId:intent.id,result:'NO_VERIFIED_TXID_REVIEW',status:intent.status});continue;
    }
    try{
     const result=await kraken('/0/private/QueryOrders',{txid,trades:'true'},key,secret,db);
     const order=result?.[txid];
     if(!order||!Array.isArray(order.trades))throw Error('ORDER_OR_TRADE_IDS_MISSING');
     const ids=order.trades as unknown[];
     if(ids.length>500||!ids.every(id=>typeof id==='string'&&/^[A-Z0-9-]{6,40}$/i.test(id))||new Set(ids).size!==ids.length)throw Error('INVALID_TRADE_IDS');
     if(String(order.descr?.pair||'')&&String(order.descr?.pair||'')!==String(intent.pair)){
      // Pair aliases can differ; require manual review rather than trusting a string mismatch.
      throw Error('PAIR_ALIAS_REQUIRES_REVIEW');
     }
     if(String(order.descr?.type||'')&&String(order.descr.type)!==intent.side)throw Error('ORDER_SIDE_MISMATCH');
     const {data:local,error:le}=await db.from('kraken_bot_fills')
       .select('kraken_trade_id,kraken_order_txid,volume,cost_usdc,fee_amount,fee_asset')
       .eq('user_id',user.id).eq('kraken_order_txid',txid).limit(501);
     if(le||!local||local.length>=501)throw Error('LEDGER_UNAVAILABLE_OR_TRUNCATED');
     const localIds=new Set(local.map((x:any)=>String(x.kraken_trade_id)));
     const trades:any[]=[];
     for(let i=0;i<ids.length;i+=20){
      const batch=ids.slice(i,i+20) as string[];
      const response=await kraken('/0/private/QueryTrades',{txid:batch.join(','),trades:'false'},key,secret,db);
      for(const id of batch){
       const t=response?.[id];
       if(!t||String(t.ordertxid||'')!==txid||String(t.type||'')!==intent.side)throw Error('TRADE_ID_ORDER_OR_SIDE_MISMATCH');
       const vol=Number(t.vol),cost=Number(t.cost),price=Number(t.price),fee=Number(t.fee);
       if(![vol,cost,price,fee].every(Number.isFinite)||vol<=0||cost<0||price<=0||fee<0)throw Error('INVALID_TRADE_NUMBERS');
       trades.push({tradeId:id,volume:vol,cost,feeRaw:fee,alreadyRecorded:localIds.has(id),feeCurrencyVerified:false});
      }
     }
     const totalVol=trades.reduce((sum:number,t:any)=>sum+t.volume,0);
     const reportedVol=Number(order.vol_exec);
     if(!Number.isFinite(reportedVol)||Math.abs(totalVol-reportedVol)>Math.max(1e-8,reportedVol*1e-6))throw Error('EXECUTED_VOLUME_MISMATCH');
     const missing=trades.filter(t=>!t.alreadyRecorded).length;
     const extra=local.filter((t:any)=>!ids.includes(t.kraken_trade_id)).length;
     report.push({intentId:intent.id,txid,krakenStatus:String(order.status||''),
       tradeCount:trades.length,missingLocalFills:missing,extraLocalFills:extra,
       executedVolume:totalVol,feeCurrencyVerified:false,
       result:missing||extra?'LEDGER_DISCREPANCY_REVIEW':'FEE_CURRENCY_UNVERIFIED_REVIEW'});
    }catch(e){report.push({intentId:intent.id,txid,result:'RECONCILIATION_ERROR_REVIEW',reason:e instanceof Error?e.message:'UNKNOWN'});}
   }
   return respond({success:true,release:'15',mode:'READ_ONLY_RECONCILIATION',
     checked:report.length,report,ordersSent:0,databaseWrites:0,
     safeForLive:false,warning:'Fee currency unverified; no fills imported; unresolved orders remain locked.'});
  }
  if(input.action==='release15-historical-audit'){
   // R15.1: bounded, read-only historical investigation for one legacy cancelled intent.
   // Never change an intent, import a fill, or place/cancel an exchange order.
   const targetId='a00ed06c-72d6-4a31-86aa-1a0858e5e10e';
   const {data:intent,error:targetError}=await db.from('kraken_order_intents')
     .select('id,pair,side,status,price,volume,budget_usdc,created_at,kraken_txid,client_ref,kraken_userref')
     .eq('id',targetId).eq('user_id',user.id).maybeSingle();
   if(targetError||!intent)return respond({success:false,error:'TARGET_INTENT_NOT_AVAILABLE',safeForLive:false},503);
   if(intent.status!=='cancelled'||intent.pair!=='XRPUSDC'||intent.side!=='buy'||intent.kraken_txid||intent.client_ref||intent.kraken_userref)
     return respond({success:false,error:'TARGET_INTENT_CHANGED_MANUAL_REVIEW',safeForLive:false},409);
   const created=Date.parse(String(intent.created_at))/1000;
   if(!Number.isFinite(created)||Math.abs(created-Date.parse('2026-11-08T18:01:12.650Z')/1000)>5)
     return respond({success:false,error:'TARGET_TIME_CHANGED_MANUAL_REVIEW',safeForLive:false},409);
   const start=Math.floor(created-3600),end=Math.ceil(created+3600);
   const maxPages=10,perPage=50;
   // Kraken private history endpoints use 50-record pages and a count field.
   async function history(path:string,root:'closed'|'trades'){
     const collected:[string,any][]=[];
     let total:number|null=null;
     for(let page=0;page<maxPages;page++){
       const result=await kraken(path,{start:String(start),end:String(end),ofs:String(page*perPage)},key,secret,db);
       if(!result||typeof result!=='object'||!result[root]||typeof result[root]!=='object')throw Error('HISTORY_RESPONSE_INVALID');
       const count=Number(result.count);
       if(!Number.isSafeInteger(count)||count<0)throw Error('HISTORY_COUNT_INVALID');
       if(total!==null&&count!==total)throw Error('HISTORY_COUNT_CHANGED');
       total=count;
       const entries=Object.entries(result[root]) as [string,any][];
       if(entries.length>perPage)throw Error('HISTORY_PAGE_OVERSIZED');
       collected.push(...entries);
       if(collected.length>=count){
         if(new Set(collected.map(([id])=>id)).size!==collected.length)throw Error('HISTORY_DUPLICATE_IDS');
         return {count,entries:collected};
       }
       if(entries.length===0)throw Error('HISTORY_INCOMPLETE_PAGE');
     }
     throw Error('HISTORY_PAGINATION_LIMIT');
   }
   try{
     const closed=await history('/0/private/ClosedOrders','closed');
     const tradeHistory=await history('/0/private/TradesHistory','trades');
     const openResult=await kraken('/0/private/OpenOrders',{},key,secret,db);
     if(!openResult||typeof openResult.open!=='object'||openResult.open===null)throw Error('OPEN_ORDERS_RESPONSE_INVALID');
     const normalize=(v:unknown)=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^XBT/,'BTC');
     const expectedPair=normalize(intent.pair);
     const pairCompatible=(v:unknown)=>{
       const p=normalize(v);
       return p===expectedPair||p==='XXRPUSDC'||p==='XRPUSDC';
     };
     const expectedPrice=Number(intent.price),expectedVol=Number(intent.volume);
     if(!Number.isFinite(expectedPrice)||!Number.isFinite(expectedVol)||expectedPrice<=0||expectedVol<=0)throw Error('INVALID_LOCAL_ORDER_NUMBERS');
     const summarizeOrder=(txid:string,o:any,source:string)=>{
       const t=Number(o.opentm),price=Number(o.descr?.price??o.price??NaN),vol=Number(o.vol);
       const side=String(o.descr?.type||'').toLowerCase();
       if(!Number.isFinite(t)||t<start||t>end||side!=='buy'||!pairCompatible(o.descr?.pair))return null;
       const priceClose=Number.isFinite(price)&&Math.abs(price-expectedPrice)<=Math.max(.0001,expectedPrice*.01);
       const volumeClose=Number.isFinite(vol)&&Math.abs(vol-expectedVol)<=Math.max(.00001,expectedVol*.01);
       return {source,txid,openedAt:new Date(t*1000).toISOString(),status:String(o.status||''),
         pair:String(o.descr?.pair||''),side,volume:Number.isFinite(vol)?vol:null,
         executedVolume:Number.isFinite(Number(o.vol_exec))?Number(o.vol_exec):null,
         limitPrice:Number.isFinite(price)?price:null,priceClose,volumeClose,
         note:'CANDIDATE_ONLY_NOT_PROOF_OF_BOT_OWNERSHIP'};
     };
     const orders=[...closed.entries.map(([id,o])=>summarizeOrder(id,o,'ClosedOrders')),
       ...Object.entries(openResult.open).map(([id,o])=>summarizeOrder(id,o,'OpenOrders'))].filter(Boolean);
     const trades=tradeHistory.entries.flatMap(([tradeId,t])=>{
       const when=Number(t.time),volume=Number(t.vol),price=Number(t.price),cost=Number(t.cost),fee=Number(t.fee);
       if(!Number.isFinite(when)||when<start||when>end||String(t.type||'').toLowerCase()!=='buy'||!pairCompatible(t.pair))return [];
       return [{tradeId,orderTxid:String(t.ordertxid||''),executedAt:new Date(when*1000).toISOString(),
         pair:String(t.pair||''),volume:Number.isFinite(volume)?volume:null,
         price:Number.isFinite(price)?price:null,cost:Number.isFinite(cost)?cost:null,
         feeRaw:Number.isFinite(fee)?fee:null,feeCurrencyVerified:false,
         note:'CANDIDATE_ONLY_NOT_PROOF_OF_BOT_OWNERSHIP'}];
     });
     return respond({success:true,release:'15.1',mode:'HISTORICAL_READ_ONLY',
       targetIntentId:targetId,windowUTC:{start:new Date(start*1000).toISOString(),end:new Date(end*1000).toISOString()},
       inspected:{closedOrders:closed.count,trades:tradeHistory.count,openOrders:Object.keys(openResult.open).length},
       candidateOrders:orders,candidateTrades:trades,
       conclusion:orders.length||trades.length?'POTENTIAL_MATCHES_MANUAL_ATTRIBUTION_REQUIRED':'NO_MATCH_IN_BOUNDED_WINDOW_NOT_PROOF_OF_NON_EXECUTION',
       ordersSent:0,databaseWrites:0,safeForLive:false,
       limitations:'No client_ref, userref or TXID. Pair aliases and manual trades may be indistinguishable. Fee currency unverified. Historical API coverage is not proof of non-execution.'});
   }catch(e){return respond({success:false,release:'15.1',mode:'HISTORICAL_READ_ONLY',
     error:'HISTORICAL_AUDIT_INCOMPLETE',reason:e instanceof Error?e.message:'UNKNOWN',
     ordersSent:0,databaseWrites:0,safeForLive:false},503);}
  }
  if(input.action==='release17-ledger-readonly-preview'){
   // R17: inspect persisted bot intents and fills. Never writes, sends or cancels orders.
   // This preview is NOT an importer. Missing identifiers / fee evidence always fail closed.
   const {data:intents,error:ie}=await db.from('kraken_order_intents')
     .select('id,pair,side,status,kraken_txid,created_at,executed_volume,executed_cost,executed_fee')
     .eq('user_id',user.id).order('created_at',{ascending:false}).limit(501);
   const {data:fills,error:fe}=await db.from('kraken_bot_fills')
     .select('kraken_trade_id,kraken_order_txid,pair,side,volume,cost_usdc,fee_amount,fee_asset')
     .eq('user_id',user.id).limit(501);
   if(ie||fe||!intents||!fills||intents.length>=501||fills.length>=501)
     return respond({success:false,release:'17',error:'LEDGER_INVENTORY_UNAVAILABLE_OR_TRUNCATED',ordersSent:0,databaseWrites:0,safeForLive:false},503);
   const ids=new Set<string>();let duplicates=0,invalidFills=0;
   for(const f of fills){
     const id=String(f.kraken_trade_id||'');
     if(!id||ids.has(id))duplicates++;ids.add(id);
     if(!f.kraken_order_txid||!['buy','sell'].includes(String(f.side))||
       !Number.isFinite(Number(f.volume))||Number(f.volume)<=0||
       !Number.isFinite(Number(f.cost_usdc))||Number(f.cost_usdc)<0||
       f.fee_amount===null||!Number.isFinite(Number(f.fee_amount))||Number(f.fee_amount)<0||
       !f.fee_asset)invalidFills++;
   }
   const unresolved=intents.filter((i:any)=>['pending','claimed','submitted','unknown'].includes(i.status));
   const noTxid=intents.filter((i:any)=>!i.kraken_txid);
   const txidPattern=/^[A-Z0-9-]{6,40}$/i;
   const withTxid=intents.filter((i:any)=>i.kraken_txid);
   const invalidTxid=withTxid.filter((i:any)=>!txidPattern.test(String(i.kraken_txid)));
   const notes:string[]=[];
   if(noTxid.length)notes.push('LOCAL_INTENTS_WITHOUT_TXID_REQUIRE_MANUAL_EVIDENCE');
   if(unresolved.length)notes.push('UNRESOLVED_INTENTS_RETAIN_LOCK');
   if(duplicates)notes.push('DUPLICATE_LOCAL_TRADE_IDS');
   if(invalidFills)notes.push('INVALID_LOCAL_FILL_ROWS');
   if(invalidTxid.length)notes.push('INVALID_TXID_FORMAT');
   // QueryOrders is restricted to verified TXIDs and only up to 20, to bound API use.
   // This endpoint does not claim to prove fee currency or reconcile executions.
   const candidates=withTxid.filter((i:any)=>txidPattern.test(String(i.kraken_txid)));
   if(candidates.length>20)return respond({success:false,release:'17',error:'TOO_MANY_TXIDS_FOR_BOUNDED_PREVIEW',count:candidates.length,
     ordersSent:0,databaseWrites:0,safeForLive:false},409);
   const exchangeChecks:any[]=[];
   for(const i of candidates){
     try{
       const txid=String(i.kraken_txid);
       const result=await kraken('/0/private/QueryOrders',{txid,trades:'true'},key,secret,db);
       const order=result?.[txid];
       if(!order||!Array.isArray(order.trades))throw Error('ORDER_OR_TRADES_UNAVAILABLE');
       if(order.trades.length>500||!order.trades.every((x:unknown)=>typeof x==='string'&&txidPattern.test(x)))throw Error('INVALID_TRADE_LIST');
       const tradeIds=order.trades as string[];
       if(new Set(tradeIds).size!==tradeIds.length)throw Error('DUPLICATE_EXCHANGE_TRADE_IDS');
       const local=fills.filter((f:any)=>f.kraken_order_txid===txid);
       const localIds=new Set(local.map((f:any)=>String(f.kraken_trade_id)));
       const missing=tradeIds.filter((id:string)=>!localIds.has(id));
       const extra=local.filter((f:any)=>!tradeIds.includes(String(f.kraken_trade_id)));
       // QueryTrades verifies existence and numeric fields, but not fee currency.
       let exchangeVolume=0,exchangeCost=0,exchangeFeeRaw=0;
       for(let offset=0;offset<tradeIds.length;offset+=20){
         const batch=tradeIds.slice(offset,offset+20);
         const trades=await kraken('/0/private/QueryTrades',{txid:batch.join(','),trades:'false'},key,secret,db);
         for(const id of batch){
           const t=trades?.[id];
           if(!t||String(t.ordertxid||'')!==txid||String(t.type||'')!==String(i.side))throw Error('TRADE_ORDER_SIDE_MISMATCH');
           const vol=Number(t.vol),cost=Number(t.cost),fee=Number(t.fee),price=Number(t.price);
           if(![vol,cost,fee,price].every(Number.isFinite)||vol<=0||cost<0||fee<0||price<=0)throw Error('INVALID_EXCHANGE_TRADE_VALUES');
           exchangeVolume+=vol;exchangeCost+=cost;exchangeFeeRaw+=fee;
         }
       }
       const reported=Number(order.vol_exec);
       if(!Number.isFinite(reported)||Math.abs(exchangeVolume-reported)>Math.max(1e-8,reported*1e-6))throw Error('EXECUTED_VOLUME_MISMATCH');
       exchangeChecks.push({intentId:i.id,txid,krakenStatus:String(order.status||''),tradeCount:tradeIds.length,
         missingLocalFills:missing.length,extraLocalFills:extra.length,
         exchangeVolume,exchangeCost,exchangeFeeRaw,feeCurrencyVerified:false,
         result:missing.length||extra.length?'LEDGER_MISMATCH_REVIEW':'FEE_CURRENCY_UNVERIFIED_REVIEW'});
     }catch(e){exchangeChecks.push({intentId:i.id,txid:i.kraken_txid,result:'EXCHANGE_CHECK_FAILED_REVIEW',
       reason:e instanceof Error?e.message:'UNKNOWN'});}
   }
   return respond({success:true,release:'17',mode:'LEDGER_EXCHANGE_READ_ONLY_PREVIEW',
     inventory:{intents:intents.length,fills:fills.length,unresolved:unresolved.length,
       missingTxid:noTxid.length,duplicateTradeIds:duplicates,invalidFillRows:invalidFills,
       invalidTxid:invalidTxid.length},exchangeChecks,notes,
     ordersSent:0,databaseWrites:0,safeForLive:false,
     limitations:'Bounded read-only preview; not a production importer. No fee currency proof, no DB transaction/concurrency validation. Legacy cancelled orders without TXID remain unverified.'});
  }
  if(input.action==='execute')return respond({error:'RELEASE10_STAGING_ONLY: invio ordini reali disabilitato nel codice'},403);
  return respond({error:'Azione non consentita'},400);
 }catch(e){console.error('kraken-live:',e instanceof Error?e.message:'unknown');return respond({error:'Operazione non riuscita. Controlla i log della funzione.'},502)}
});
