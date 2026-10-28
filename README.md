# Wisora

Smarter purchasing decisions, backed by evidence. Describe what you want in
natural language; Wisora detects the category, searches configured Indian
shopping sources, compares real options, and gives a reasoned BUY / WAIT /
AVOID recommendation with traceable links. It never invents products, prices,
or reviews.

Status: Phase 2 Slice 1 complete — decision-correctness machinery
(requirements → eligibility → evidence → weighted scoring → validated verdict)
on top of the Phase 1 slice.

## How it works

1. You describe a need by typing or voice input (Chrome/Edge), e.g. "Find a laptop under ₹90,000 for .NET development."
2. Wisora extracts requirements — must-haves, nice-to-haves, and explicit
   exclusions (deterministic rules first, Muse assist when available) — and
   asks at most two clarification questions when something material is
   ambiguous.
3. You correct the category and toggle shopping sources if needed.
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
# fill in META_API_KEY and TAVILY_API_KEY in .env (never commit it)
npm run dev
```

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
| `WISORA_MUSE_MODEL` | no | Model id (default `muse-spark-1.3`) |
| `WISORA_MUSE_EFFORT_CLASSIFY` | no | Effort for intent extraction (default `low`) |
| `WISORA_MUSE_EFFORT_REASON` | no | Effort for verdict rationale (default `medium`) |
| `WISORA_MUSE_BIN` | no | `muse` binary path (default `muse` on `PATH`) |
| `WISORA_MUSE_BASE_URL` | no | Only if your key targets a non-default endpoint |

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
- `POST /api/search` — `{ query, category?, disabled?, maxResults? }` →
  normalized products + per-source statuses + warnings
- `POST /api/recommend` — full pipeline (or pass-through of `products` from
  `/api/search` to avoid re-searching; accepts `requirements`, `weights`,
  `allowOverBudget`) → ranked products with score breakdowns and evidence,
  excluded options, confidence assessment, and validated verdict

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
- Out of scope for Phase 1: accounts, saved history, price alerts, financial
  planning, direct retailer integrations.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run build` — all green.
- `npm test` — focused suite: intent rules, dedup, scoring/verdict/policy
  logic, requirements, eligibility, evidence quality, weights, route
  contracts, and a 14-scenario deterministic eval dataset (`lib/eval/`).
- Live-verified during development: key-authenticated `muse exec`
  (intent + verdict), Tavily search with domain restriction, Tavily extract
  shape, and route error paths (400/503 with honest messages).
