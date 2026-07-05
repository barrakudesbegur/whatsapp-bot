// Thin fetch client for the /admin/api surface. All calls are same-origin and
// go through the Cloudflare Access gate (or the dev bypass).

const BASE = "/admin/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail || res.statusText);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Config {
  simulatorEnabled: boolean;
  waEnabled: boolean;
  email: string;
}

export interface Conversation {
  id: number;
  name: string;
  waId: string;
  gdprDeleted: boolean;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  windowOpen: boolean;
  flowStatus: string | null;
  flowType: string | null;
}

export interface RenderedMessage {
  id: number;
  direction: "in" | "out";
  kind: string;
  text: string;
  buttons?: { id: string; title: string }[];
  rows?: { id: string; title: string }[];
  header?: string;
  footer?: string;
  reply?: string;
  status: string | null;
  ai?: { model: string; latencyMs?: number; tokens?: number };
  createdAt: string;
}

export interface PersonDetail {
  id: number;
  name: string;
  waId: string;
  gdprDeleted: boolean;
  lastInboundAt: string | null;
  windowOpen: boolean;
}

export interface KbEntry {
  id: number;
  slug: string;
  title: string;
  content_md: string;
  active: number;
  updated_at: string;
}

export interface Settings {
  course_status: string;
  course_status_note: string;
}

export const api = {
  config: () => fetch(`${BASE}/config`).then(json<Config>),

  conversations: () =>
    fetch(`${BASE}/conversations`).then(
      json<{ conversations: Conversation[] }>,
    ),

  messages: (id: number) =>
    fetch(`${BASE}/conversations/${id}/messages`).then(
      json<{ person: PersonDetail; messages: RenderedMessage[] }>,
    ),

  reply: (id: number, text: string) =>
    fetch(`${BASE}/conversations/${id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(json<{ status: string }>),

  erase: (id: number) =>
    fetch(`${BASE}/people/${id}/erase`, { method: "POST" }).then(
      json<{ erased: boolean }>,
    ),

  kb: () => fetch(`${BASE}/kb`).then(json<{ entries: KbEntry[] }>),

  saveKb: (entry: {
    slug: string;
    title: string;
    content_md: string;
    active: boolean;
  }) =>
    fetch(`${BASE}/kb`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    }).then(json<{ entry: KbEntry }>),

  deleteKb: (id: number) =>
    fetch(`${BASE}/kb/${id}`, { method: "DELETE" }).then(
      json<{ deleted: boolean }>,
    ),

  settings: () => fetch(`${BASE}/settings`).then(json<Settings>),

  saveSettings: (s: Settings) =>
    fetch(`${BASE}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(s),
    }).then(json<Settings>),

  exportUrl: () => `${BASE}/export/curs-sardanes.csv`,
};

// The dev simulator endpoint (separate from /admin/api; only when enabled).
export interface SimReply {
  wa_message_id: string;
  status: string;
  message: {
    kind: string;
    body?: string;
    buttons?: { id: string; title: string }[];
    rows?: { id: string; title: string }[];
    sections?: { rows?: { id: string; title: string }[] }[];
  };
}

export async function simulate(payload: unknown): Promise<SimReply[]> {
  const res = await fetch("/dev/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await json<{ messages: SimReply[] }>(res);
  return body.messages;
}
