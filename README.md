# Wisora

Smarter purchasing decisions, backed by evidence. Describe what you want in
natural language; Wisora detects the category, searches configured Indian
shopping sources, compares real options, and gives a reasoned BUY / WAIT /
AVOID recommendation with traceable links. It never invents products, prices,
or reviews.

Status: Phase 4 complete — personalization and user memory on top of
the Phase 3 decision engine: saved general and per-category preferences,
personalized scoring with attribution, decision history, feedback, and
user-approved suggestions.

## How it works

1. You describe a need by typing or voice input (Chrome/Edge), e.g. "Find a laptop under ₹90,000 for .NET development."
2. Muse interprets the request (category, budget range, search terms) with
   validated, schema-checked output; deterministic rules fill any gaps and
   take over fully when no API key is configured. Wisora then extracts
   requirements — must-haves, nice-to-haves, and explicit exclusions — and
   asks at most two clarification questions when something material is
   ambiguous.
3. You answer any clarification questions, then correct the category and
   toggle shopping sources if needed. Product search stays disabled until
   requirement understanding is complete.
4. One search fans out to the enabled sources through a domain-restricted
   search API; results are normalized, attributed, deduplicated, and enriched
   with prices, review ratings, and product photos seen on retailer pages.
5. Options that violate the budget, a mandatory requirement, or an
   exclusion are filtered out with stated reasons. Survivors are scored on
   four weighted dimensions (price fit, relevance, evidence, preferences);
   Muse proposes a verdict, which is then validated against hard rules
   (budget vetoes, grounded product references, no invented prices, no
   sale-prediction waits).
6. Once the recommendation is ready, you get the top 5 picks as product
   cards with score breakdowns and per-requirement checks, side-by-side
   comparison (including review ratings), an excluded-options panel, an
   evidence-confidence meter, and a verdict panel with reasons, trade-offs,
   and uncertainties. Scoring weights are adjustable without re-searching.
7. Optionally, "Get review insights" searches configured review sources for
   the top 3 picks, extracts recurring strengths and concerns with cited
   sources, grades evidence quality, and shows bounded score adjustments
   (+5/−8 max) with rank-impact notes. Single-source findings stay
   preliminary; contradictions add uncertainty instead of points.
8. Signed-in users can save general and per-category preferences (brands,
   budgets, priorities) from Preferences; future recommendations apply
   them with a full attribution report, and each search can opt out once
   via "Use my saved preferences". Decisions can be saved, recommendations
   rated, and inferred suggestions confirmed, edited, or dismissed from
   the Suggestions inbox. All saved data is reviewable and clearable from
   Preferences.

## Stack

- Next.js 16 (App Router, webpack build) + TypeScript (strict) + Tailwind CSS v4
- Zod for runtime validation of config, products, and model outputs
- Runtime LLM: local `muse` CLI (`muse-spark-1.3`), key-authenticated via
  `--api-key-stdin` — no Anthropic account needed
- Product search: Tavily Search with `include_domains` restriction +
  Tavily Extract for price/image enrichment
- Tests: Vitest (minimal suite over the highest-risk logic)

## Setup

Requires Node 22+ and npm, plus the `muse` CLI on your `PATH`
(the app shells out to `muse exec` for reasoning).

```sh
npm install
cp .env.example .env
# fill in META_API_KEY, TAVILY_API_KEY, GOOGLE_OAUTH_CLIENT_ID, and
# SESSION_SECRET in .env (never commit it)
npm run dev
```

