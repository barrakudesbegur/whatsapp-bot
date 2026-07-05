/**
 * Turn stored MessageRow rows (raw inbound webhook payloads / outbound Graph
 * API payloads) into a compact shape the inbox transcript can render, without
 * leaking the full wire format to the client.
 */

import type { MessageRow } from "../db/store.ts";

export interface RenderedButton {
  id: string;
  title: string;
}
export interface RenderedMessage {
  id: number;
  direction: "in" | "out";
  kind: "text" | "buttons" | "list" | "media" | "unknown";
  text: string;
  buttons?: RenderedButton[];
  rows?: RenderedButton[];
  header?: string;
  footer?: string;
  /** Interactive reply selection (inbound button/list tap). */
  reply?: string;
  status: string | null;
  ai?: { model: string; latencyMs?: number; tokens?: number };
  createdAt: string;
}

interface InboundBody {
  type?: string;
  text?: { body?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
  image?: unknown;
  audio?: unknown;
  video?: unknown;
  sticker?: unknown;
  document?: unknown;
}

interface OutboundBody {
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    header?: { text?: string };
    body?: { text?: string };
    footer?: { text?: string };
    action?: {
      buttons?: { reply?: { id?: string; title?: string } }[];
      sections?: { rows?: { id?: string; title?: string }[] }[];
    };
  };
}

function renderInbound(body: InboundBody): Partial<RenderedMessage> {
  if (body.type === "text") {
    return { kind: "text", text: body.text?.body ?? "" };
  }
  if (body.type === "interactive") {
    const title =
      body.interactive?.button_reply?.title ??
      body.interactive?.list_reply?.title ??
      "";
    return { kind: "text", text: title, reply: title };
  }
  for (const media of [
    "image",
    "audio",
    "video",
    "sticker",
    "document",
  ] as const) {
    if (body[media]) return { kind: "media", text: `[${media}]` };
  }
  return { kind: "unknown", text: `[${body.type ?? "?"}]` };
}

function renderOutbound(body: OutboundBody): Partial<RenderedMessage> {
  if (body.type === "text") {
    return { kind: "text", text: body.text?.body ?? "" };
  }
  const i = body.interactive;
  const base = {
    text: i?.body?.text ?? "",
    header: i?.header?.text,
    footer: i?.footer?.text,
  };
  if (i?.type === "button") {
    return {
      ...base,
      kind: "buttons",
      buttons: (i.action?.buttons ?? []).map((b) => ({
        id: b.reply?.id ?? "",
        title: b.reply?.title ?? "",
      })),
    };
  }
  if (i?.type === "list") {
    const rows = (i.action?.sections ?? []).flatMap((s) => s.rows ?? []);
    return {
      ...base,
      kind: "list",
      rows: rows.map((r) => ({ id: r.id ?? "", title: r.title ?? "" })),
    };
  }
  return { kind: "unknown", text: base.text };
}

export function renderMessage(row: MessageRow): RenderedMessage {
  let parsed: Partial<RenderedMessage> = { kind: "unknown", text: "" };
  try {
    const body = JSON.parse(row.body_json) as InboundBody & OutboundBody;
    parsed =
      row.direction === "in" ? renderInbound(body) : renderOutbound(body);
  } catch {
    parsed = { kind: "unknown", text: "" };
  }

  let ai: RenderedMessage["ai"];
  if (row.ai_meta_json) {
    try {
      const m = JSON.parse(row.ai_meta_json) as {
        model?: string;
        latencyMs?: number;
        tokens?: number;
      };
      if (m.model)
        ai = { model: m.model, latencyMs: m.latencyMs, tokens: m.tokens };
    } catch {
      /* ignore malformed ai meta */
    }
  }

  return {
    id: row.id,
    direction: row.direction,
    kind: parsed.kind ?? "unknown",
    text: parsed.text ?? "",
    buttons: parsed.buttons,
    rows: parsed.rows,
    header: parsed.header,
    footer: parsed.footer,
    reply: parsed.reply,
    status: row.status,
    ai,
    createdAt: row.created_at,
  };
}

// --- CSV export -----------------------------------------------------------

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}
