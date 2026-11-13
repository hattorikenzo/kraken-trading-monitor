// STAGING only: fault-injection model of Kraken timeout and partial-fill reconciliation.
// No Kraken credentials, no HTTP calls, no database writes, no live orders.
import assert from 'node:assert/strict';
const tests=[];
function check(name,fn){fn();tests.push(name)}
class Store {
 constructor(snapshot){this.intents=snapshot?.intents||[];this.fills=snapshot?.fills||[];this.positions=snapshot?.positions||[]}
 snapshot(){return JSON.parse(JSON.stringify({intents:this.intents,fills:this.fills,positions:this.positions}))}
 reserve(ref){if(this.intents.some(x=>['pending','claimed','unknown','submitted'].includes(x.status))||this.positions.some(x=>x.status==='open'))throw Error('ORDER_ALREADY_IN_PROGRESS');if(this.intents.some(x=>x.ref===ref))throw Error('DUPLICATE_CLIENT_REFERENCE');this.intents.push({ref,status:'claimed',txid:null,volume:4,executed:0,debit:0})}
 timeout(ref){const x=this.intents.find(x=>x.ref===ref);assert.equal(x.status,'claimed');x.status='unknown'}
 reconcile(ref,reply){const x=this.intents.find(x=>x.ref===ref);if(!reply||!reply.txid){assert.equal(x.status,'unknown');return 'NEEDS_MANUAL_REVIEW'}if(x.txid&&x.txid!==reply.txid)throw Error('TXID_CONFLICT');x.txid=reply.txid;x.status='submitted';return 'LOCK_RETAINED'}
 fill(ref,tradeId,volume,cost,fee){const x=this.intents.find(x=>x.ref===ref);if(!x.txid)throw Error('UNVERIFIED_TXID');const old=this.fills.find(f=>f.tradeId===tradeId);if(old){if(old.ref!==ref||old.volume!==volume||old.cost!==cost||old.fee!==fee)throw Error('CONFLICTING_DUPLICATE');return 'ALREADY_RECORDED'}if(x.executed+volume>x.volume+1e-10)throw Error('OVERFILL');if(x.debit+cost+fee>5+1e-10)throw Error('BUDGET_EXCEEDED');x.executed+=volume;x.debit+=cost+fee;this.fills.push({ref,tradeId,volume,cost,fee});let pos=this.positions.find(p=>p.ref===ref);if(!pos)this.positions.push(pos={ref,status:'open',quantity:0});pos.quantity+=volume;return 'RECORDED'}
}
let s=new Store();
check('first reservation',()=>{s.reserve('ref1');assert.equal(s.intents[0].status,'claimed')});
check('timeout is persisted as unknown',()=>{s.timeout('ref1');assert.equal(s.intents[0].status,'unknown')});
check('timeout blocks retry',()=>assert.throws(()=>s.reserve('ref2'),/ORDER_ALREADY_IN_PROGRESS/));
s=new Store(s.snapshot());
check('restart retains unknown lock',()=>assert.throws(()=>s.reserve('ref3'),/ORDER_ALREADY_IN_PROGRESS/));
check('missing txid cannot unlock',()=>assert.equal(s.reconcile('ref1',null),'NEEDS_MANUAL_REVIEW'));
check('verified txid retains lock',()=>assert.equal(s.reconcile('ref1',{txid:'SIMTX-001'}),'LOCK_RETAINED'));
check('first partial fill',()=>assert.equal(s.fill('ref1','trade1',2,2.4,.05),'RECORDED'));
s=new Store(s.snapshot());
check('restart retains partial fill',()=>assert.equal(s.positions[0].quantity,2));
check('partial fill blocks another buy',()=>assert.throws(()=>s.reserve('ref4'),/ORDER_ALREADY_IN_PROGRESS/));
check('duplicate trade id idempotent',()=>assert.equal(s.fill('ref1','trade1',2,2.4,.05),'ALREADY_RECORDED'));
check('conflicting duplicate rejected',()=>assert.throws(()=>s.fill('ref1','trade1',1,1,.02),/CONFLICTING_DUPLICATE/));
check('second partial fill',()=>assert.equal(s.fill('ref1','trade2',2,2.4,.05),'RECORDED'));
check('aggregated volume correct',()=>assert.equal(s.positions[0].quantity,4));
check('overfill rejected',()=>assert.throws(()=>s.fill('ref1','trade3',.1,.1,.01),/OVERFILL/));
check('completed order still blocked by position',()=>{s.intents[0].status='completed';assert.throws(()=>s.reserve('ref5'),/ORDER_ALREADY_IN_PROGRESS/)});
console.log(JSON.stringify({mode:'STAGING_FAULT_INJECTION',passed:tests.length,total:tests.length,ordersSent:0,tests},null,2));

// CI rerun: validate persistent-snapshot safety invariants on every STAGING change.
