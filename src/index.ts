/**
 * Kudi — Barrakudes de Begur WhatsApp bot. Cloudflare Worker entry (Hono).
 *
 * Surface (PLAN 4.1):
 *   GET  /webhook          Meta verification handshake.
 *   POST /webhook          inbound events; verifies X-Hub-Signature-256 over the
 *                          RAW body BEFORE parsing (fails closed).
 *   POST /admin/api/*      behind Cloudflare Access (JWT verified in-worker).
 *   POST /dev/simulate     dev-only fake inbound (guarded by DEV_SIMULATOR).
 *
 * Static assets (the /admin SPA) are served by the assets binding; wrangler's
 * `run_worker_first` routes only /webhook, /admin/api/* and /dev/* here.
 */

import { Hono } from "hono";
import type { Env } from "./types.ts";
import { D1Store } from "./db/d1.ts";
import { WorkersAiProvider } from "./ai/workers-ai.ts";
import { makeDeps, handleWebhook } from "./router.ts";
import { verifySignature } from "./lib/signature.ts";
import { requireAccess, type AccessIdentity } from "./access.ts";
import { buildSimulatedWebhook, isSimulateInput } from "./wa/simulate.ts";
import type { WebhookEnvelope } from "./wa/wire.ts";

type Variables = { identity: AccessIdentity };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// --- Meta webhook verification (GET) -------------------------------------
app.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token && token === c.env.WA_VERIFY_TOKEN) {
    return c.text(challenge ?? "", 200);
  }
  return c.text("forbidden", 403);
});

// --- Meta webhook events (POST) ------------------------------------------
app.post("/webhook", async (c) => {
  const raw = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? null;
  const valid = await verifySignature(c.env.WA_APP_SECRET, signature, raw);
  if (!valid) return c.text("invalid signature", 403); // fail closed

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(raw) as WebhookEnvelope;
  } catch {
    return c.text("bad request", 400);
  }

  try {
    const store = new D1Store(c.env.DB);
    const deps = makeDeps(c.env, store, new WorkersAiProvider(c.env, store));
    await handleWebhook(envelope, deps);
  } catch (err) {
    // Never make Meta retry-storm us; we've deduped inbound already. Log + 200.
    console.error("webhook processing error", err);
  }
  return c.text("EVENT_RECEIVED", 200);
});

// --- Dev simulator (POST) ------------------------------------------------
app.post("/dev/simulate", async (c) => {
  if (c.env.DEV_SIMULATOR !== "true") return c.notFound();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  if (!isSimulateInput(body)) {
    return c.json(
      {
        error:
          "expected { wa_id, text } | { wa_id, button_reply:{id,context_wa_message_id} } | { wa_id, list_reply:{id,context_wa_message_id} }",
      },
      400,
    );
  }

  const envelope = buildSimulatedWebhook(body);
  const store = new D1Store(c.env.DB);
  const deps = makeDeps(c.env, store, new WorkersAiProvider(c.env, store));
  const sent = await handleWebhook(envelope, deps);
  return c.json({
    messages: sent.map((s) => ({
      wa_message_id: s.waMessageId,
      status: s.status,
      message: s.message,
    })),
  });
});

// --- Admin API (behind Cloudflare Access) --------------------------------
app.all("/admin/api/*", async (c, next) => {
  const identity = await requireAccess(c.req.raw, c.env);
  if (identity instanceof Response) return identity; // 403, fail closed
  c.set("identity", identity);
  await next();
});

app.get("/admin/api/health", (c) => {
  return c.json({ ok: true, service: "kudi", email: c.get("identity").email });
});

app.get("/admin/api/conversations", async (c) => {
  const store = new D1Store(c.env.DB);
  return c.json({ conversations: await store.listConversations() });
});

app.get("/admin/api/conversations/:id/messages", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const store = new D1Store(c.env.DB);
  return c.json({ messages: await store.listMessagesForPerson(id) });
});

app.get("/admin/api/settings", async (c) => {
  const store = new D1Store(c.env.DB);
  return c.json({
    course_status: (await store.getSetting("course_status")) ?? "exploring",
    course_status_note: (await store.getSetting("course_status_note")) ?? "",
  });
});

export default app;
