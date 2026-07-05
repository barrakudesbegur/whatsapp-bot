/**
 * AI stage tests (PLAN 4.6): prompt assembly, structured-interpretation
 * parsing, the Workers AI provider with a mocked AI binding (happy, malformed
 * and error paths), the live events feed, and the flow's name interpretation.
 */

import { describe, expect, it } from "vitest";
import {
  buildAnswerSystemPrompt,
  buildInterpretMessages,
  parseInterpretResponse,
} from "../src/ai/prompt.ts";
import {
  PRIMARY_MODEL,
  WorkersAiProvider,
  messageText,
} from "../src/ai/workers-ai.ts";
import { fetchEventsSection } from "../src/kb/events.ts";
import { MemoryStore } from "../src/db/memory.ts";
import { STEP, cursSardanesFlow } from "../src/flows/curs-sardanes.ts";
import type { Env } from "../src/types.ts";
import type { MessageRow } from "../src/db/store.ts";

const AVAIL = ["dissabtes", "diumenges", "entre-setmana", "depen", "igual"];

function fakeEnv(
  run: (model: unknown, input: unknown) => Promise<unknown>,
): Env {
  return { AI: { run } } as unknown as Env;
}

const BASE_PROMPT = {
  staticKb: "STATIC-KB-TEXT",
  dynamicEntries: [],
  courseStatus: "exploring",
  courseStatusNote: "",
  hasCompletedSurvey: false,
  hasPendingQuestion: false,
};

describe("prompt assembly", () => {
  it("includes the static KB and offers the survey to newcomers", () => {
    const p = buildAnswerSystemPrompt(BASE_PROMPT);
    expect(p).toContain("STATIC-KB-TEXT");
    expect(p).toContain("encara NO ha fet l'enquesta");
    expect(p).toContain("@barrakudesbegur");
  });

  it("injects dynamic entries, course status + note, events and the pending steer", () => {
    const p = buildAnswerSystemPrompt({
      ...BASE_PROMPT,
      dynamicEntries: [{ title: "Nova junta", content: "Hi ha junta nova." }],
      courseStatus: "confirmed",
      courseStatusNote: "comencem a l'octubre",
      eventsSection: "- [PROPER] 2026-10-04 — Curs de sardanes: yay (url)",
      conversationSnippet: "Persona: hola\nKudi: Ei!",
      hasPendingQuestion: true,
    });
    expect(p).toContain("Nova junta");
    expect(p).toContain("CONFIRMAT");
    expect(p).toContain("comencem a l'octubre");
    expect(p).toContain("2026-10-04");
    expect(p).toContain("Persona: hola");
    expect(p).toContain("pregunta pendent");
    expect(p).not.toContain("encara NO ha fet l'enquesta");
  });

  it("builds interpret messages for options and for name extraction", () => {
    const avail = buildInterpretMessages({
      field: "availability",
      options: AVAIL,
      text: "els matins",
    });
    expect(avail[0]?.content).toContain("dissabtes");
    expect(avail[1]?.content).toBe("els matins");
    const name = buildInterpretMessages({
      field: "name",
      options: [],
      text: "sóc la Núria",
    });
    expect(name[0]?.content).toContain("nom");
  });
});

describe("parseInterpretResponse", () => {
  it("parses plain and fenced JSON", () => {
    expect(parseInterpretResponse('{"value":"dissabtes"}', AVAIL)).toBe(
      "dissabtes",
    );
    expect(
      parseInterpretResponse(
        'És clar!\n```json\n{"value": "custom"}\n```',
        AVAIL,
      ),
    ).toBe("custom");
  });

  it("rejects out-of-options values, garbage and nulls", () => {
    expect(parseInterpretResponse('{"value":"dimarts"}', AVAIL)).toBeNull();
    expect(parseInterpretResponse("cap json aquí", AVAIL)).toBeNull();
    expect(parseInterpretResponse('{"value":null}', AVAIL)).toBeNull();
    expect(parseInterpretResponse('{"value":"NULL"}', AVAIL)).toBeNull();
  });

  it("name mode accepts any short string and caps it", () => {
    expect(parseInterpretResponse('{"value":"Montse"}', [])).toBe("Montse");
    expect(
      parseInterpretResponse(`{"value":"${"x".repeat(80)}"}`, []),
    ).toHaveLength(40);
  });
});

