# Admin cleanup and anonymous trading

Goal: remove required admin explanations, simplify navigation/actions, and let new users hide their trading name.

Decisions: retain automatic actor/action/target/balance audit records. Reasons are optional legacy input, absent from new UI and new requests. Dashboard uses Accounts, Activity, Economy, Markets and History; Activity/Economy have compact filters. Signup checkbox appears immediately after handle. Anonymous trading masks peer-visible fills and rankings with a stable alias per economy, with an unpredictable stored seed and no real account IDs or exact join timestamp in anonymous ranking rows. Admin reports keep true identities. Membership, comments and governance roles remain named, explicitly disclosed in signup copy. Defaults preserve existing accounts and economics.

- [x] Failing HTTP regression for admin actions without reasons; remove UI/API/store requirement and simplify controls.
- [x] Failing tests for signup preference persistence and anonymous peer-facing fills/rankings; implement projection, preserving real internal identities.
- [x] Run full suite, build, production smoke, independent review; update local preview and document tested scope.

Review ruling: Equal-value leaderboard rows use opaque public identity as their tie breaker. Membership enumeration order must not identify anonymous aliases. A failing-before/passing-after fixture reverses membership enumeration without changing balances or identities.
