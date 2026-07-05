# whatsapp-bot — "Kudi"

WhatsApp bot for **Barrakudes de Begur** (youth association, barrakudesbegur.org).
Kudi is the orange nino from the Barrakudes logo. This is a general-purpose bot
for the association; its first flow is the **curs-sardanes** demand survey
(PLAN §4.4).

**Stack:** SvelteKit 2 + Svelte 5 (remote functions) on Cloudflare **Workers**
(`@sveltejs/adapter-cloudflare`), D1 for persistence, Workers AI for the
free-text fallback — the **same stack as `curs-sardanes`**. Everything runs
locally without Meta: while `WA_ENABLED` is `"false"`, outbound sends are
recorded to D1 as no-ops, so the whole system is testable end-to-end via the
built-in simulator.

> The webhook is a plain endpoint (`+server.ts`) because Meta is an external
> caller that signs the raw body; everything the **admin** does is a type-safe
> **remote function**. See "Why SvelteKit" below.

## Architecture

```
Meta Cloud API ──▶ src/routes/webhook/+server.ts   (public; verifies X-Hub-Signature-256
                        │                            over the RAW body, fails closed)
                        ▼
              $lib/server/router.ts (handleWebhook)
       dedupe (wa_message_id) → upsert person → route:
       0. GDPR erase intent  → confirm → anonymize
       0. media/sticker      → apologize + re-ask
       1. interactive reply (context.id) → flow step
       2. trigger text       → start / resume
       3. active flow        → step answer (AI interprets off-script)
       4. no flow            → AI fallback (KB, in Kudi's voice)
                        │                 │
              flows/ (pure modules)   ai/ (Workers AI + KB)
                        │
              wa/sender.ts → D1 (log-only) or Graph API (WA_ENABLED)

Browser (admin SPA) ──▶ src/routes/admin/*.remote.ts  (query/command; each calls
                                                        requireAdmin() → Access JWT)
```

| Path                            | Responsibility                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/routes/webhook/+server.ts` | Meta webhook: `GET` verify handshake, `POST` events (raw-body HMAC, fail closed).               |
| `src/routes/admin/`             | Admin page (`+page.svelte` tab shell) + `data.remote.ts` / `simulate.remote.ts` + CSV endpoint. |
| `src/hooks.server.ts`           | Cloudflare Access gate for `/admin` pages (fail closed; `DEV_ACCESS_BYPASS` locally).           |
| `src/lib/server/`               | **Framework-agnostic bot core** (moved here from the old Hono app, unchanged logic).            |
| `src/lib/server/router.ts`      | Message router + all edge cases (PLAN 4.3 / 4.5). Optimistic concurrency on step updates.       |
| `src/lib/server/flows/`         | Flow registry + the `curs-sardanes` state machine (pure, unit-testable).                        |
| `src/lib/server/wa/`            | `wire.ts` (Cloud API payloads), `parse.ts` (webhook→events), `sender.ts`, `simulate.ts`.        |
| `src/lib/server/db/`            | `store.ts` (interface), `d1.ts` (production), `memory.ts` (in-memory fake for tests).           |
| `src/lib/server/ai/`            | `provider.ts` (interface + stub), `workers-ai.ts` (Gemma 3), `prompt.ts` (pure assembly).       |
| `src/lib/server/kb/`            | Static `*.md` (imported via Vite `?raw`) + the live agenda feed (`events.ts`).                  |
| `src/lib/server/access.ts`      | Cloudflare Access JWT verification + `requireAdmin()` (the guard for remote functions).         |
| `src/lib/server/signature.ts`   | `X-Hub-Signature-256` HMAC-SHA256 verification (real WebCrypto).                                |
| `migrations/`                   | D1 schema (PLAN 4.2) + indexes + `settings` seed.                                               |

**Why SvelteKit** (and not the previous Hono + Vite-SPA): one consistent stack
with `curs-sardanes`, and the admin's hand-written JSON API + fetch client is
replaced by type-safe **remote functions**. The one thing that stays a plain
endpoint is the webhook — remote functions are invoked at a generated URL with a
serialized payload and can't expose Meta's fixed URL / raw body / custom
signature header, so `+server.ts` is correct there.

**Auth.** `hooks.server.ts` gates `/admin` _page_ navigations. But a remote
function's request carries the _calling page's_ URL (not the endpoint's), so the
hook can't be trusted to gate them — therefore **every** admin remote function /
endpoint calls `requireAdmin()`, which verifies the Access JWT from the real
request headers and fails closed. In production, put the Cloudflare Access
application in front of the whole host **except** `/webhook` for defense in depth.

**Concurrency safety.** Webhook retries are deduped by the `messages.wa_message_id`
UNIQUE constraint. Two concurrent invocations can't both advance a flow: step
transitions are an optimistic compare-and-set (`UPDATE ... WHERE id=? AND step IS ?`).

## Configuration

### Bindings (`wrangler.jsonc`)

| Binding | Type       | Notes                                                                                           |
| ------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `DB`    | D1         | `database_name` = `whatsapp-bot`. `database_id` is set; run `wrangler d1 create` if recreating. |
| `AI`    | Workers AI | Kudi's free-text fallback (Gemma 3).                                                            |

### Vars (`wrangler.jsonc`) / Secrets (`wrangler secret put`; `.dev.vars` locally)

- Vars: `WA_ENABLED` (`"false"` = log-only), `WA_GRAPH_VERSION`, `EVENTS_JSON_URL`,
  `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_EMAIL_DOMAIN`.
- Secrets: `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`.
- Local-dev-only (`.dev.vars`, never in prod): `DEV_SIMULATOR` (enables the Simulador
  tab + simulate command), `DEV_ACCESS_BYPASS` (skips the Access gate locally).

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # local secrets + dev switches
npm run db:apply:local           # apply migrations to the local D1
npm run dev                      # vite dev (platform proxy gives D1 + AI bindings)
```