describe("WorkersAiProvider", () => {
  it("answers via the model, with KB + status in the system prompt and meta logged", async () => {
    let seen: { messages: { role: string; content: string }[] } | undefined;
    const env = fakeEnv(async (_m, input) => {
      seen = input as typeof seen;
      return { response: "Hola, Maria!", usage: { total_tokens: 42 } };
    });
    const store = new MemoryStore();
    await store.upsertKbEntry({
      slug: "junta",
      title: "Assaig de prova",
      contentMd: "hi ha assaig dijous",
      active: true,
      at: "2026-07-05T00:00:00Z",
    });
    await store.setSetting(
      "course_status",
      "confirmed",
      "2026-07-05T00:00:00Z",
    );
    const provider = new WorkersAiProvider(env, store);

    const res = await provider.answerQuestion({
      question: "hi ha novetats?",
      hasCompletedSurvey: false,
      hasPendingQuestion: false,
    });

    expect(res.text).toBe("Hola, Maria!");
    expect(res.meta.model).toBe(PRIMARY_MODEL);
    expect(res.meta.tokens).toBe(42);
    expect(res.meta.latencyMs).toBeGreaterThanOrEqual(0);
    expect(seen?.messages[0]?.role).toBe("system");
    expect(seen?.messages[0]?.content).toContain("Assaig de prova");
    expect(seen?.messages[0]?.content).toContain("CONFIRMAT");
    expect(seen?.messages[1]?.content).toBe("hi ha novetats?");
  });

  it("inactive kb entries stay out of the prompt", async () => {
    let system = "";
    const env = fakeEnv(async (_m, input) => {
      system = (input as { messages: { content: string }[] }).messages[0]!
        .content;
      return { response: "ok" };
    });
    const store = new MemoryStore();
    await store.upsertKbEntry({
      slug: "off",
      title: "Entrada desactivada",
      contentMd: "no m'hauries de veure",
      active: false,
      at: "2026-07-05T00:00:00Z",
    });
    await new WorkersAiProvider(env, store).answerQuestion({
      question: "?",
      hasCompletedSurvey: true,
      hasPendingQuestion: false,
    });
    expect(system).not.toContain("Entrada desactivada");
  });

  it("falls back to the canned Catalan line when the model errors", async () => {
    const env = fakeEnv(async () => {
      throw new Error("boom");
    });
    const provider = new WorkersAiProvider(env, new MemoryStore());
    const res = await provider.answerQuestion({
      question: "què és això?",
      hasCompletedSurvey: false,
      hasPendingQuestion: false,
    });
    expect(res.text).toContain("Instagram");
    expect(res.meta.model).toContain("#error");
  });

  it("interprets step answers and survives malformed output", async () => {
    let output = '{"value":"diumenges"}';
    const env = fakeEnv(async () => ({ response: output }));
    const provider = new WorkersAiProvider(env, new MemoryStore());

    const ok = await provider.interpretStepAnswer({
      text: "els diumenges em va perfecte",
      field: "availability",
      options: AVAIL,
    });
    expect(ok.value).toBe("diumenges");
    expect(ok.raw).toBe("els diumenges em va perfecte");

    output = "sóc un model que no sap fer JSON";
    const bad = await provider.interpretStepAnswer({
      text: "?",
      field: "availability",
      options: AVAIL,
    });
    expect(bad.value).toBeNull();
  });

  it("extracts readable text from stored rows for the snippet", () => {
    const row = (bodyJson: string): MessageRow =>
      ({ body_json: bodyJson, direction: "in" }) as MessageRow;
    expect(messageText(row(JSON.stringify({ text: { body: "hola" } })))).toBe(
      "hola",
    );
    expect(
      messageText(
        row(JSON.stringify({ interactive: { button_reply: { title: "Sí" } } })),
      ),
    ).toBe("Sí");
    expect(messageText(row("not json"))).toBeNull();
  });
});

describe("fetchEventsSection", () => {
  it("is disabled without a URL (unit tests never hit the network)", async () => {
    expect(await fetchEventsSection({} as Env)).toBeUndefined();
    expect(
      await fetchEventsSection({ EVENTS_JSON_URL: "off" } as Env),
    ).toBeUndefined();
  });

  it("formats upcoming and past events and fails soft", async () => {
    const payload = {
      events: [
        {
          title: "Curs de sardanes",
          description: "una idea",
          startDate: "2999-10-04T11:00:00Z",
          endDate: null,
          url: "https://barrakudesbegur.org/esdeveniments/2026-curs-sardanes/",
        },
        {
          title: "Festa Major",
          description: "festassa",
          startDate: "1999-08-01T20:00:00Z",
          endDate: null,
          url: "https://barrakudesbegur.org/esdeveniments/1999-festa-major/",
        },
      ],
    };
    const env = { EVENTS_JSON_URL: "https://example.org/events.json" } as Env;
    const section = await fetchEventsSection(
      env,
      async () => new Response(JSON.stringify(payload)),
    );
    expect(section).toContain("[PROPER] 2999-10-04 — Curs de sardanes");
    expect(section).toContain("[passat] 1999-08-01 — Festa Major");

    const broken = await fetchEventsSection(env, async () => {
      throw new Error("network down");
    });
    expect(broken).toBeUndefined();
  });
});

describe("flow name interpretation (PLAN 4.6 structured mode)", () => {
  it("uses the AI-extracted name on the name step", () => {
    const r = cursSardanesFlow.onStep({ data: {} }, STEP.NAME, {
      kind: "interpreted",
      value: "Montse",
      raw: "doncs em pots dir montse, va",
    });
    expect(r.patch?.displayName).toBe("Montse");
    expect(r.patch?.step).toBe(STEP.ACTION);
  });

  it("asks the AI to extract the name when the text is unclear", () => {
    const r = cursSardanesFlow.onStep({ data: {} }, STEP.NAME, {
      kind: "text",
      text: "però això del curs quant costa?",
    });
    expect(r.deferToAi?.interpret?.field).toBe("name");
  });
});
