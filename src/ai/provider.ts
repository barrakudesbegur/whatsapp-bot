/**
 * AI fallback provider interface + a deterministic stub.
 *
 * The router depends only on this interface. The next stage (PLAN 4.6) swaps in
 * a Workers AI implementation (Gemma 3) with the static `kb/` + `kb_entries` +
 * course_status injected into the prompt — ONLY this file changes.
 *
 * Two capabilities:
 *  - answerQuestion:     KB Q&A in Kudi's voice (off-topic / general questions).
 *  - interpretStepAnswer: map off-script free text to a structured value for a
 *    flow step. Returning `null` means "not understood" — scripted parsing keeps
 *    whatever it can, and the flow re-asks.
 */

export interface AiMeta {
  model: string;
  latencyMs: number;
  /** Present once a real model reports usage. */
  tokens?: number;
}

export interface AnswerContext {
  /** The user's raw inbound text. */
  question: string;
  /** DB person id — lets the provider pull a short conversation snippet. */
  personId?: number;
  displayName?: string;
  /** True if this person already completed the curs-sardanes survey. */
  hasCompletedSurvey: boolean;
  /** True if this person is mid-flow (used to steer back to the question). */
  hasPendingQuestion: boolean;
}

export interface AnswerResult {
  text: string;
  meta: AiMeta;
}

export interface InterpretContext {
  /** The user's raw off-script text. */
  text: string;
  /** The flow field being interpreted, e.g. 'availability'. */
  field: string;
  /** Canonical option ids the value should map to (or 'custom'/null). */
  options: string[];
}

export interface InterpretResult {
  /** One of `options`, the string 'custom', or null when not understood. */
  value: string | null;
  raw: string;
  meta: AiMeta;
}

export interface AiProvider {
  answerQuestion(ctx: AnswerContext): Promise<AnswerResult>;
  interpretStepAnswer(ctx: InterpretContext): Promise<InterpretResult>;
}

/**
 * Deterministic stub used until the Workers AI provider lands. Answers with a
 * polite canned Catalan line (nudging the survey when appropriate) and never
 * interprets off-script answers (returns null so scripted parsing stays in
 * charge). No network, no randomness — safe for tests and log-only local dev.
 */
export class StubAiProvider implements AiProvider {
  private meta(): AiMeta {
    return { model: "stub", latencyMs: 0 };
  }

  async answerQuestion(ctx: AnswerContext): Promise<AnswerResult> {
    const name = ctx.displayName?.trim();
    const hi = name ? `Ei, ${name}! ` : "Ei! ";
    let text =
      `${hi}Ara mateix no et puc respondre això com cal 😅 (encara estic ` +
      "aprenent). Si és urgent, escriu-nos a l'Instagram @barrakudesbegur i " +
      "t'ho responem de seguida! 🧡";
    if (!ctx.hasCompletedSurvey && !ctx.hasPendingQuestion) {
      text +=
        " Per cert, si vols que t'expliqui això del curs de sardanes, digues-m'ho 💃";
    }
    return { text, meta: this.meta() };
  }

  async interpretStepAnswer(ctx: InterpretContext): Promise<InterpretResult> {
    return { value: null, raw: ctx.text, meta: this.meta() };
  }
}
