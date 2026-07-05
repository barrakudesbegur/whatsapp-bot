/**
 * Prompt assembly for Kudi's AI fallback (PLAN 4.6). Pure functions, unit
 * tested without a model. The Workers AI provider feeds them the static KB
 * (imported at build time), the dynamic kb_entries rows, the course status
 * setting and a short conversation snippet.
 */

export interface AnswerPromptInput {
  staticKb: string;
  dynamicEntries: { title: string; content: string }[];
  courseStatus: string;
  courseStatusNote: string;
  /** Formatted agenda lines fetched live from the landing (no duplication). */
  eventsSection?: string;
  displayName?: string;
  hasCompletedSurvey: boolean;
  hasPendingQuestion: boolean;
  conversationSnippet?: string;
}

const COURSE_STATUS_CA: Record<string, string> = {
  exploring:
    "encara és només una idea; estem mirant si hi ha prou gent interessada",
  confirmed: "CONFIRMAT: el curs es farà!",
  cancelled: "descartat: de moment no es farà",
};

export function buildAnswerSystemPrompt(i: AnswerPromptInput): string {
  const parts: string[] = [
    "Ets en Kudi, el nino taronja del logo dels Barrakudes de Begur — el bot de WhatsApp de l'associació.",
    "Veu: català informal (sempre de tu), càlid, una mica murri, missatges CURTS (1-3 frases), com a màxim 2 emojis.",
    "REGLES ESTRICTES:",
    "- Respon NOMÉS amb informació del CONEIXEMENT de sota. Si no ho saps, digues que no ho saps i recomana preguntar-ho a l'Instagram @barrakudesbegur. No t'inventis MAI dates, preus ni detalls.",
    "- Si et demanen esborrar les seves dades, digues-los que t'escriguin exactament «esborra les meves dades».",
    "- Respon sempre en català, tret que et parlin clarament en un altre idioma.",
  ];
  if (i.displayName) parts.push(`La persona es diu ${i.displayName}.`);

  parts.push("\n## CONEIXEMENT\n" + i.staticKb.trim());
  if (i.dynamicEntries.length > 0) {
    parts.push("\n## MÉS CONEIXEMENT (actualitzat pels organitzadors)");
    for (const e of i.dynamicEntries) {
      parts.push(`### ${e.title}\n${e.content.trim()}`);
    }
  }

  const statusCa = COURSE_STATUS_CA[i.courseStatus] ?? i.courseStatus;
  parts.push(
    "\n## ESTAT ACTUAL DEL CURS DE SARDANES\n" +
      statusCa +
      (i.courseStatusNote ? ` — ${i.courseStatusNote}` : ""),
  );

  if (i.eventsSection) {
    parts.push(
      "\n## AGENDA DELS BARRAKUDES (de barrakudesbegur.org; PROPER = encara ha de passar)\n" +
        i.eventsSection,
    );
  }

  if (i.conversationSnippet) {
    parts.push(
      "\n## DARRERS MISSATGES DE LA CONVERSA\n" + i.conversationSnippet,
    );
  }

  if (i.hasPendingQuestion) {
    parts.push(
      "\nAra mateix hi ha una pregunta de l'enquesta pendent de resposta: contesta breument el que et pregunten i acaba recordant-li amablement la pregunta pendent (la hi tornaràs a enviar tot seguit).",
    );
  } else if (!i.hasCompletedSurvey) {
    parts.push(
      "\nAquesta persona encara NO ha fet l'enquesta del curs de sardanes: si escau, ofereix-li de passada (que t'escrigui «Explica'm això del curs de sardanes»).",
    );
  }

  return parts.join("\n");
}

// --- Structured step interpretation ---------------------------------------

export interface InterpretPromptInput {
  /** Flow field being interpreted, e.g. 'availability' or 'name'. */
  field: string;
  /** Canonical option ids ([] for free fields like 'name'). */
  options: string[];
  /** The user's raw off-script text. */
  text: string;
}

export function buildInterpretMessages(
  i: InterpretPromptInput,
): { role: "system" | "user"; content: string }[] {
  const system =
    i.field === "name"
      ? 'Extreu el nom amb què aquesta persona vol que li diguin del seu missatge (és la resposta a "com vols que et digui?"). ' +
        'Respon NOMÉS amb JSON: {"value":"<nom>"} — o {"value":null} si el missatge no conté cap nom (per exemple, si és una pregunta).'
      : `El missatge de la persona respon la pregunta del camp "${i.field}". Mapeja'l a UNA d'aquestes opcions: ${i.options.join(", ")}. ` +
        'Si és una resposta genuïna que no encaixa amb cap opció, fes servir "custom". Si NO és cap resposta (per exemple, és una pregunta o no té res a veure), fes servir null. ' +
        'Respon NOMÉS amb JSON: {"value":"<opció>"} o {"value":null}.';
  return [
    { role: "system", content: system },
    { role: "user", content: i.text },
  ];
}

/**
 * Robustly extract `{"value": ...}` from a model response (tolerates fences and
 * surrounding prose). Validation:
 *  - with options: must be one of them or 'custom' (else null);
 *  - without options (name): any non-empty string, capped at 40 chars.
 */
export function parseInterpretResponse(
  raw: string,
  options: string[],
): string | null {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let value: unknown;
  try {
    value = (JSON.parse(match[0]) as { value?: unknown }).value;
  } catch {
    return null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  if (options.length > 0) {
    const low = trimmed.toLowerCase();
    if (options.includes(low)) return low;
    return low === "custom" ? "custom" : null;
  }
  return trimmed.slice(0, 40);
}
