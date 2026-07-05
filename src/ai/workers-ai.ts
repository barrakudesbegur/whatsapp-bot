/**
 * Workers AI provider (PLAN 4.6). Gemma 3 12B behind the AiProvider interface;
 * prompt = Kudi persona + static kb/ + dynamic kb_entries + course_status +
 * conversation snippet (see src/ai/prompt.ts).
 *
 * Degrades gracefully: any model/binding error falls back to the deterministic
 * stub's canned Catalan line (never crashes the webhook). This also makes
 * local `wrangler dev` usable without Cloudflare auth — AI calls fail → canned
 * fallback, everything else works.
 */

import type { Store, MessageRow } from "../db/store.ts";
import type { Env } from "../types.ts";
import {
  buildAnswerSystemPrompt,
  buildInterpretMessages,
  parseInterpretResponse,
} from "./prompt.ts";
import { STATIC_KB } from "../kb/static.ts";
import { fetchEventsSection } from "../kb/events.ts";
import {
  StubAiProvider,
  type AiMeta,
  type AiProvider,
  type AnswerContext,
  type AnswerResult,
  type InterpretContext,
  type InterpretResult,
} from "./provider.ts";

export const PRIMARY_MODEL = "@cf/google/gemma-3-12b-it";
// Fallback candidates (compare manually with `node scripts/eval-catalan.ts`):
//   "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
//   "@cf/mistralai/mistral-small-3.1-24b-instruct"

interface ChatResult {
  response?: string;
  usage?: { total_tokens?: number };
}

function textOf(res: unknown): string {
  if (typeof res === "string") return res;
  const r = res as ChatResult | null;
  return typeof r?.response === "string" ? r.response : "";
}

function tokensOf(res: unknown): number | undefined {
  const r = res as ChatResult | null;
  const t = r?.usage?.total_tokens;
  return typeof t === "number" ? t : undefined;
}

export class WorkersAiProvider implements AiProvider {
  private readonly canned = new StubAiProvider();

  constructor(
    private readonly env: Env,
    private readonly store: Store,
  ) {}

  async answerQuestion(ctx: AnswerContext): Promise<AnswerResult> {
    const t0 = Date.now();
    try {
      const [entries, status, note, snippet, events] = await Promise.all([
        this.store.listKbEntries(true),
        this.store.getSetting("course_status"),
        this.store.getSetting("course_status_note"),
        this.snippet(ctx.personId),
        fetchEventsSection(this.env),
      ]);
      const system = buildAnswerSystemPrompt({
        staticKb: STATIC_KB,
        dynamicEntries: entries.map((e) => ({
          title: e.title,
          content: e.content_md,
        })),
        courseStatus: status ?? "exploring",
        courseStatusNote: note ?? "",
        eventsSection: events,
        displayName: ctx.displayName,
        hasCompletedSurvey: ctx.hasCompletedSurvey,
        hasPendingQuestion: ctx.hasPendingQuestion,
        conversationSnippet: snippet,
      });
      const res = await this.env.AI.run(
        PRIMARY_MODEL as Parameters<Ai["run"]>[0],
        {
          messages: [
            { role: "system", content: system },
            { role: "user", content: ctx.question },
          ],
          max_tokens: 256,
        },
      );
      const text = textOf(res).trim();
      if (!text) throw new Error("empty model response");
      return { text, meta: this.meta(t0, tokensOf(res)) };
    } catch (err) {
      console.error("Workers AI answerQuestion failed → canned fallback", err);
      const fallback = await this.canned.answerQuestion(ctx);
      return { text: fallback.text, meta: this.errorMeta(t0) };
    }
  }

  async interpretStepAnswer(ctx: InterpretContext): Promise<InterpretResult> {
    const t0 = Date.now();
    try {
      const res = await this.env.AI.run(
        PRIMARY_MODEL as Parameters<Ai["run"]>[0],
        {
          messages: buildInterpretMessages({
            field: ctx.field,
            options: ctx.options,
            text: ctx.text,
          }),
          max_tokens: 64,
        },
      );
      const value = parseInterpretResponse(textOf(res), ctx.options);
      return { value, raw: ctx.text, meta: this.meta(t0, tokensOf(res)) };
    } catch (err) {
      console.error("Workers AI interpretStepAnswer failed", err);
      return { value: null, raw: ctx.text, meta: this.errorMeta(t0) };
    }
  }

  /** Last few conversation turns as "Persona:/Kudi:" lines, for the prompt. */
  private async snippet(personId?: number): Promise<string | undefined> {
    if (!personId) return undefined;
    try {
      const rows = await this.store.listMessagesForPerson(personId);
      const lines = rows
        .slice(-6)
        .map((r) => {
          const text = messageText(r);
          return text
            ? `${r.direction === "in" ? "Persona" : "Kudi"}: ${text}`
            : null;
        })
        .filter((l): l is string => l !== null);
      return lines.length > 0 ? lines.join("\n") : undefined;
    } catch {
      return undefined;
    }
  }

  private meta(t0: number, tokens?: number): AiMeta {
    return { model: PRIMARY_MODEL, latencyMs: Date.now() - t0, tokens };
  }

  private errorMeta(t0: number): AiMeta {
    return { model: `${PRIMARY_MODEL}#error`, latencyMs: Date.now() - t0 };
  }
}

/** Human-readable text of a stored message row (inbound raw / outbound payload). */
export function messageText(row: MessageRow): string | null {
  try {
    const body = JSON.parse(row.body_json) as {
      text?: { body?: unknown };
      interactive?: {
        body?: { text?: unknown };
        button_reply?: { title?: unknown };
        list_reply?: { title?: unknown };
      };
    };
    if (typeof body.text?.body === "string") return body.text.body;
    const i = body.interactive;
    for (const candidate of [
      i?.button_reply?.title,
      i?.list_reply?.title,
      i?.body?.text,
    ]) {
      if (typeof candidate === "string") return candidate;
    }
    return null;
  } catch {
    return null;
  }
}
