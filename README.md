# whatsapp-bot — "Kudi"

WhatsApp bot for **Barrakudes de Begur** (youth association, barrakudesbegur.org).
Kudi is the orange nino from the Barrakudes logo. This is a general-purpose bot for
the association; its first flow is the **curs-sardanes** demand survey (PLAN §4.4).

Cloudflare Worker (TypeScript + [Hono]) with D1 for persistence and Workers AI for the
free-text fallback. Everything runs locally without Meta: while `WA_ENABLED` is `"false"`
outbound sends are recorded to D1 as no-ops, so the whole system is testable end-to-end
via the built-in simulator.

> Implemented: PLAN §4.1–4.6, §4.8 (phases 3–4) — core bot + the Workers AI
> fallback with Kudi's knowledge base. The inbox admin SPA (§4.7, phase 5) is
> the remaining stage; `/admin` is a placeholder page meanwhile.

## Architecture

```
Meta Cloud API ──POST /webhook──▶  verify X-Hub-Signature-256 (raw body, fail closed)
                                   │
                                   ▼
                          router.ts (handleWebhook)
              dedupe (wa_message_id) → upsert person → route:
              ┌──────────────────────────────────────────────────────┐
              │ 0. GDPR erase intent (text)     → confirm → anonymize │
              │ 0. media/audio/sticker          → apologize + re-ask  │
              │ 1. interactive reply (context.id)→ flow step          │
              │ 2. trigger text                 → start / resume      │
              │ 3. active flow                  → step answer (AI)    │
              │ 4. no flow                      → AI fallback (KB)    │
              └──────────────────────────────────────────────────────┘
                                   │                 │
                        flows/ (pure modules)   ai/provider.ts (stub → Workers AI next)
                                   │
                          wa/sender.ts → D1 (log-only) or Graph API (WA_ENABLED)
```

