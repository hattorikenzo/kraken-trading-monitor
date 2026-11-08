// Kraken Trading Monitor v1.6 — autenticazione Supabase e saldo Kraken in sola lettura.
// Sostituire auth.js con il contenuto di questo file. Non inserire segreti nel browser.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

const el = id => document.getElementById(id);
const status = (value, cls = 'neutral') => {
  el('authStatus').textContent = value;
  el('authStatus').className = 'pill ' + cls;
};
const message = value => { el('authMessage').textContent = value; };
const form = el('authForm'), check = el('authCheck'), logout = el('authLogout');
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL) &&
  SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_');

// Interfaccia aggiunta senza alterare index.html o app.js.
const authPanel = document.querySelector('.auth-panel');
const balancePanel = document.createElement('section');
balancePanel.className = 'panel';
balancePanel.id = 'krakenRealBalancePanel';
balancePanel.hidden = true;
balancePanel.innerHTML = `
  <div class="heading"><h2>Saldo reale Kraken · sola lettura</h2><span id="krakenBalanceStatus" class="pill neutral">Non ancora letto</span></div>
  <p class="foot">Dati reali del conto Kraken. Separati dal portafoglio virtuale e dalle simulazioni. Nessun ordine viene inviato a Kraken.</p>
  <div class="actions"><button type="button" id="krakenReadBalance" class="secondary">Leggi saldo reale Kraken</button></div>
  <div id="krakenBalanceMessage" class="preview" role="status" aria-live="polite">Premi il pulsante per interrogare Kraken tramite la Edge Function protetta.</div>
  <div class="tablewrap" id="krakenBalanceTableWrap" hidden>
    <table><thead><tr><th>Asset Kraken</th><th>Quantità reale</th></tr></thead><tbody id="krakenBalanceRows"></tbody></table>
  </div>
  <p id="krakenBalanceTime" class="foot" hidden></p>`;
authPanel?.insertAdjacentElement('afterend', balancePanel);
const balanceButton = el('krakenReadBalance');
const balanceMessage = el('krakenBalanceMessage');
const balanceStatus = el('krakenBalanceStatus');
const balanceRows = el('krakenBalanceRows');
const balanceWrap = el('krakenBalanceTableWrap');
const balanceTime = el('krakenBalanceTime');
function balanceState(label, cls = 'neutral') {
  balanceStatus.textContent = label;
  balanceStatus.className = 'pill ' + cls;
}
function clearBalance() {
  balanceRows.replaceChildren();
  balanceWrap.hidden = true;
  balanceTime.hidden = true;
  balanceMessage.textContent = 'Premi il pulsante per interrogare Kraken tramite la Edge Function protetta.';
  balanceState('Non ancora letto');
}
function renderBalance(balances, timestamp) {
  balanceRows.replaceChildren();
  const entries = Object.entries(balances || {}).filter(([asset, amount]) =>
    typeof asset === 'string' && typeof amount === 'string' && /^\d+(?:\.\d+)?$/.test(amount) && Number(amount) > 0
  ).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    balanceWrap.hidden = true;
    balanceMessage.textContent = 'Kraken ha risposto correttamente, ma non risultano asset con saldo maggiore di zero.';
  } else {
    for (const [asset, amount] of entries) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      const value = document.createElement('td');
      name.textContent = asset;
      value.textContent = amount;
      tr.append(name, value);
      balanceRows.append(tr);
    }
    balanceWrap.hidden = false;
    balanceMessage.textContent = `Saldo reale ricevuto: ${entries.length} asset con quantità positiva. I codici asset sono quelli originali di Kraken.`;
  }
  const date = new Date(timestamp);
  balanceTime.textContent = Number.isNaN(date.getTime()) ? 'Lettura completata.' : 'Ultima lettura: ' + date.toLocaleString('it-IT');
  balanceTime.hidden = false;
  balanceState('Saldo letto', 'up');
}

