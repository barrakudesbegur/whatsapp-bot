/**
 * Manual Catalan-quality eval across Workers AI models (PLAN 4.6).
 *
 * Runs ~15 sample utterances (off-script survey answers, FAQs, gibberish,
 * GDPR phrasing) against the candidate models via the Workers AI REST API and
 * prints the answers + latency side by side, so a human can pick the model.
 *
 * Requires (Workers AI needs Cloudflare auth even for evals):
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/eval-catalan.ts
 * (Node >= 22.6 runs TypeScript directly via type stripping.)
 */

import { readFileSync } from "node:fs";
import {
  buildAnswerSystemPrompt,
  buildInterpretMessages,
} from "../src/ai/prompt.ts";

const MODELS = [
  "@cf/google/gemma-3-12b-it",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
];

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!ACCOUNT || !TOKEN) {
  console.error(
    "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI needs Cloudflare auth).",
  );
  process.exit(1);
}

const staticKb = ["que-es-barrakudes", "kudi", "xarxes", "curs-sardanes-faq"]
  .map((f) => readFileSync(new URL(`../kb/${f}.md`, import.meta.url), "utf8"))
  .join("\n\n");

type Case =
  | { kind: "answer"; label: string; text: string }
  | { kind: "interpret-availability"; label: string; text: string }
  | { kind: "interpret-name"; label: string; text: string };

const CASES: Case[] = [
  // FAQs / general Q&A (KB should cover; watch for hallucinated details)
  {
    kind: "answer",
    label: "faq: què és Barrakudes",
    text: "què és barrakudes?",
  },
  { kind: "answer", label: "faq: qui ets", text: "qui ets tu?" },
  {
    kind: "answer",
    label: "faq: quan comença",
    text: "quan començarà el curs?",
  },
  { kind: "answer", label: "faq: preu", text: "quant costarà?" },
  { kind: "answer", label: "faq: on", text: "on es farà el curs?" },
  { kind: "answer", label: "novetats", text: "hi ha novetats del curs?" },
  {
    kind: "answer",
    label: "invent-bait: ajuntament",
    text: "sou de l'ajuntament, no?",
  },
  {
    kind: "answer",
    label: "invent-bait: bitcoin",
    text: "es pot pagar amb bitcoin?",
  },
  {
    kind: "answer",
    label: "gdpr phrasing",
    text: "com puc fer que esborreu les meves dades?",
  },
  { kind: "answer", label: "gibberish", text: "asdkjh puf lolo??" },
  // Off-script survey answers (availability step)
  {
    kind: "interpret-availability",
    label: "avail: dissabtes matí",
    text: "els dissabtes al matí m'aniria genial",
  },
  {
    kind: "interpret-availability",
    label: "avail: entre setmana",
    text: "jo només puc entre setmana a les tardes",
  },
  {
    kind: "interpret-availability",
    label: "avail: depèn",
    text: "buf, depèn de la feina, no t'ho sé dir",
  },
  {
    kind: "interpret-availability",
    label: "avail: custom divendres",
    text: "i si ho féssiu els divendres a la nit?",
  },
  {
    kind: "interpret-availability",
    label: "avail: no és resposta",
    text: "i quant durarà cada sessió?",
  },
  // Name extraction (K1)
  { kind: "interpret-name", label: "name: em dic", text: "em dic Montse" },
  {
    kind: "interpret-name",
    label: "name: lead-in llarg",
    text: "hola! sóc en Pep de can Rovira",
  },
];

const AVAILABILITY_OPTIONS = [
  "dissabtes",
  "diumenges",
  "entre-setmana",
  "depen",
  "igual",
];

function messagesFor(c: Case): { role: string; content: string }[] {
  if (c.kind === "answer") {
    const system = buildAnswerSystemPrompt({
      staticKb,
      dynamicEntries: [],
      courseStatus: "exploring",
      courseStatusNote: "",
      hasCompletedSurvey: false,
      hasPendingQuestion: false,
    });
    return [
      { role: "system", content: system },
      { role: "user", content: c.text },
    ];
  }
  return buildInterpretMessages({
    field: c.kind === "interpret-name" ? "name" : "availability",
    options: c.kind === "interpret-name" ? [] : AVAILABILITY_OPTIONS,
    text: c.text,
  });
}

async function run(
  model: string,
  c: Case,
): Promise<{ text: string; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: messagesFor(c),
        max_tokens: c.kind === "answer" ? 256 : 64,
      }),
    },
  );
  const ms = Date.now() - t0;
  const body = (await res.json()) as {
    result?: { response?: string };
    errors?: unknown;
  };
  if (!res.ok || !body.result) {
    return { text: `ERROR ${res.status}: ${JSON.stringify(body.errors)}`, ms };
  }
  return { text: (body.result.response ?? "").trim(), ms };
}

for (const c of CASES) {
  console.log(`\n━━━ [${c.kind}] ${c.label}\n    «${c.text}»`);
  for (const model of MODELS) {
    const { text, ms } = await run(model, c);
    const oneLine = text.replace(/\s+/g, " ").slice(0, 220);
    console.log(
      `  · ${model.padEnd(48)} ${String(ms).padStart(5)}ms  ${oneLine}`,
    );
  }
}
