# whatsapp-bot — "Kudi"

WhatsApp bot for **Barrakudes de Begur** (youth association, barrakudesbegur.org).
Kudi is the orange nino from the Barrakudes logo. This is a general-purpose,
**AI-first** bot for the association; its first job is the **curs-sardanes**
demand survey.

**Stack:** SvelteKit 2 + Svelte 5 (remote functions) on Cloudflare **Workers**
(`@sveltejs/adapter-cloudflare`), D1 for persistence, **Workers AI** for
understanding. Everything runs locally without Meta: while `WA_ENABLED` is
`"false"`, outbound sends are recorded to D1 as no-ops, so the whole system is
testable end-to-end via the CLI chat simulator or the admin Simulador.

> The webhook is a plain endpoint (`+server.ts`) because Meta is an external
> caller that signs the raw body; everything the **admin** does is a type-safe
> **remote function**. See "Why SvelteKit" below.

## Architecture — AI-first

**The model understands every human message.** There is no keyword matching, no
trigger phrases, no step state machine. Each inbound free-text message (or a
tapped option) triggers exactly **one** model call that returns a validated
`Decision`: an in-voice Catalan reply, a whitelist of **actions** that code
executes against D1, and (optionally) model-generated **tappable options**
(buttons/list). Code — never the model — is the authority: it validates every
action, derives survey completion, and gates the irreversible data-erasure.

```
Meta Cloud API ──▶ src/routes/webhook/+server.ts   (public; verifies X-Hub-Signature-256
                        │                            over the RAW body, fails closed; always 200)
                        ▼
              $lib/server/router.ts (handleWebhook)
       dedupe (wa_message_id) → upsert person → route:
       · media/sticker        → deterministic apology (+ re-ask)      0 model calls
       · gdpr_yes/gdpr_no tap → gated erase / disarm                  0 model calls
       · EVERYTHING else      → loadDecisionState → decide() ────────  1 model call
                                       │
                              Decision { reply, actions[], control? }
                                       │
                          survey/apply.ts (code = the authority)
                    validates actions → writes D1 → derives completion
                    → renders reply (+ generated buttons/list, clamped
                      to WhatsApp limits) → wa/sender.ts → D1 / Graph API

Browser (admin SPA) ──▶ src/routes/admin/*.remote.ts  (query/command; each calls
                                                        requireAdmin() → Access JWT)
```

