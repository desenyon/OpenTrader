# Anonymous trading and admin cleanup

November 15, 2026. Follow-up to administration commit `d2e9b57`.

## Behavior

- Signup includes an unchecked **Appear anonymous when trading** checkbox immediately after Handle. The saved preference survives pending approval, login and database restart. Existing accounts retain named trading by default.
- Peer-facing fills and rankings use a stable **Anonymous-XXXXXX** alias for each economy. Public anonymous ranking rows contain an opaque identity rather than an account UUID and omit the exact membership join timestamp. A private random seed is stored only on the server. Alias mapping is distinct between groups and Live.
- Account authentication, share ownership, ledger, settlement and resolver conflict checks retain real internal identities. Admin order/fill/position/payout reports retain real handles. Membership, comments and creator/resolver duties remain named; signup explicitly explains these limits. This is display anonymity, not protection against inference from a very small group or from information a user shares elsewhere.
- Admin actions no longer require an explanation. New UI requests omit reason; old clients may supply an optional legacy reason. Automatic actor/action/target/prior-state records, balanced credit accounting and idempotency remain intact. No audit records were rewritten.
- The admin dashboard has five main sections: Accounts, Activity, Economy, Markets and History. Activity and Economy have compact subviews. Trading control is in the heading, repeated explanatory banners are removed, confirmations have no reason field, and pending requests use an exact account-status filter rather than a broad text search.

## Verification

- `npm test`: **152 passing tests in 20 files**, 38.69 seconds. Six new tests cover reason-free authorized/idempotent adjustments, anonymous signup and approval, peer identity projection versus operator attribution, membership-order privacy, restart persistence and exact pending-account filtering.
- Three initial regressions failed before implementation for the expected missing reason-free action and anonymous preference/projection behavior. A fresh reviewer then reproduced a further privacy leak: tied rankings retained named membership order. A failing regression reversed only fixture membership enumeration; the fixed ranking breaks ties with opaque public identity and now passes.
- `npm run build`: TypeScript, Vite, server and admin CLI passed. Initial JS **323.26 kB raw / 98.61 kB gzip**; lazy admin JS **14.51 kB raw / 4.70 kB gzip**, admin CSS **6.21 kB raw / 1.56 kB gzip**. No dependency was added.
- `npm run test:production`: passed executable startup, compressed assets, hosted source gate, anonymous signup, reason-free admin approval, persistence of the signup preference, independent wallets, operator reports and reconciliation using a disposable database.
- The local production preview was restarted at `http://127.0.0.1:3000` after a consistent database backup. Existing admin credentials were preserved.

No fresh browser interaction or screenshot is claimed for this change. UI code was typechecked and packaged; backend behavior was verified through actual Store and HTTP integration tests. Existing single-host, binary-market and provider-data permission boundaries remain in the README.
