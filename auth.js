// Kraken v3 — sessione Supabase, sola lettura. Nessuna credenziale Kraken nel browser.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';
const $=id=>document.getElementById(id);
const set=(label,cls='neutral')=>{$('authStatus').textContent=label;$('authStatus').className='pill '+cls};
const msg=s=>$('authMessage').textContent=s;
const form=$('authForm'),check=$('authCheck'),logout=$('authLogout');
const emit=(name,detail)=>window.dispatchEvent(new CustomEvent(name,{detail}));
const configured=/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL)&&typeof SUPABASE_PUBLISHABLE_KEY==='string'&&SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_');
if(!configured){set('Configurazione mancante','down');msg('Controlla supabase-config.js (solo chiave pubblicabile).');form.hidden=true;}
else try{
 const {createClient}=await import('https://esm.sh/@supabase/supabase-js@2');
 const client=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
 async function request(action){
  const {data:u,error:ue}=await client.auth.getUser();if(ue||!u.user)throw Error('Sessione non valida');
  const {data:{session},error:se}=await client.auth.getSession();if(se||!session?.access_token)throw Error('Sessione scaduta');
  const r=await fetch(SUPABASE_URL+'/functions/v1/kraken-private',{method:'POST',headers:{Authorization:'Bearer '+session.access_token,apikey:SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify({action}),cache:'no-store'});
  const p=await r.json().catch(()=>({}));if(!r.ok||p.success!==true)throw Error('Richiesta Kraken fallita (HTTP '+r.status+')');return p;
 }
 async function show(){const {data:{session}}=await client.auth.getSession();const active=!!session;form.hidden=active;check.hidden=!active;logout.hidden=!active;set(active?'Autenticato':'Non autenticato',active?'up':'neutral');msg(active?'Connesso a Supabase. Lettura del saldo Kraken in sola lettura.':'Accedi per leggere il saldo Kraken.');if(active)emit('kraken-auth-ready',{});else emit('kraken-auth-logout',{});}
 window.krakenReadBalance=async()=>{const p=await request('balance');if(p.krakenConnected!==true||!p.balances||typeof p.balances!=='object'||Array.isArray(p.balances))throw Error('Saldo Kraken non disponibile');emit('kraken-balance',{balances:p.balances,timestamp:p.timestamp});return p;};
 form.addEventListener('submit',async e=>{e.preventDefault();$('authLogin').disabled=true;try{const {error}=await client.auth.signInWithPassword({email:$('authEmail').value.trim(),password:$('authPassword').value});$('authPassword').value='';if(error)throw error;await show();}catch{set('Accesso non riuscito','down');msg('Controlla email e password Supabase.');}finally{$('authLogin').disabled=false;}});
 check.onclick=async()=>{check.disabled=true;try{const p=await request('verify');if(p.mode!=='read-only')throw Error('Modalità non verificata');msg('Accesso privato verificato: sola lettura.');set('Accesso verificato','up')}catch(e){set('Verifica fallita','down');msg(e.message)}finally{check.disabled=false}};
 logout.onclick=async()=>{await client.auth.signOut();await show()};
 client.auth.onAuthStateChange((_event,session)=>{form.hidden=!!session;check.hidden=!session;logout.hidden=!session;if(!session)emit('kraken-auth-logout',{})});
 await show();
}catch(e){set('Errore Supabase','down');msg('Impossibile inizializzare la connessione Supabase.');console.error(e)}
