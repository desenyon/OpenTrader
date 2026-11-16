# Admin and economy audit

Implement platform administration without changing the approved market-browsing design.

- [x] Regress and fix escrow precision and over-owned sell preview.
- [x] Pending public registrations; approval allocates exactly once; suspension cancels orders and preserves holdings.
- [x] CLI-created platform admin, server-enforced authorization and last-admin protection.
- [x] Paginated account, wallet, trade, settlement, market and immutable operator audit views.
- [x] Reasoned, idempotent ledger adjustments to available wallet/treasury funds; exclude adjustments from trading returns.
- [x] Persisted trading pause; reconciliation visibility; dashboard navigation and account-status UI.
- [x] Integration tests, full checks, production smoke, independent review and actual local admin provisioning.

Existing accounts remain approved users. No first-registrant admin, public role escalation, raw balance edits or shared wallet balances. Credits remain fictional and nonredeemable. Suspension cannot erase settled or outstanding economic records. Account approval and all operator actions are transactional and audited. Admin creation is a local operator CLI; generated credentials go to an ignored mode-0600 file.
