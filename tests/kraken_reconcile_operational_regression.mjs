import assert from 'node:assert/strict';
// Mirrors kraken-live inspectOrder; no Kraken HTTP, no real orders.
function inspectOrder(info,expectedVolume,previousExecuted){
 const status=String(info?.status||'').toLowerCase();
 if(!['pending','open','closed','canceled','expired'].includes(status))throw Error('Stato Kraken non riconosciuto');
 const vol=Number(info.vol),exec=Number(info.vol_exec),cost=Number(info.cost),fee=Number(info.fee);
 if(![vol,exec,cost,fee,expectedVolume,previousExecuted].every(Number.isFinite)||vol<=0||exec<0||exec>vol+1e-8||cost<0||fee<0||previousExecuted<0)throw Error('Valori di esecuzione non validi');
 if(!(expectedVolume>0)||Math.abs(expectedVolume-vol)>Math.max(1e-8,expectedVolume*1e-6))throw Error('Volume Kraken non coincide con registro locale');
 if(exec+1e-8<previousExecuted)throw Error('Volume eseguito inferiore a quello già registrato');
 const note=status==='open'&&exec>0?'Parzialmente eseguito; ordine ancora aperto':status==='closed'?'Ordine chiuso da Kraken; revisione manuale necessaria prima di nuovi acquisti':['canceled','expired'].includes(status)?'Ordine terminato; controllare esecuzione parziale e commissioni':'Ordine ancora non definitivo';
 return {status,exec,cost,fee,note,lockRetained:true};
}
let count=0;
const good={status:'open',vol:'4',vol_exec:'2',cost:'2.4',fee:'.05'};
function test(name,fn){fn();count++;console.log('PASS',name)}
test('partial fill lock retained',()=>assert.equal(inspectOrder(good,4,0).lockRetained,true));
test('repeated partial fill remains locked',()=>assert.equal(inspectOrder(good,4,2).exec,2));
test('missing response rejected',()=>assert.throws(()=>inspectOrder(null,4,0)));
test('unknown status rejected',()=>assert.throws(()=>inspectOrder({...good,status:'unknown'},4,0)));
test('volume mismatch rejected',()=>assert.throws(()=>inspectOrder({...good,vol:'5'},4,0)));
test('executed volume regression rejected',()=>assert.throws(()=>inspectOrder({...good,vol_exec:'1'},4,2)));
test('overfill rejected',()=>assert.throws(()=>inspectOrder({...good,vol_exec:'5'},4,0)));
test('negative fee rejected',()=>assert.throws(()=>inspectOrder({...good,fee:'-1'},4,0)));
test('NaN cost rejected',()=>assert.throws(()=>inspectOrder({...good,cost:'NaN'},4,0)));
test('closed order still locked',()=>assert.equal(inspectOrder({...good,status:'closed',vol_exec:'4'},4,2).lockRetained,true));
test('canceled partially filled order still locked',()=>assert.equal(inspectOrder({...good,status:'canceled'},4,2).lockRetained,true));
test('expired order still locked',()=>assert.equal(inspectOrder({...good,status:'expired'},4,2).lockRetained,true));
console.log(JSON.stringify({passed:count,total:12,realOrders:0,mode:'STAGING_MOCK'}));
