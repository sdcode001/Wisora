# Wisora — Buy With Evidence, Not Anxiety

**Live:** https://wisoraai.netlify.app/

<img width="1275" height="612" alt="Screenshot 2026-11-02 at 4 00 47 AM" src="https://github.com/user-attachments/assets/614c27e4-c3dd-4f35-ba80-11b695381c0a" />

## Goal

Online shopping buries consumers in options: dozens of tabs, sponsored
reviews of unknown trustworthiness, prices that shift daily, and no clear
answer to the only question that matters — *should I buy this, and if so,
which one?*

Wisora's goal is to be a personal purchasing advisor that turns that chaos
into one clear, evidence-backed decision — and then keeps watching the
market on your behalf after you leave.

## How It Solves This

Wisora replaces manual research with a guided pipeline:

1. **Understand** — You describe what you need in plain words. Meta's Muse
   Spark model extracts the category, budget, and search terms.
2. **Clarify** — The system asks about requirements (must-haves,
   nice-to-haves, deal-breakers) so the verdict fits your actual needs.
3. **Research** — Live listings are fetched from real sources — no mock
   data — and every option is scored transparently on price fit,
   relevance, evidence strength, and your saved preferences.
4. **Decide** — You get one verdict — BUY, WAIT, or AVOID — with reasoning,
   trade-offs, uncertainties, and review insights. When evidence is too
   thin, it says INSUFFICIENT_EVIDENCE or NEEDS_CLARIFICATION instead of
   guessing.
5. **Watch** — Set a target price once. A background monitor re-checks it
   on schedule and alerts you the moment your price is hit.
6. **Learn** — Your feedback (prefer, reject, purchased) becomes saved
   preferences, so every future verdict is more yours than the last.

The governing principle: **evidence over hallucination**. Deterministic
code scores, detects, and calculates; the model interprets and synthesizes
— never invents products, prices, or reviews.

## How It Works — End to End
<img width="3274" height="2856" alt="mermaid-diagram" src="https://github.com/user-attachments/assets/c99393aa-02fc-4c5f-ba41-a5973c82911e" />

**Search & verdict.** Enter a request like "laptop under ₹90,000 for .NET
development." Wisora interprets the intent, gathers requirements through
clarifying questions (with adjustable priority weights and an optional 25%
flexible-budget re-search), searches live sources, ranks every product with
a visible score breakdown, and delivers a verdict naming the exact product,
why it won, what you give up, and what could change the answer.

**Review insights.** For the top picks, Wisora reads real review pages and
mines recurring themes — strengths and concerns — each traced to its
source, with contradictions flagged when sources disagree.

**Compare & decide.** Shortlist up to a few options for a side-by-side
comparison, then save the decision. Saved decisions build your decision
history.

**Watchlist & price monitoring.** Track any product with a target price. A
scheduled monitor re-checks watches, records every price observation, and
keeps a run log with a status view.

**Opportunity alerts.** A deterministic detection engine watches every
fresh observation and raises alerts for target hits, significant price
drops and rises, back-in-range moments, and availability changes
(out-of-stock / back-in-stock). Guards keep it quiet when it should be:
dual %-and-₹ floors on every move, stale-evidence rejection, transient
failures never alert, one card per product per check, and dismissals that
stay dismissed. Active alerts rotate in a compact feed; clicking one opens
the full list.

**Email notifications.** Every trigger sends an email immediately — no
daily cap, no batching — as long as that notification type is enabled.
Per-kind preferences (price, availability, reminder) live in Notification
Settings.

**Reminders.** One-time revisit nudges — time-based ("check this Saturday"),
target-based, or both. They fire once, then stay done unless re-activated.

**Chat.** A grounded assistant answers follow-ups ("why not the second
option?") from your stored data first — prices, changes, comparisons — and
only then makes one Meta-model call over retrieved context, labeling
history vs. current data. Offline, it says so honestly instead of guessing.

**Search history.** Every completed search persists with its full results
and restores in one click with zero recompute.

**Preferences & personalization.** Save brands, budgets, categories, and
priorities. The verdict shows exactly which preferences were applied, and
your current request always wins over anything saved.

**Feedback loop.** Prefer, reject (with a reason), or mark purchased on any
verdict. Feedback becomes proposed preference updates for your approval —
rejected and purchased products are suppressed from future verdicts and
alerts automatically.

## Stack

- **Model:** Meta Muse Spark (`muse-spark-1.3`) via the Meta Model API —
  all interpretation (intent, requirements, verdicts, review themes, chat).
- **Live search:** Tavily — product discovery and review-page reading.
- **Email:** Resend — per-event alert delivery.
- **Auth:** Google OAuth — sign-in; all data namespaced per account.
- **App:** Next.js 16 + React 19 + TypeScript (strict) + Zod runtime
  validation + Tailwind CSS.
- **Storage:** MongoDB when `MONGODB_URI` is set (required on serverless
  hosts like Netlify, where the disk is read-only); otherwise local JSON
  files under `data/` (gitignored) for development. Both implement the
  same `MemoryStore` contract.
- **Tests:** Vitest — 454 tests guarding the behaviors above.
- **Discipline:** five runtime dependencies total. No agent frameworks, no
  vector databases, no MCP servers. Deterministic code decides; the model
  interprets.

## Setup Guide

Prerequisites: Node.js 20+ and npm.

```bash
git clone <repo-url> && cd Wisora
npm install
cp .env.example .env
# Fill in the four required values below, then:
npm run dev
```

Open http://localhost:3000, sign in with Google, and run your first search.

Useful commands:

```bash
npm test        # full suite (454 tests)
npm run typecheck
npm run lint
npm run build && npm start   # production
```

## Required Environment

| Variable | Required | Purpose |
|---|---|---|
| `META_API_KEY` | Yes | Meta Model API key for all interpretation (Meta developer console) |
| `TAVILY_API_KEY` | Yes | Live product + review search (https://tavily.com) |
| `GOOGLE_OAUTH_CLIENT_ID` | Yes | Google sign-in — Web application type; register `http://localhost:3000` as an authorized JavaScript origin (https://console.cloud.google.com/apis/credentials) |
| `SESSION_SECRET` | Yes | Signs session cookies — generate with `openssl rand -base64 32` |
| `RESEND_API_KEY` | For email alerts | Sends price/availability/reminder emails (https://resend.com); without it, alerts are in-app only |
| `RESEND_FROM` | For email alerts | Sender identity, e.g. `Wisora <alerts@yourdomain.com>` |
| `WISORA_CHECK_INTERVAL_MINUTES` | No (default 240) | Background watch-check interval in minutes |
| `MONGODB_URI` | Yes on serverless | MongoDB connection string — required on Netlify/Vercel (read-only disk); local dev falls back to JSON files without it |
| `WISORA_MONGO_DB` | No (default wisora) | MongoDB database name |

Anything else (`WISORA_MUSE_*` model/effort overrides and friends) is
optional with sane defaults. See `.env.example`.

## Future Scope

Wisora works end to end today; what comes next is making it sharper and
more trustworthy:

- **Accuracy** — richer requirement understanding, better price-identity
  matching across merchants for the same product, review-source quality
  weighting, and tighter verdict calibration against real outcomes.
- **Reliability** — hardened check scheduling for multi-instance deploys,
  broader source coverage with graceful degradation, and deeper
  regression coverage as behaviors grow.

The direction stays the same: every improvement must make verdicts more
correct, better evidenced, or more honest about uncertainty — never more
confident than the data allows.
