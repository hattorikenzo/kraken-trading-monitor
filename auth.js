// Kraken v3.1 — Supabase authentication, read-only balance, trading connection check.
// No Kraken secrets or trading orders are sent from the browser.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

const $ = id => document.getElementById(id);
// Fail closed until operational Supabase RPC + authoritative Kraken balance are certified.
// UI gating is supplementary: the kraken-live Edge Function must enforce the same policy.
const OPERATIONAL_LIVE_CERTIFIED = false;
const set = (label, cls = 'neutral') => {
  $('authStatus').textContent = label;
  $('authStatus').className = 'pill ' + cls;
};
const msg = value => { $('authMessage').textContent = value; };
const form = $('authForm');
const validateButton = null;
const validationResult = null;
const logout = $('authLogout');
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL) &&
  typeof SUPABASE_PUBLISHABLE_KEY === 'string' && SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_');

if (!configured) {
  set('Configurazione mancante', 'down');
  msg('Controlla supabase-config.js (solo chiave pubblicabile).');
  form.hidden = true;
  if (validateButton) validateButton.hidden = true;
} else {
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    async function request(functionName, action) {
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError || !userData.user) throw Error('Sessione Supabase non valida. Accedi nuovamente.');
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (sessionError || !token) throw Error('Sessione scaduta. Accedi nuovamente.');
      const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          apikey: SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action }),
        cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success !== true) {
        // Show only safe server error strings; never log tokens or credentials.
        const reason = typeof payload.error === 'string' ? payload.error : 'Richiesta non riuscita';
        throw Error(`${reason} (HTTP ${response.status})`);
      }
      return payload;
    }

    async function liveRequest(payload) {
      const {data:userData,error:userError}=await client.auth.getUser();
      if(userError||!userData.user)throw Error('Accedi nuovamente');
      const {data:{session}}=await client.auth.getSession();
      if(!session?.access_token)throw Error('Sessione scaduta');
      const r=await fetch(SUPABASE_URL+'/functions/v1/kraken-live',{
        method:'POST',headers:{Authorization:'Bearer '+session.access_token,apikey:SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},
        body:JSON.stringify(payload),cache:'no-store'
      });
      const j=await r.json().catch(()=>({}));
      if(!r.ok||j.success!==true)throw Error((j.error||'Richiesta non riuscita')+' (HTTP '+r.status+')');
      return j;
    }
    let pending=null;
    const prepare=$('prepareOrder'),confirm=$('confirmLive'),cancel=$('cancelLive'),details=$('liveDetails'),panel=$('liveConfirmation'),result=$('liveResult');
    if(prepare)prepare.addEventListener('click',async()=>{
      const choice=window.krakenSelectedOrder;
      if(!choice){result.textContent='Il bot segnala ATTENDI: nessun ordine idoneo.';return;}
      if(!OPERATIONAL_LIVE_CERTIFIED){result.textContent='LIVE BLOCCATO: protezioni Supabase operative non certificate.';return;}
      prepare.disabled=true;pending=null;panel.hidden=true;result.textContent='Controllo prezzo, saldo e validazione Kraken…';
      try{
        const p=await liveRequest({action:'preview',...choice});pending=p;
        details.textContent=`ORDINE REALE DA CONFERMARE\n${p.side.toUpperCase()} ${p.pair}\nPrezzo limite: ${p.price}\nQuantità: ${p.volume}\nControvalore: ${p.notionalUSDC} USDC\nScade: ${new Date(p.expiresAt).toLocaleTimeString('it-IT')}`;
        panel.hidden=false;result.textContent='Ordine validato, in attesa della tua conferma.';
      }catch(e){result.textContent='Preparazione fallita: '+e.message}
      finally{prepare.disabled=false}
    });
    window.krakenReadPortfolio=async()=>{const q=await liveRequest({action:'status'});emit('kraken-portfolio',{holdings:q.holdings||{},openCount:q.openCount,at:Date.now()});return q;};
    setInterval(()=>{if(!document.hidden)window.krakenReadPortfolio().catch(()=>{});},300000);
    const check=$('checkOrders');if(check)check.addEventListener('click',async()=>{check.disabled=true;$('ordersStatus').textContent='Lettura ordini…';try{const q=await liveRequest({action:'status'});emit('kraken-portfolio',{holdings:q.holdings||{},openCount:q.openCount,at:Date.now()});$('ordersStatus').textContent=`Ordini aperti: ${q.openCount}. Ultimi ordini del bot: ${q.intents.map(x=>x.side+' '+x.pair+' '+x.status+(x.txid?' '+x.txid:'')).join(' | ')||'nessuno'}. Controlla Kraken per le esecuzioni e gli eventuali parziali.`}catch(e){$('ordersStatus').textContent=e.message}finally{check.disabled=false}});
    if(cancel)cancel.onclick=()=>{pending=null;panel.hidden=true;result.textContent='Operazione annullata. Nessun ordine inviato.'};
    if(confirm)confirm.onclick=async()=>{
      if(!pending)return;
      if(!OPERATIONAL_LIVE_CERTIFIED){pending=null;panel.hidden=true;result.textContent='LIVE BLOCCATO: backend non certificato.';return;}
      const id=pending.id;pending=null;panel.hidden=true;confirm.disabled=true;
      result.textContent='Invio ordine reale in corso. NON ripetere la richiesta.';
      try{const p=await liveRequest({action:'execute',id});result.textContent='Ordine inviato a Kraken. TXID: '+(p.txid||[]).join(', ')+'. Controlla subito gli ordini aperti su Kraken.';}
      catch(e){result.textContent='ATTENZIONE: '+e.message+' Controlla gli ordini su Kraken prima di riprovare.'}
      finally{confirm.disabled=false;window.krakenReadBalance?.().catch(()=>{});}
    };

    async function show() {
      const { data: { session } } = await client.auth.getSession();
      const active = !!session;
      form.hidden = active;
      logout.hidden = !active;
      if (validateButton) validateButton.hidden = !active;
      if (!active && validationResult) validationResult.textContent = 'Nessun ordine validato.';
      set(active ? 'Autenticato' : 'Non autenticato', active ? 'up' : 'neutral');
      msg(active
        ? 'Connesso a Supabase. Ordini reali solo con conferma esplicita.'
        : 'Accedi per leggere il saldo Kraken e verificare la connessione trading.');
      emit(active ? 'kraken-auth-ready' : 'kraken-auth-logout', {});
      if(active)setTimeout(()=>window.krakenReadPortfolio?.().catch(()=>{}),1500);
    }

    window.krakenReadBalance = async () => {
      const payload = await request('kraken-private', 'balance');
      if (payload.krakenConnected !== true || !payload.balances ||
          typeof payload.balances !== 'object' || Array.isArray(payload.balances)) {
        throw Error('Saldo Kraken non disponibile');
      }
      emit('kraken-balance', { balances: payload.balances, timestamp: payload.timestamp });
      return payload;
    };

    form.addEventListener('submit', async event => {
      event.preventDefault();
      $('authLogin').disabled = true;
      try {
        const { error } = await client.auth.signInWithPassword({
          email: $('authEmail').value.trim(),
          password: $('authPassword').value
        });
        $('authPassword').value = '';
        if (error) throw error;
        await show();
      } catch {
        set('Accesso non riuscito', 'down');
        msg('Controlla email e password Supabase.');
      } finally {
        $('authLogin').disabled = false;
      }
    });

    if (validateButton) {
      validateButton.addEventListener('click', async () => {
        validateButton.disabled = true;
        if (validationResult) validationResult.textContent = 'Validazione in corso con Kraken…';
        try {
          const p = await request('kraken-trade', 'validate-demo');
          if (p.mode !== 'validation-only' || p.executed !== false || p.success !== true)
            throw Error('Risposta non sicura: impossibile confermare la sola validazione');
          if (validationResult) validationResult.textContent =
            `VALIDAZIONE RIUSCITA — NESSUN ACQUISTO\nMercato: ${p.pair}\nPrezzo limite: ${p.price} USDC\nQuantità: ${p.volume}\nImporto teorico: ${p.notionalUSDC} USDC\nSaldo disponibile: ${p.availableUSDC} USDC`;
        } catch (error) {
          if (validationResult) validationResult.textContent = 'Validazione non riuscita: ' +
            (error instanceof Error ? error.message : 'Errore sconosciuto');
        } finally { validateButton.disabled = false; }
      });
    }

    logout.addEventListener('click' , async () => {
      await client.auth.signOut();
      await show();
    });

    client.auth.onAuthStateChange((_event, session) => {
      const active = !!session;
      form.hidden = active;
      logout.hidden = !active;
      if (validateButton) validateButton.hidden = !active;
      if (!active) {
        emit('kraken-auth-logout', {});
      }
    });
    await show();
  } catch (error) {
    set('Errore Supabase', 'down');
    msg('Impossibile inizializzare la connessione Supabase.');
    console.error(error);
  }
}
