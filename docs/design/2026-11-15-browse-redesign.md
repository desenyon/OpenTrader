# OpenTrader: browse first

The user rejected the terminal as difficult to understand and requested a Kalshi-like market experience using restrained existing visual materials. This direction supersedes the November 13 terminal reference.

Product: private and public-source prediction markets using fictional credits.
Character: calm, readable, direct.
World: questions, evidence and public-event forecasts.
Moments: readable market probabilities and an actual market-history line.
Signature: a question leads to two explicit outcome choices; play credits stay clearly labeled.

## Audit and changes

- Landing on a preselected chart forced people to learn a terminal before choosing a question. Replace it with a market grid and persistent search.
- Tiny text, ticker strips, letter tiles and chart tools competed with the question. Remove them; use readable questions, a probability and outcome buttons.
- Separate browsing, question detail and portfolio using shareable hash URLs and browser back/forward.
- Keep Live/Friends adjacent with distinct server-authoritative wallet scope. Resolve cross-scope notification links using actual market metadata.
- Only show categories with available content. Preserve upstream question text and source images; do not fabricate odds, histories, news or recommendations.
- Show the prediction form only on a question. Put limit options behind a disclosure, keep protected quote review and confirmation, and expose Sell after holdings exist.
- Replace the chart rail/candles/OHLC/indicator controls with a focused probability line and period selection. Retain distinct Friends probability/executed-price history.
- Give mobile users named Markets/Portfolio/Groups navigation and a sticky prediction action on detail pages.
- Replace the old CSS rather than layering another terminal override stylesheet. Use system/local fonts, a graphite ramp, semantic outcome colors, a 4px spacing rhythm and 12–18px secondary/body text.
- Load the chart library on demand. Reduce the initial JS from approximately 498 kB to 320 kB raw and stylesheet from approximately 61 kB to 37 kB raw, without new runtime dependencies.

Existing order execution, accounting, permission checks and provider gates remain authoritative. Unslop by Damir Sokolovsky informed the refinement process; attribution is in THIRD_PARTY_NOTICES.md.
