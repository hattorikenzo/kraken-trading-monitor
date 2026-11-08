// Kraken v3.1 — Supabase authentication, read-only balance, trading connection check.
// No Kraken secrets or trading orders are sent from the browser.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

const $ = id => document.getElementById(id);
const set = (label, cls = 'neutral') => {
  $('authStatus').textContent = label;
  $('authStatus').className = 'pill ' + cls;
};
const msg = value => { $('authMessage').textContent = value; };
const form = $('authForm');
const check = $('authCheck');
const tradeCheck = $('tradeCheck');
const keyCheck = $('keyCheck');
const keyStatus = $('keyStatus');
const tradeStatus = $('tradeStatus');
const logout = $('authLogout');
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL) &&
  typeof SUPABASE_PUBLISHABLE_KEY === 'string' && SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_');

function showKeyStatus(value, cls = 'neutral') {
  if (!keyStatus) return;
  keyStatus.textContent = value;
  keyStatus.className = 'pill ' + cls;
}

function showTradeStatus(value, cls = 'neutral') {
  if (!tradeStatus) return;
  tradeStatus.textContent = value;
  tradeStatus.className = 'pill ' + cls;
}

if (!configured) {
  set('Configurazione mancante', 'down');
  msg('Controlla supabase-config.js (solo chiave pubblicabile).');
  form.hidden = true;
  if (tradeCheck) tradeCheck.hidden = true;
  if (keyCheck) keyCheck.hidden = true;
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

    async function show() {
      const { data: { session } } = await client.auth.getSession();
      const active = !!session;
      form.hidden = active;
      check.hidden = !active;
      logout.hidden = !active;
      if (tradeCheck) tradeCheck.hidden = !active;
      if (keyCheck) keyCheck.hidden = !active;
      if (!active) { showTradeStatus('Non verificata'); showKeyStatus('Non verificata'); }
      set(active ? 'Autenticato' : 'Non autenticato', active ? 'up' : 'neutral');
      msg(active
        ? 'Connesso a Supabase. Saldo in sola lettura; trading reale disabilitato.'
        : 'Accedi per leggere il saldo Kraken e verificare la connessione trading.');
      emit(active ? 'kraken-auth-ready' : 'kraken-auth-logout', {});
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

    check.addEventListener('click', async () => {
      check.disabled = true;
      try {
        const payload = await request('kraken-private', 'verify');
        if (payload.mode !== 'read-only') throw Error('Modalità non verificata');
        msg('Accesso privato verificato: sola lettura.');
        set('Accesso verificato', 'up');
      } catch (error) {
        set('Verifica fallita', 'down');
        msg(error instanceof Error ? error.message : 'Errore sconosciuto');
      } finally {
        check.disabled = false;
      }
    });

    if (tradeCheck) {
      tradeCheck.addEventListener('click', async () => {
        tradeCheck.disabled = true;
        showTradeStatus('Verifica in corso…');
        try {
          const payload = await request('kraken-trade', 'verify');
          if (payload.mode !== 'validation-only' || payload.executed !== false) {
            throw Error('La funzione non conferma la modalità sicura di sola validazione');
          }
          showTradeStatus('Connessione verificata', 'up');
          msg('kraken-trade raggiungibile e autenticata. Nessun ordine inviato a Kraken.');
        } catch (error) {
          showTradeStatus('Verifica fallita', 'down');
          msg(error instanceof Error ? error.message : 'Errore di verifica trading');
        } finally {
          tradeCheck.disabled = false;
        }
      });
    }

    if (keyCheck) {
      keyCheck.addEventListener('click', async () => {
        keyCheck.disabled = true;
        showKeyStatus('Verifica in corso…');
        try {
          const payload = await request('kraken-trade', 'check-key');
          if (payload.mode !== 'validation-only' || payload.executed !== false ||
              payload.keyVerified !== true || payload.krakenConnected !== true) {
            throw Error('Risposta di verifica della chiave non valida');
          }
          showKeyStatus('Chiave verificata', 'up');
          msg('Nuova chiave Kraken verificata con BalanceEx. Nessun ordine inviato.');
        } catch (error) {
          showKeyStatus('Verifica fallita', 'down');
          msg(error instanceof Error ? error.message : 'Errore verifica chiave');
        } finally {
          keyCheck.disabled = false;
        }
      });
    }

    logout.addEventListener('click' , async () => {
      await client.auth.signOut();
      await show();
    });

    client.auth.onAuthStateChange((_event, session) => {
      const active = !!session;
      form.hidden = active;
      check.hidden = !active;
      logout.hidden = !active;
      if (tradeCheck) tradeCheck.hidden = !active;
      if (keyCheck) keyCheck.hidden = !active;
      if (!active) {
        showTradeStatus('Non verificata');
        showKeyStatus('Non verificata');
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
