# Kraken LIVE certification status — 2026-11-13

## Decision
**LIVE NOT CERTIFIED — NO REAL ORDERS AUTHORIZED.** Keep `kraken_bot_control.halted=true`, `kraken_bot_policy.enabled=false`, `kraken-live` execute hard-block and `LIVE_RESERVATION_CERTIFIED=false`.

## Verified against operational Supabase
- `kraken-live` v38 deployed; `certification-status` returns `liveCertified:false`; `execute` hard-blocked.
- `kraken_bot_reserve_buy_v2`: 11 rollback functional tests and five balance boundary cases passed previously; advisory lock contested across two separate PostgreSQL backends (contender returned false).
- `kraken_record_verified_fill`: rollback SQL integration tests passed for two partial fills, overfill rejection, unsupported fee currency, duplicate idempotency, conflicting duplicate rejection, and fee-inclusive budget overrun.
- Production state after tests: halted=true, policy.enabled=false, intents=1 historical, active positions=0, fills=0. All test rows rolled back.

## Critical outstanding blockers
1. **Authenticated backend end-to-end**: no confirmed live HTTP invocation of preview → explicit one-time manual approval → execute with authenticated session and persistent, expiring approval.
2. **Pre-submit balance race**: no independently verified second BalanceEx read immediately before order submission and no atomicity across Kraken and Postgres.
3. **AddOrder uncertainty**: no certified no-retry path after timeout/unknown response, with durable intent and verified reconciliation before unlock.
4. **Actual exchange partial fills**: SQL fill behavior tested, but Kraken QueryOrders/QueryTrades fee-currency proof and integration into operational ledger are not certified.
5. **Sell path**: legacy reservation RPC is deliberately fail-closed and cannot be used for selling; a certified sell lifecycle remains absent.
6. **Rollback and concurrency**: advisory-lock exclusion verified, but simultaneous authenticated HTTP requests through Edge Function + exchange are not tested.
7. **Trading costs**: Kraken order minimums, actual fees and exchange behavior have not been validated by a controlled execution.

Manual user confirmation is necessary but not sufficient for safety. Never claim certified until all blockers are resolved with production-grade evidence. Do not remove kill switch for tests that could place orders.
