/**
 * Turn a raw Cloud API webhook envelope into normalized events the router can
 * consume. Preserves the raw message for D1 body_json.
 */

import type { FlowInput } from "../flows/types.ts";
import type { InboundMessage, StatusUpdate, WebhookEnvelope } from "./wire.ts";

export interface ParsedMessage {
  waMessageId: string;
  from: string;
  /** D1 msg_type: text | button_reply | list_reply | <raw media type>. */
  msgType: string;
  input: FlowInput;
  /** Interactive replies carry context.id → the outbound message replied to. */
  contextId?: string;
  raw: InboundMessage;
}

export interface ParsedInbound {
  waId: string;
  profileName?: string;
  phoneNumberId?: string;
  message: ParsedMessage;
}

export interface ParsedWebhook {
  messages: ParsedInbound[];
  statuses: StatusUpdate[];
}

function toFlowInput(m: InboundMessage): {
  input: FlowInput;
  msgType: string;
} {
  if (m.type === "text" && m.text) {
    return {
      input: { kind: "text", text: m.text.body ?? "" },
      msgType: "text",
    };
  }
  if (m.type === "interactive" && m.interactive) {
    const it = m.interactive;
    if (it.type === "button_reply" && it.button_reply) {
      return {
        input: {
          kind: "button",
          id: it.button_reply.id,
          title: it.button_reply.title,
        },
        msgType: "button_reply",
      };
    }
    if (it.type === "list_reply" && it.list_reply) {
      return {
        input: {
          kind: "list",
          id: it.list_reply.id,
          title: it.list_reply.title,
        },
        msgType: "list_reply",
      };
    }
  }
  // image / audio / video / sticker / document / location / contacts / reaction…
  return { input: { kind: "unsupported", msgType: m.type }, msgType: m.type };
}

export function parseWebhook(envelope: WebhookEnvelope): ParsedWebhook {
  const messages: ParsedInbound[] = [];
  const statuses: StatusUpdate[] = [];

  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const phoneNumberId = value.metadata?.phone_number_id;

      // Build a wa_id → profile name map from contacts for this change.
      const profileByWaId = new Map<string, string | undefined>();
      for (const c of value.contacts ?? []) {
        if (c.wa_id) profileByWaId.set(c.wa_id, c.profile?.name);
      }

      for (const m of value.messages ?? []) {
        if (!m.id || !m.from) continue;
        const { input, msgType } = toFlowInput(m);
        messages.push({
          waId: m.from,
          profileName: profileByWaId.get(m.from),
          phoneNumberId,
          message: {
            waMessageId: m.id,
            from: m.from,
            msgType,
            input,
            contextId: m.context?.id,
            raw: m,
          },
        });
      }

      for (const s of value.statuses ?? []) {
        if (s.id) statuses.push(s);
      }
    }
  }

  return { messages, statuses };
}
