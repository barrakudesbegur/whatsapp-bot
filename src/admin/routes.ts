/**
 * Inbox admin API (PLAN 4.7), mounted at /admin/api and guarded by Cloudflare
 * Access (with the dev bypass honored). All handlers are thin wrappers over the
 * Store + Sender; the Svelte SPA in admin/ consumes them.
 */

import { Hono } from "hono";
import type { Env } from "../types.ts";
import { D1Store } from "../db/d1.ts";
import { Sender } from "../wa/sender.ts";
import { requireAccess, type AccessIdentity } from "../access.ts";
import { renderMessage, csvRow } from "./render.ts";
import { nowIso } from "../lib/time.ts";

const WINDOW_MS = 24 * 60 * 60 * 1000;

type Vars = { identity: AccessIdentity };

export const adminApi = new Hono<{ Bindings: Env; Variables: Vars }>();

// Cloudflare Access gate (fails closed; dev bypass honored). Applies to all
// /admin/api/* routes.
adminApi.use("*", async (c, next) => {
  const identity = await requireAccess(c.req.raw, c.env);
  if (identity instanceof Response) return identity;
  c.set("identity", identity);
  await next();
});

/** Whether the simulator playground should be shown (dev builds only). */
adminApi.get("/config", (c) =>
  c.json({
    simulatorEnabled: c.env.DEV_SIMULATOR === "true",
    waEnabled: c.env.WA_ENABLED === "true",
    email: c.get("identity").email,
  }),
);

adminApi.get("/conversations", async (c) => {
  const store = new D1Store(c.env.DB);
  const now = Date.now();
  const conversations = (await store.listConversations()).map((cv) => ({
    id: cv.person.id,
    name: cv.person.display_name || cv.person.profile_name || cv.person.wa_id,
    waId: cv.person.wa_id,
    gdprDeleted: cv.person.gdpr_deleted === 1,
    lastMessageAt: cv.lastMessageAt,
    lastInboundAt: cv.person.last_inbound_at,
    windowOpen:
      cv.person.last_inbound_at != null &&
      now - Date.parse(cv.person.last_inbound_at) < WINDOW_MS,
    flowStatus: cv.flowStatus,
    flowType: cv.flowType,
  }));
  return c.json({ conversations });
});

adminApi.get("/conversations/:id/messages", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const store = new D1Store(c.env.DB);
  const person = await store.getPerson(id);
  if (!person) return c.json({ error: "not found" }, 404);
  const rows = await store.listMessagesForPerson(id);
  const now = Date.now();
  return c.json({
    person: {
      id: person.id,
      name: person.display_name || person.profile_name || person.wa_id,
      waId: person.wa_id,
      gdprDeleted: person.gdpr_deleted === 1,
      lastInboundAt: person.last_inbound_at,
      windowOpen:
        person.last_inbound_at != null &&
        now - Date.parse(person.last_inbound_at) < WINDOW_MS,
    },
    messages: rows.map(renderMessage),
  });
});

adminApi.post("/conversations/:id/reply", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "empty message" }, 400);

  const store = new D1Store(c.env.DB);
  const person = await store.getPerson(id);
  if (!person || person.gdpr_deleted === 1)
    return c.json({ error: "not found" }, 404);

  // 24h customer-service window: free-form replies are only allowed within it.
  const open =
    person.last_inbound_at != null &&
    Date.now() - Date.parse(person.last_inbound_at) < WINDOW_MS;
  if (!open) return c.json({ error: "window_closed" }, 409);

  const sender = new Sender(c.env, store);
  const [sent] = await sender.send(person, [{ kind: "text", body: text }]);
  return c.json({ status: sent?.status ?? "logged" });
});

// --- Knowledge base -------------------------------------------------------

adminApi.get("/kb", async (c) => {
  const store = new D1Store(c.env.DB);
  return c.json({ entries: await store.listKbEntries(false) });
});

adminApi.post("/kb", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    slug?: unknown;
    title?: unknown;
    content_md?: unknown;
    active?: unknown;
  };
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const contentMd = typeof body.content_md === "string" ? body.content_md : "";
  if (!/^[a-z0-9-]+$/.test(slug))
    return c.json({ error: "slug must be kebab-case" }, 400);
  if (!title) return c.json({ error: "title required" }, 400);

  const store = new D1Store(c.env.DB);
  const entry = await store.upsertKbEntry({
    slug,
    title,
    contentMd,
    active: body.active !== false,
    at: nowIso(),
  });
  return c.json({ entry });
});

adminApi.delete("/kb/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const store = new D1Store(c.env.DB);
  const ok = await store.deleteKbEntry(id);
  return c.json({ deleted: ok });
});

// --- Settings (course status) ---------------------------------------------

adminApi.get("/settings", async (c) => {
  const store = new D1Store(c.env.DB);
  return c.json({
    course_status: (await store.getSetting("course_status")) ?? "exploring",
    course_status_note: (await store.getSetting("course_status_note")) ?? "",
  });
});

adminApi.put("/settings", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    course_status?: unknown;
    course_status_note?: unknown;
  };
  const status = String(body.course_status ?? "");
  if (!["exploring", "confirmed", "cancelled"].includes(status))
    return c.json({ error: "invalid course_status" }, 400);
  const note = String(body.course_status_note ?? "");
  const store = new D1Store(c.env.DB);
  const at = nowIso();
  await store.setSetting("course_status", status, at);
  await store.setSetting("course_status_note", note, at);
  return c.json({ course_status: status, course_status_note: note });
});

// --- CSV export -----------------------------------------------------------

adminApi.get("/export/curs-sardanes.csv", async (c) => {
  const store = new D1Store(c.env.DB);
  const rows = await store.exportCompletedFlows("curs-sardanes");
  const header = csvRow([
    "name",
    "wa_id",
    "action",
    "availability",
    "availability_raw",
    "completed_at",
  ]);
  const lines = rows.map((r) => {
    let data: {
      action?: string;
      availability?: string;
      availability_raw?: string;
    } = {};
    try {
      data = JSON.parse(r.data_json);
    } catch {
      /* keep empty */
    }
    return csvRow([
      r.display_name ?? r.profile_name ?? "",
      r.wa_id,
      data.action ?? "",
      data.availability ?? "",
      data.availability_raw ?? "",
      r.completed_at ?? "",
    ]);
  });
  const csv = [header, ...lines].join("\n") + "\n";
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="curs-sardanes.csv"',
    },
  });
});

// --- GDPR erase (per-person delete button) --------------------------------

adminApi.post("/people/:id/erase", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const store = new D1Store(c.env.DB);
  const person = await store.getPerson(id);
  if (!person) return c.json({ error: "not found" }, 404);
  await store.anonymizePerson(id, nowIso());
  return c.json({ erased: true });
});
