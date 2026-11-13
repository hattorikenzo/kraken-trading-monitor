# kraken-live — LIVE readiness contract (STAGING)

This document is a required contract, **not proof of deployment or certification**.
Never enable LIVE merely because the UI requests it or this file exists.

## Read-only endpoint

Authenticated POST /functions/v1/kraken-live with {"action":"certification-status"}.

Return success:true, mode:"STAGING", liveCertified:false until operational code,
deployed SQL RPC definitions, integration tests and reconciliation have all been verified.
Do not echo arbitrary user-supplied flags. Status must be computed server-side from
trusted deployment configuration and verified evidence, not a client payload.

Only after an independently reviewed release, the backend may report:
{"success":true,"mode":"LIVE","liveCertified":true,
 "manualConfirmationRequired":true,"spotOnly":true,
 "maxBuyDebitUSDC":5,"minLiquidReserveUSDC":5,"maxBotPositions":1,
 "operationalRpcVerified":true,"atomicReservationVerified":true,
 "feeInclusiveCapVerified":true}

The above is a response **schema example**, not an authorization token or a
configuration to paste into production.

## Required enforcement on preview AND execute

1. Authenticate Supabase JWT server-side; authorize user and account; reject
   anonymous/expired sessions. Use service role only inside the Edge Function.
2. Server-owned kill switch and policy: fail closed if missing, stale, halted,
   disabled, or certification evidence does not match deployed source/RPC hashes.
3. Spot limit orders only, no leverage, margin, borrowing or shorting.
4. Server computes pair, side, price, volume, notional, fees and slippage
   from fresh authoritative exchange data. Never trust browser budget or flags.
5. For BUY, atomically reserve the maximum **fee-inclusive** USDC debit <=5
   while retaining >=5 USDC genuinely available after all open orders and
   reservations. Lock ledger rows and enforce cross-request single-flight.
6. At most one bot-owned position; SELL may only dispose of verified bot-owned
   quantities. Protective SELL must not be blocked solely by low USDC reserve.
7. Bind preview to authenticated user, immutable normalized order parameters,
   short expiry, unique nonce and one-time intent. On execute, verify all
   constraints again, consume intent exactly once and reject replay or mutation.
8. Exchange AddOrder uses a server-only API key. Never expose Kraken secrets,
   nonce state, service-role keys or executable intent tokens to the browser.
9. Unknown/timeout/partial-fill state must halt further buys until reconciled
   against authoritative exchange orders/fills. No blind retry after ambiguous
   AddOrder responses. Idempotent fill accounting is required.
10. Log decisions and policy violations without secrets; maintain an emergency
    kill switch. Reject LIVE if fee schedule, balance, order state or RPC state
    cannot be verified.

## Mandatory evidence before enabling LIVE

- Export actual deployed kraken-live source or immutable source hash and inspect
  it; compare against reviewed source.
- Read-only export of deployed SQL definitions, grants, RLS and relevant
  triggers for kraken_bot_reserve_order, intent claim and fill recording.
- Disposable PostgreSQL concurrency tests plus mock Kraken transport end-to-end
  tests for over-budget, fee overflow, reserve, double-submit, partial fills,
  ambiguous timeout, stale balances, unauthorized user and owned-only sells.
- Confirm manual approval for each real order; no unattended LIVE execution.
- Explicit review and deployment of the server changes. Client-side
  certification-status checks are only defense in depth.

Current status: BLOCKED. Operational kraken-live source and deployed RPCs
have not been retrieved; no LIVE activation authorized by this document.