For Google sign-in, create an OAuth client ID of type "Web application" in
[Google Cloud Console](https://console.cloud.google.com/apis/credentials)
and register `http://localhost:3000` as an authorized JavaScript origin
(add your production origin when deploying). No client secret is needed:
the login page uses Google Identity Services, and the server verifies the
signed ID token directly with Google's published keys.

Open [http://localhost:3000](http://localhost:3000) in your browser.

If `npm` fails with EPERM on `~/.npm`, fix ownership once:
`sudo chown -R $(id -u):$(id -g) ~/.npm`.

## Scripts

- `npm run dev` — start the dev server (webpack)
- `npm run build` / `npm start` — production build / serve
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript check
- `npm test` — minimal test suite

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `META_API_KEY` | yes (for AI reasoning) | Muse Meta API key, piped to `muse exec` via stdin |
| `TAVILY_API_KEY` | yes (for live search) | Tavily key for domain-restricted search + extract |
| `GOOGLE_OAUTH_CLIENT_ID` | yes (for sign-in) | Google OAuth web client ID; public, also served to the login page |
| `SESSION_SECRET` | yes (for sign-in) | Random secret for signing session cookies (server-side only) |
| `WISORA_MUSE_MODEL` | no | Model id (default `muse-spark-1.3`) |
| `WISORA_MUSE_EFFORT_CLASSIFY` | no | Effort for intent extraction (default `low`) |
| `WISORA_MUSE_EFFORT_REASON` | no | Effort for verdict rationale (default `medium`) |
| `WISORA_MUSE_BIN` | no | `muse` binary path (default `muse` on `PATH`) |
| `WISORA_MUSE_BASE_URL` | no | Only if your key targets a non-default endpoint |
| `WISORA_DATA_DIR` | no | Directory for per-user preference files (default `./data`, gitignored) |
| `RESEND_API_KEY` | no | Resend key for price-alert emails; without it, alerts are in-app only |
| `RESEND_FROM` | no | Verified sender address for alert emails (required together with the key, e.g. `Wisora <alerts@yourdomain.com>`) |
| `WISORA_CHECK_INTERVAL_MINUTES` | no | Background watch-check interval in minutes (default `240` = 4h, min 5) |
| `WISORA_MAX_CHECKS_PER_CYCLE` | no | Max watches re-checked per background cycle (default `10`, clamped 1–50) |
| `WISORA_MONITORING` | no | Set to `off` to disable the background price monitor |

All secrets stay server-side in `.env` (gitignored). They are never logged,
never sent to the browser, and never printed by any script. Without keys the
app still runs: intent analysis falls back to rules, and search reports
exactly which key is missing instead of showing mock data.

## Shopping sources

Single source of truth: `config/sources.ts`. Edit that file to add, remove,
enable, or disable a source — nothing else duplicates the list.

Phase 1 sources: Amazon India, Flipkart, ShopClues, Snapdeal, Myntra, AJIO,
Tata CLiQ, Nykaa Fashion.

## API routes

- `POST /api/intent` — `{ query }` → detected category, budget, search terms
- `POST /api/requirements` — `{ query, intent?, answers? }` → requirement
  set + clarification questions + suggested category
- `POST /api/search` — `{ query, category?, disabled?, maxResults?,
  allowOverBudget? }` → normalized products + per-source statuses +
  warnings (`allowOverBudget` widens a stated budget max by 25% in the
  search query so near-budget options can surface)
- `POST /api/recommend` — full pipeline (or pass-through of `products` from
  `/api/search` to avoid re-searching; accepts `requirements`, `weights`,
  `allowOverBudget`, `personalize`) → ranked products with score breakdowns
  and evidence, excluded options, confidence assessment, validated verdict,
  and a `personalization` report (which saved preferences applied, which
  were skipped, and budget/weights provenance). Signed-in requests apply
  the user's saved profile unless `personalize: false` opts out for one
  query; current instructions always win over stored preferences.
- `POST /api/reviews` — `{ products (1–3), category?, requirements?,
  rankedTotals? }` → per-product review records, validated insights,
  contradictions, evidence quality, and bounded score adjustments
- `GET / PUT /api/profile` — signed-in user's preference profile
  (`{ profile }`, null before anything is saved); `DELETE` clears it
- `GET / PUT /api/profile/[category]` — per-category preferences
  (`{ category, preferences }`); PUT merges, explicit null removes a field
- `GET / POST /api/memory/decisions` — saved recommendation snapshots
  (`?limit=`, newest-first)
- `GET / POST /api/memory/saved/products` (+ `DELETE ?productId=`) —
  saved product keepsakes (re-saving upserts)
- `GET / POST /api/memory/saved/comparisons` (+ `DELETE ?id=`) — saved
  2–6 product comparison sets
- `GET / POST /api/memory/feedback` — recommendation feedback: helpful,
  preferred/rejected/purchased products, reasons, notes
- `GET /api/memory/proposals` — pending inferred-preference proposals
  (reading also runs detection; nothing is inferred silently)
- `POST /api/memory/proposals/decide` — `{ id, decision:
  confirmed|rejected, patch? }`; confirmations apply to the profile with
  `confirmed` provenance
- `DELETE /api/memory/history` — clear decisions, feedback, and
  proposals (saved items and the profile are kept)
- `GET / POST / PUT / DELETE /api/memory/watches` — price watches:
  `{ productId, url, title, merchant, targetPrice, canWait? }`; GET returns
  watches enriched with latest observation, windowed stats, recent history,
  and unread-alert counts; POST evaluates immediately against known history
- `POST /api/memory/watches/check` — `{ id }` → re-check one watch now
  (fresh page extract, observation, evaluation, alert on target met)
- `GET /api/memory/alerts` — price alerts, newest-first (`?limit=`)
- `POST /api/memory/alerts/read` — `{ all: true }` or `{ ids: [...] }`
  marks alerts read
- `GET /api/prices/insights?ids=a,b` — batch price history (1–10 ids) for
  product cards: latest observation, stats, recent observations
- `GET /api/prices/monitor` — background monitor status (active, interval,
  email configured)

## Limitations (Phase 1)

- Prices are scraped from retailer page text via the search provider's Extract
  API and labeled by evidence strength (`seen on page` vs `seen once` vs
  unavailable). Always confirm on the retailer's page before buying.
- Review ratings come from the same page text (rating value + ratings count
  when the page shows them) and only from likely product pages — never from
  category or search pages. Listings without a detectable rating show
  "No rating found" rather than a guess.
- Product photos come from retailer page media: product-photo namespaces are
  preferred over site chrome, and CDN thumbnails are upscaled where the URL
  pattern allows. Pages without a detectable product photo show a merchant
  placeholder, and images that fail to load fall back to it automatically.
- No review collection yet: pros/cons derive from verified facts (budget fit,
  price evidence). The UI never shows fabricated reviews or ratings.
- One search call covers all enabled domains; per-source failures are reported
  per search, not per site connection.
- WAIT verdicts require a concrete evidence-based reason; sale and launch
  predictions are vetoed. When evidence is thin the app abstains with
  INSUFFICIENT_EVIDENCE; when every option violates the budget or a
  mandatory requirement it asks with NEEDS_CLARIFICATION.
- Structured specifications are not extracted yet: requirement matching
  works on listing titles and page text (numeric minimums with unit
  normalization, token coverage otherwise), graded met / not-met / unknown.
- Review intelligence works from search excerpts and extractable pages, not
  complete review corpora: shopping-site review walls are often unreachable,
  so coverage is partial by design. Identity matching is heuristic (model
  codes parsed from titles), fashion items rarely match exactly, and the
  system never reports review counts, percentages, or defect rates — only
  distinct corroborating sources. The official verdict is never silently
  changed by review evidence; rank impact is reported, not applied.
- Out of scope for Phase 1: accounts, saved history, price alerts, financial
  planning, direct retailer integrations.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run build` — all green.
- `npm test` — focused suite: intent rules, dedup, scoring/verdict/policy
  logic, requirements, eligibility, evidence quality, weights, review
  identity/retrieval/themes/quality/adjustment, route contracts, and a
  14-scenario deterministic eval dataset (`lib/eval/`).
- Live-verified during development: key-authenticated `muse exec`
  (intent + verdict), Tavily search with domain restriction, Tavily extract
  shape, and route error paths (400/503 with honest messages).
