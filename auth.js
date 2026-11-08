// Kraken Trading Monitor v1.5 - solo autenticazione e verifica read-only.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';
const el = id => document.getElementById(id);
const status = (message, cls='neutral') => { el('authStatus').textContent=message; el('authStatus').className='pill '+cls; };
const message = value => { el('authMessage').textContent=value; };
const form=el('authForm'), check=el('authCheck'), logout=el('authLogout');
const configured=/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL) && SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_');
if (!configured) { status('Configurazione mancante','down'); message('Apri supabase-config.js su GitHub e inserisci esclusivamente la Publishable key di Supabase. Non inserire chiavi private.'); form.hidden=true; }
else {
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const client=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    const show = async () => {
      const {data:{session},error}=await client.auth.getSession();
      if(error) {status('Errore sessione','down');message('Impossibile leggere la sessione Supabase.');return;}
      form.hidden=!!session; check.hidden=!session;logout.hidden=!session;
      status(session?'Sessione presente':'Non autenticato',session?'up':'neutral');
      message(session?'Sessione Supabase presente. Premi «Verifica accesso privato» per controllare il permesso sul server.':'Accedi con l’utente creato in Supabase. Nessuna password viene inviata al sito GitHub: il login avviene tramite Supabase Auth.');
    };
    form.addEventListener('submit',async ev=>{
      ev.preventDefault();const btn=el('authLogin');btn.disabled=true;status('Accesso in corso…');
      try {
        const {error}=await client.auth.signInWithPassword({email:el('authEmail').value.trim(),password:el('authPassword').value});
        el('authPassword').value='';
        if(error){status('Accesso non riuscito','down');message('Accesso non riuscito. Controlla email, password e conferma dell’utente.');return;}
        await show();
      } catch {status('Errore rete','down');message('Non è stato possibile raggiungere Supabase.');}
      finally {btn.disabled=false;}
    });
    check.addEventListener('click',async()=>{
      check.disabled=true;status('Verifica in corso…');
      try {
        const {data:{session}}=await client.auth.getSession();
        if(!session){await show();return;}
        const res=await fetch(SUPABASE_URL+'/functions/v1/kraken-private',{method:'POST',headers:{'Authorization':'Bearer '+session.access_token,'apikey':SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:'{}',cache:'no-store'});
        const body=await res.json().catch(()=>({}));
        if(res.ok && body.success===true && body.mode==='read-only'){status('Utente autorizzato','up');message('Verifica riuscita: Edge Function accessibile al tuo account. Saldo Kraken non ancora collegato.');}
        else {status('Verifica negata','down');message('La Edge Function ha risposto HTTP '+res.status+'. Controlla UID autorizzato e impostazione Verify JWT.');}
      } catch {status('Errore connessione','down');message('Impossibile contattare la Edge Function. Controlla rete e configurazione CORS.');}
      finally {check.disabled=false;}
    });
    logout.addEventListener('click',async()=>{await client.auth.signOut();await show();});
    client.auth.onAuthStateChange(()=>{void show();});
    await show();
  } catch {status('Libreria non disponibile','down');message('Impossibile caricare Supabase JS. Verifica connessione Internet o blocchi del browser.');form.hidden=true;}
}