| Path                   | Responsibility                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`         | Hono app: `/webhook` (GET verify, POST events), `/dev/simulate`, `/admin/api/*`.                                                       |
| `src/router.ts`        | Message router + all edge cases (PLAN 4.3 / 4.5). Optimistic concurrency on step updates.                                              |
| `src/flows/`           | Flow registry + the `curs-sardanes` state machine (pure, unit-testable).                                                               |
| `src/wa/`              | `wire.ts` (Cloud API types + payload builder), `parse.ts` (webhook→events), `sender.ts` (outbound), `simulate.ts` (simulator→webhook). |
| `src/db/`              | `store.ts` (interface), `d1.ts` (production), `memory.ts` (in-memory fake for tests).                                                  |
| `src/ai/`              | `provider.ts` (interface + deterministic stub), `workers-ai.ts` (Gemma 3 on Workers AI), `prompt.ts` (pure prompt assembly).           |
| `kb/` + `src/kb/`      | Kudi's knowledge: static `kb/*.md` (imported as text at build) + the live agenda feed from the landing (`src/kb/events.ts`).           |
| `src/access.ts`        | Cloudflare Access JWT verification (ported from coin-reader), fail-closed.                                                             |
| `src/lib/signature.ts` | `X-Hub-Signature-256` HMAC-SHA256 verification (real WebCrypto).                                                                       |
| `migrations/`          | D1 schema (PLAN 4.2) + indexes + `settings` seed.                                                                                      |
| `public/`              | Static assets: `/` info page and the placeholder `/admin` SPA.                                                                         |

**Concurrency safety.** Webhook retries are deduped by the `messages.wa_message_id`
UNIQUE constraint (`INSERT ... ON CONFLICT DO NOTHING`). Two concurrent invocations
can't both advance a flow: step transitions are an optimistic compare-and-set
(`UPDATE flow_instances ... WHERE id=? AND step IS ?`) — if 0 rows change, the other
invocation won and we skip sending. Interactive replies route by `context.id` →
outbound message → `flow_instance_id`, so concurrent flows per person are safe.

## Configuration

### Bindings (`wrangler.jsonc`)

| Binding  | Type       | Notes                                                                                                                                                               |
| -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB`     | D1         | `database_name` = `whatsapp-bot`. **`database_id` is a placeholder** — owner runs `npx wrangler d1 create whatsapp-bot` and pastes the id (TODO in wrangler.jsonc). |
| `AI`     | Workers AI | Declared now; used by the AI-fallback stage.                                                                                                                        |
| `ASSETS` | Assets     | Serves `public/`. `run_worker_first` routes only `/webhook`, `/admin/api/*`, `/dev/*` to the Worker.                                                                |

### Vars (non-secret, in `wrangler.jsonc`)

| Var                      | Default                                        | Purpose                                                                                             |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `WA_ENABLED`             | `"false"`                                      | `"true"` enables real Graph API sends; otherwise outbound is logged to D1 only.                     |
| `WA_GRAPH_VERSION`       | `"v23.0"`                                      | Graph API version segment (current official docs value).                                            |
| `EVENTS_JSON_URL`        | `https://barrakudesbegur.org/events.json`      | Live agenda for Kudi's KB (the landing's events collection). Unset/`"off"` disables.                |
| `CF_ACCESS_TEAM_DOMAIN`  | `https://barrakudesbegur.cloudflareaccess.com` | Cloudflare Access team domain.                                                                      |
| `CF_ACCESS_AUD`          | `""` (**TODO owner**)                          | Comma-separated Access application AUD(s): production app + preview-deploy app (coin-reader trick). |
| `CF_ACCESS_EMAIL_DOMAIN` | `@barrakudesbegur.org`                         | Allowed email suffix.                                                                               |

### Secrets (`wrangler secret put …`; locally in `.dev.vars`)

| Secret               | Purpose                                     |
| -------------------- | ------------------------------------------- |
| `WA_VERIFY_TOKEN`    | Echoed challenge check for `GET /webhook`.  |
| `WA_APP_SECRET`      | Key for `X-Hub-Signature-256` verification. |
| `WA_ACCESS_TOKEN`    | Bearer token for Graph API sends.           |
| `WA_PHONE_NUMBER_ID` | Phone number id in the Graph API send URL.  |

### Local-dev-only switches (**never set in production**; `.dev.vars` only)

| Switch              | Purpose                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DEV_SIMULATOR`     | `"true"` exposes `POST /dev/simulate`.                                                                                                   |
| `DEV_ACCESS_BYPASS` | `"true"` lets `/admin/api/*` through without an Access JWT (no Access in front of `wrangler dev`). Fails closed unless exactly `"true"`. |

Copy `.dev.vars.example` → `.dev.vars` to develop locally.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars                       # local secrets + dev switches
npm run db:migrate:local                             # apply migrations to the local D1
npx wrangler dev --port 8793                          # non-default port (agents share this box)
```

### Drive a full survey with the simulator

`POST /dev/simulate` synthesizes a realistic Cloud API webhook and runs the **same**
router path (minus the signature check), returning the outbound messages produced.
Reply to interactive messages by echoing the previous outbound `wa_message_id` as
`context_wa_message_id`.

```bash
BASE=http://localhost:8793 ; WA=34600123456

# 1. trigger (the wa.me prefilled text)
curl -s -X POST $BASE/dev/simulate -H 'content-type: application/json' \
  -d "{\"wa_id\":\"$WA\",\"text\":\"Explica'm això del curs de sardanes 💃\"}"

# 2. name  → returns K2 info + K3 buttons (note the buttons' wa_message_id)
curl -s -X POST $BASE/dev/simulate -H 'content-type: application/json' \
  -d "{\"wa_id\":\"$WA\",\"name\":\"Pol\",\"text\":\"em dic Pol\"}"

# 3. tap "Afegeix-me al grup"  → returns K4 list (note its wa_message_id)
curl -s -X POST $BASE/dev/simulate -H 'content-type: application/json' \
  -d "{\"wa_id\":\"$WA\",\"button_reply\":{\"id\":\"grup\",\"context_wa_message_id\":\"<K3_ID>\"}}"

# 4. pick "Dissabtes"  → returns K5 close; survey complete
curl -s -X POST $BASE/dev/simulate -H 'content-type: application/json' \
  -d "{\"wa_id\":\"$WA\",\"list_reply\":{\"id\":\"dissabtes\",\"context_wa_message_id\":\"<K4_ID>\"}}"
```

Inspect the local D1:

```bash
npx wrangler d1 execute whatsapp-bot --local --json \
  --command "SELECT status, step, data_json FROM flow_instances;"
# → {"status":"completed","step":null,"data_json":"{\"action\":\"grup\",\"availability\":\"dissabtes\"}"}
```

Admin API (dev bypass on): `curl $BASE/admin/api/health` · `…/admin/api/conversations`.

## AI — Kudi's brain (PLAN §4.6)

Free text the scripted flows can't handle is answered by **Workers AI**
(`src/ai/workers-ai.ts`), model `@cf/google/gemma-3-12b-it` (strongest free
multilingual/Catalan bet; fallback candidates compared with the eval script).
The system prompt (`src/ai/prompt.ts`, pure + unit-tested) is plain context
stuffing — no vector search at this size:

1. **Static KB** — `kb/*.md`, versioned here (the association, Kudi, socials, course FAQ).
2. **Dynamic KB** — `kb_entries` rows, editable from the inbox admin without a deploy.
3. **Live agenda** — the landing's events collection via `EVENTS_JSON_URL`
   (fetched + edge-cached ~15 min, fail-soft; **no duplication** into this repo).
4. **Course status** — `settings.course_status` (+ note), so "hi ha novetats?"
   always answers with the current truth.
5. A short conversation snippet and the pending survey question, if any.

Structured mode interprets off-script step answers (K1 name extraction; K4
availability → canonical bucket or `custom`). Model + latency (+ tokens) are
logged into `messages.ai_meta_json`.

**Degrades gracefully:** any AI/binding error falls back to a canned Catalan
line (meta model gets an `#error` suffix) — the webhook never crashes, and
local dev **without Cloudflare auth** keeps working end-to-end.

**Compare candidate models** (Workers AI needs Cloudflare auth even locally):

```bash
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/eval-catalan.ts
```

~17 utterances (FAQs, invent-bait, gibberish, GDPR phrasing, off-script survey
answers) across Gemma 3 12B, Llama 3.3 70B fast and Mistral Small 3.1, printed
side by side with latency.

## Testing

```bash
npm test          # vitest run
npm run validate  # prettier --check + tsc --noEmit + vitest run
```

Covered (PLAN 4.8):

- **Flow engine** — every step and branch of `curs-sardanes` as pure-function tests,
  plus a copy-limits assertion (≤3 buttons / 20-char titles, ≤10 rows / 24-char titles).
- **Router dispatch** — realistic recorded webhook fixtures (text, button reply, list
  reply, status update, media); full survey completion with D1 assertions; returning
  completed person; GDPR erase; unknown person; off-script AI-stub fallback.
- **Signature** — valid / tampered / wrong-secret / missing-header / bad-scheme vectors,
  using **real WebCrypto**.
- **Duplicate replay** — the same `wa_message_id` produces no second send.
- **Optimistic concurrency** — a stale step CAS is rejected.
- **AI stage** — prompt assembly (KB, status, events, pending steer), structured
  interpretation parsing (fenced / malformed / out-of-options), provider happy +
  error paths with a mocked AI binding, events feed formatting + fail-soft, and
  the flow's name-interpretation step.

Router persistence in tests uses the in-memory Store fake; the real D1-backed Store is
exercised live via `wrangler dev` + the simulator (see above).

## Deploy & go-live

```bash
npx wrangler deploy --dry-run   # validates config + build without auth
```

Never deploy or create remote resources from this repo automatically. Owner steps:

1. `npx wrangler d1 create whatsapp-bot` → paste `database_id` into `wrangler.jsonc`.
2. `npx wrangler d1 migrations apply whatsapp-bot --remote`.
3. Create the Cloudflare Access application for `wa.barrakudesbegur.org/admin*` (keep
   `/webhook` public for Meta) → set `CF_ACCESS_AUD` (prod + preview AUDs; see
   `coin-reader/wrangler.toml`).
4. `wrangler secret put` the four `WA_*` secrets.
5. Full go-live checklist: **PLAN §7 step 8** (wire the webhook URL, set `WA_ENABLED=true`,
   subscribe the Meta app, test from a fresh phone via every link, set Kudi's WABA profile).

[Hono]: https://hono.dev