Open `http://localhost:5173/admin` (Access is bypassed locally). Drive a full
survey from the **Simulador** tab; it appears under **Converses** with the
transcript, and the reply-as-Kudi box works (logged to D1 while `WA_ENABLED=false`).

## AI — Kudi's brain (PLAN §4.6)

Free text the scripted flows can't handle is answered by **Workers AI**
(`$lib/server/ai/workers-ai.ts`), model `@cf/google/gemma-3-12b-it`. The system
prompt (`ai/prompt.ts`, pure + unit-tested) stuffs: static KB (`kb/*.md` via
`?raw`), dynamic `kb_entries`, the live agenda from the landing (`EVENTS_JSON_URL`,
fail-soft, no duplication), `settings.course_status`, a conversation snippet, and
the pending question. Structured mode interprets off-script answers (K1 name, K4
availability). Degrades gracefully: any AI error → a canned Catalan line, so the
webhook never crashes and local dev works without Cloudflare auth.

> The bot currently uses scripted regex parsing with AI as a fallback. The owner
> wants an **AI-first** rewrite (regex barely used) — deferred; see
> [`docs/ai-first-redesign.md`](docs/ai-first-redesign.md).

Compare candidate models: `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/eval-catalan.ts`.

## Testing

```bash
npm test          # vitest (core) + Playwright
npm run validate  # prettier --check + eslint + svelte-check + vitest
```

The framework-agnostic core (flows, router, signature, AI prompt/interpret,
messages) is covered by 81 vitest tests — every flow step/branch/edge case,
router dispatch with recorded webhook fixtures, real-WebCrypto signature vectors,
duplicate-replay dedupe, optimistic concurrency, and the AI stage with a mocked
binding. The SvelteKit surface (webhook signature, admin remote functions,
Simulador→router) is verified end-to-end via the dev server + Playwright.

## Deploy & go-live

Deploys **exactly like `curs-sardanes`** — a Cloudflare **Worker** built by the
SvelteKit adapter to `.svelte-kit/cloudflare`. Create the Cloudflare project as a
**Worker** (Workers Builds): build `npm run build`, deploy `npx wrangler deploy`.
Validate anytime with `npm run deploy:dry`.

Owner steps: (1) custom domain `wa.barrakudesbegur.org`; (2) a Cloudflare Access
app covering the host except `/webhook`, and set `CF_ACCESS_AUD`; (3)
`wrangler secret put` the four `WA_*` secrets; (4) subscribe the Meta webhook to
`https://wa.barrakudesbegur.org/webhook` (verify token = `WA_VERIFY_TOKEN`,
`messages` field); (5) set `WA_ENABLED="true"`. Full checklist: PLAN §7 step 8
and `curs-sardanes/docs/DEPLOY.md`.