| Path                                      | Responsibility                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/routes/webhook/+server.ts`           | Meta webhook: `GET` verify handshake, `POST` events (raw-body HMAC, fail closed).                                       |
| `src/routes/admin/`                       | Admin page (`+page.svelte` tab shell) + `data.remote.ts` / `simulate.remote.ts` + CSV endpoint.                         |
| `src/hooks.server.ts`                     | Cloudflare Access gate for `/admin` pages (fail closed; `DEV_ACCESS_BYPASS` locally).                                   |
| `src/lib/server/router.ts`                | The AI-first pipeline above; the only deterministic branches are language-free.                                         |
| `src/lib/server/ai/decide.ts`             | **The decision contract**: types, JSON schema, valibot validation, JSON recovery, erasure gate, deterministic fallback. |
| `src/lib/server/ai/decide-prompt.ts`      | Builds the decide() messages: persona, draft state, actions, anti-rigidity rules, few-shot examples, KB.                |
| `src/lib/server/ai/workers-ai-decider.ts` | Production `Decider`: Workers AI + `response_format` json_schema, low temperature, degradation ladder.                  |
| `src/lib/server/ai/scripted-decider.ts`   | Deterministic `Decider` for tests (enqueue decisions; counts calls).                                                    |
| `src/lib/server/ai/prompt.ts`             | `buildKbBlock` — folds static KB + `kb_entries` + course status + live agenda.                                          |
| `src/lib/server/survey/spec.ts`           | Declarative survey field spec + pure `deriveMissing` / `deriveStatus` (code owns completion).                           |
| `src/lib/server/survey/apply.ts`          | Executes a Decision: D1 writes per action, erasure double-gate, reply/control rendering.                                |
| `src/lib/server/survey/state.ts`          | Assembles the per-turn `DecisionState` (draft, missing fields, erasure flag, KB, transcript).                           |
| `src/lib/server/wa/`                      | `wire.ts` (Cloud API payloads), `parse.ts` (webhook→events), `sender.ts`, `simulate.ts`.                                |
| `src/lib/server/db/`                      | `store.ts` (interface), `d1.ts` (production), `memory.ts` (in-memory fake for tests).                                   |
| `src/lib/server/kb/`                      | Static `*.md` (imported via Vite `?raw`) + the live agenda feed (`events.ts`).                                          |
| `src/lib/server/access.ts`                | Cloudflare Access JWT verification + `requireAdmin()` (the guard for remote functions).                                 |
| `src/lib/server/signature.ts`             | `X-Hub-Signature-256` HMAC-SHA256 verification (real WebCrypto).                                                        |
| `scripts/chat.ts`                         | **CLI chat simulator** — talk to Kudi from the terminal (see below).                                                    |
| `migrations/`                             | D1 schema + indexes + `settings` seed.                                                                                  |

**Why SvelteKit** (and not the previous Hono + Vite-SPA): one consistent stack,
and the admin's hand-written JSON API + fetch client is replaced by type-safe
**remote functions**. The one thing that stays a plain endpoint is the webhook —
remote functions are invoked at a generated URL with a serialized payload and
can't expose Meta's fixed URL / raw body / custom signature header, so
`+server.ts` is correct there.

**Auth.** `hooks.server.ts` gates `/admin` _page_ navigations. But a remote
function's request carries the _calling page's_ URL (not the endpoint's), so the
hook can't be trusted to gate them — therefore **every** admin remote function /
endpoint calls `requireAdmin()`, which verifies the Access JWT from the real
request headers and fails closed. In production, put the Cloudflare Access
application in front of the whole host **except** `/webhook` for defense in depth.

**Concurrency safety.** Webhook retries / double-deliveries are deduped by the
`messages.wa_message_id` UNIQUE constraint (atomic INSERT … DO NOTHING), and all
action writes are idempotent set-semantics — replays can't double-apply.

## The decision contract (how "AI decides + acts" works)

`decide(state) → { reply, actions[], control? }` — one call per message.

- **State in** (`survey/state.ts`): who the person is, the submission **draft**
  (collected answers + which fields are still `missing`), whether an erasure is
  pending confirmation, the KB, and a short transcript.
- **Actions out** (whitelisted; anything else is dropped by valibot validation):
  `set_display_name`, `record_signup(grup|avisam|res)`,
  `record_availability(bucket, note?)`, `start_survey`, `restart_survey`,
  `decline_survey`, `initiate_erasure`, `confirm_erasure`, `cancel_erasure`.
- **Control out** (optional): the model may generate tappable options —
  `{kind:'buttons'|'list', options:[{title,…}]}`. Code assigns ids, clamps
  titles, and validates against WhatsApp interactive limits (falls back to plain
  text if unusable). A tap is fed back through `decide()` as its title, so
  understanding is never button-privileged.
- **Draft → record**: every datum lands in the per-person
  `flow_instances.data_json` draft (`{action, availability, availability_raw?}`,
  the same shape the admin + CSV export read). **Code** derives completion
  (`deriveStatus`) and stamps `completed_at`; the model never completes.

**Safety invariants** (all unit-tested):

1. _A degraded turn never mutates._ Model error/timeout/garbage → deterministic
   fallback reply with `actions: []`.
2. _A single message can never erase data._ `confirm_erasure` only works when an
   erasure was **armed on a prior turn** (`initiate_erasure` → active
   `gdpr-erase` row); the confirm buttons (`gdpr_yes`/`gdpr_no`) are the one
   deterministic interactive.
3. _User text is data, not instructions._ Actions are validated against the
   whitelist; they carry no target (always the current sender), so cross-user
   effects are impossible.

## Configuration

### Bindings (`wrangler.jsonc`)

| Binding | Type       | Notes                                                                                           |
| ------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `DB`    | D1         | `database_name` = `whatsapp-bot`. `database_id` is set; run `wrangler d1 create` if recreating. |
| `AI`    | Workers AI | Kudi's understanding (`decide()`), JSON mode.                                                   |

### Vars (`wrangler.jsonc`) / Secrets (`wrangler secret put`; `.dev.vars` locally)

- Vars: `WA_ENABLED` (`"false"` = log-only), `WA_GRAPH_VERSION`, `EVENTS_JSON_URL`,
  `AI_MODEL` (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`),
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
transcript.

