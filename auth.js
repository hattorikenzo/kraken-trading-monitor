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
const validateButton = $('validateOrder');
const validationResult = $('validationResult');
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

    async function show() {
      const { data: { session } } = await client.auth.getSession();
      const active = !!session;
      form.hidden = active;
      logout.hidden = !active;
      if (validateButton) validateButton.hidden = !active;
      if (!active && validationResult) validationResult.textContent = 'Nessun ordine validato.';
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