if (!configured) {
  status('Configurazione mancante', 'down');
  message('Configura esclusivamente la Publishable Key in supabase-config.js. Non inserire chiavi private.');
  form.hidden = true;
} else {
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    async function privateRequest(action) {
      // getUser convalida la sessione; getSession recupera il token corrente.
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError || !userData.user) throw new Error('SESSION');
      const { data: { session }, error: sessionError } = await client.auth.getSession();
      if (sessionError || !session?.access_token) throw new Error('SESSION');
      const response = await fetch(SUPABASE_URL + '/functions/v1/kraken-private', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + session.access_token,
          'apikey': SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action }),
        cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      return { response, payload };
    }
    const show = async () => {
      const { data: { session }, error } = await client.auth.getSession();
      if (error) {
        status('Errore sessione', 'down');
        message('Impossibile leggere la sessione Supabase.');
        balancePanel.hidden = true;
        clearBalance();
        return;
      }
      form.hidden = !!session;
      check.hidden = !session;
      logout.hidden = !session;
      balancePanel.hidden = !session;
      if (!session) clearBalance();
      if (session?.user?.email) el('authEmail').value = session.user.email;
      status(session ? 'Sessione presente' : 'Non autenticato', session ? 'up' : 'neutral');
      message(session
        ? 'Connesso come ' + (session.user?.email || 'utente Supabase') + '. Premi «Verifica accesso privato» per controllare i permessi.'
        : 'Accedi con l’utente creato in Supabase Authentication → Users.');
    };
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = el('authLogin');
      button.disabled = true;
      status('Accesso in corso…');
      try {
        const { error } = await client.auth.signInWithPassword({
          email: el('authEmail').value.trim(),
          password: el('authPassword').value
        });
        el('authPassword').value = '';
        if (error) {
          status('Accesso non riuscito', 'down');
          message('Controlla email, password e conferma dell’utente.');
          return;
        }
        await show();
      } catch {
        status('Errore rete', 'down');
        message('Non è stato possibile raggiungere Supabase.');
      } finally {
        button.disabled = false;
      }
    });
    check.addEventListener('click', async () => {
      check.disabled = true;
      status('Verifica in corso…');
      try {
        const { response, payload } = await privateRequest('verify');
        if (response.ok && payload.success === true && payload.mode === 'read-only') {
          status('Utente autorizzato', 'up');
          message('Verifica riuscita: Edge Function accessibile al tuo account. Puoi leggere il saldo reale nella sezione sottostante.');
        } else {
          status('Verifica negata', 'down');
          message('Verifica fallita (HTTP ' + response.status + '). Controlla l’UID autorizzato e i log della Edge Function.');
        }
      } catch (error) {
        status('Errore connessione', 'down');
        message(error.message === 'SESSION' ? 'Sessione scaduta: esci ed effettua nuovamente l’accesso.' : 'Impossibile contattare la Edge Function.');
      } finally {
        check.disabled = false;
      }
    });
    balanceButton.addEventListener('click', async () => {
      balanceButton.disabled = true;
      clearBalance();
      balanceState('Lettura in corso…');
      balanceMessage.textContent = 'Richiesta autenticata inviata alla Edge Function…';
      try {
        const { response, payload } = await privateRequest('balance');
        if (response.ok && payload.success === true && payload.krakenConnected === true &&
            payload.balances && typeof payload.balances === 'object' && !Array.isArray(payload.balances)) {
          renderBalance(payload.balances, payload.timestamp);
        } else {
          balanceState('Lettura non riuscita', 'down');
          const safeError = typeof payload.error === 'string' ? payload.error : 'Risposta inattesa';
          balanceMessage.textContent = 'HTTP ' + response.status + ' — ' + safeError;
        }
      } catch (error) {
        balanceState('Errore connessione', 'down');
        balanceMessage.textContent = error.message === 'SESSION'
          ? 'Sessione scaduta: esci ed effettua nuovamente l’accesso.'
          : 'Impossibile contattare la Edge Function. Controlla la connessione.';
      } finally {
        balanceButton.disabled = false;
      }
    });
    logout.addEventListener('click', async () => {
      await client.auth.signOut();
      clearBalance();
      await show();
    });
    client.auth.onAuthStateChange((_event, session) => {
      // Evita chiamate Supabase asincrone dentro il callback di Auth.
      form.hidden = !!session;
      check.hidden = !session;
      logout.hidden = !session;
      balancePanel.hidden = !session;
      if (!session) clearBalance();
    });
    await show();
  } catch {
    status('Libreria non disponibile', 'down');
    message('Impossibile caricare Supabase JS. Verifica la connessione Internet.');
    form.hidden = true;
    balancePanel.hidden = true;
  }
}