### 💬 Chat with Kudi from the terminal (`npm run chat`)

The fastest way to test conversations end-to-end — it drives the **real**
production path (signed webhook envelopes → router → Workers AI → D1):

```bash
npm run preview     # terminal 1: the built worker on :4193 (npm run build first)
npm run chat        # terminal 2: interactive chat as a fresh person
```

```
Tu: hola! em dic Jordi i apunta'm al grup del curs de sardanes
Kudi: Genial, Jordi! T'apunto al grup 🧡 Última pregunteta: quan et sol anar bé?
   [1] Dissabtes  [2] Diumenges  [3] Entre setmana  …
Tu: /tap 4
```

- `<text>` send a message · `/tap N` tap an option · `/media` send an image ·
  `/new` fresh person · `/state` dump the person + draft rows · `/quit`
- One-shot: `npm run chat -- "hola" "em dic Pep"` (each arg = one message).
- `CHAT_WA_ID=34699123456 npm run chat` continues an existing conversation;
  `CHAT_URL=…` targets another server.
- Note: local `wrangler dev` proxies the real Workers AI (needs `wrangler login`,
  spends real neurons). Without auth, replies degrade to the deterministic
  fallback — which is itself a useful path to test.

## AI — Kudi's brain

The model is **configuration**: `AI_MODEL` var, default
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` (fast, strong Catalan, reliable
JSON). The decide() call uses Workers AI **JSON mode**
(`response_format: {type: 'json_schema', …}`) plus a low temperature; the prompt
(`ai/decide-prompt.ts`, pure + unit-tested) carries Kudi's persona and voice,
WhatsApp text formatting (`*bold*` etc.), the submission draft + missing fields,
the action whitelist, anti-rigidity rules (never demand a specific sentence;
"won't give a name" → call them Anònim and continue), few-shot examples, the KB
(static `kb/*.md` + admin-editable `kb_entries` + `settings.course_status` + the
live agenda from `EVENTS_JSON_URL`, fail-soft) and a transcript snippet.

Degradation ladder (`ai/workers-ai-decider.ts`): JSON-mode call → if the binding
rejects `response_format`, retry without it (a brace-matching `extractJson`
recovers JSON from prose/fences) → anything unusable → deterministic Catalan
fallback with **no actions**. The webhook never crashes; a degraded turn never
mutates state.

Compare candidate models on the real decision contract:
`CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/eval-catalan.ts`.

## Testing

```bash
npm test          # vitest (core) + Playwright
npm run validate  # prettier --check + eslint + svelte-check
```

The framework-agnostic core is covered by ~80 vitest tests over `MemoryStore` +
`ScriptedDecider` (enqueue the decisions a test expects; assert on state
transitions and applied actions — never on model-authored copy): the decision
contract (JSON recovery, whitelist validation), action application (each action
→ the right D1 write, code-derived completion), router dispatch with recorded
webhook fixtures, duplicate-replay dedupe, the one-model-call budget and
zero-call fast-paths, the erasure double-gate (single-message bypass provably
blocked), and the degradation ladder with a mocked AI binding. The SvelteKit
surface is verified via the dev server + Playwright; live conversations via
`npm run chat`.

## Deploy & go-live

Deploys as a Cloudflare **Worker** built by the SvelteKit adapter to
`.svelte-kit/cloudflare`: build `npm run build`, deploy `npx wrangler deploy`
(CI does this on push to `main`). Validate anytime with `npm run deploy:dry`.

Owner steps: (1) custom domain `wa.barrakudesbegur.org`; (2) a Cloudflare Access
app covering the host except `/webhook`, and set `CF_ACCESS_AUD`; (3)
`wrangler secret put` the four `WA_*` secrets; (4) subscribe the Meta webhook to
`https://wa.barrakudesbegur.org/webhook` (verify token = `WA_VERIFY_TOKEN`,
`messages` field); (5) set `WA_ENABLED="true"`.
