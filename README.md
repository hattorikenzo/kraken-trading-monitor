# Kraken Trading Monitor — GitHub Pages (base v1.3)

Questa distribuzione prepara per GitHub Pages l'app v1.3 fornita dall'utente. Non contiene nuove funzionalità di trading reale né accesso al saldo privato.

## Pubblicazione
1. Crea un repository GitHub (es. `kraken-trading-monitor`), preferibilmente privato finché non hai verificato i contenuti.
2. Carica nella radice del repository `index.html`, `app.js`, `style.css`, `.nojekyll` e la cartella `.github/workflows/pages.yml` (per preservare le cartelle nascoste è più semplice usare Git sul PC).
3. Imposta il branch predefinito `main`.
4. In Settings > Pages > Build and deployment scegli **GitHub Actions**.
5. Vai in Actions e avvia `Pubblica Kraken Trading Monitor` se non è già partito automaticamente.
6. Attendi il completamento e apri l'URL mostrato in Settings > Pages.

## Sicurezza
- NON caricare API Key, API Secret, file `.env`, esportazioni di account o screenshot con credenziali.
- NON inserire segreti nel JavaScript frontend, né in GitHub Pages né nei repository privati: il browser li esporrebbe.
- Per saldo e storico privati servirà un backend autenticato separato, non incluso in questa versione.
- Il frontend legge soltanto API pubbliche Kraken; acquisti/vendite sono simulati.
- Le simulazioni e impostazioni locali del browser non sono sincronizzate fra PC o domini.
- I segnali non costituiscono garanzia di rendimento; la strategia non è stata validata per trading reale.

## Controlli
Apri `index.html` in Chrome oppure la pagina pubblicata. Verifica che arrivino i prezzi e lo storico. Se l'API Kraken blocca le richieste dal browser, comparirà uno stato di errore.
