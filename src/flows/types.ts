/**
 * Flow engine contracts.
 *
 * A flow is a PURE module: given a context (person + collected data) and an
 * input, it returns messages to send and a state patch. It never touches D1 or
 * WhatsApp — the router (src/router.ts) persists the patch and sends the
 * messages. This is what makes every step and branch unit-testable.
 */

import type { OutMessage } from "../messages.ts";

export type FlowStatus = "active" | "completed" | "abandoned" | "declined";

/** Read-only view of a person + their flow state handed to a flow module. */
export interface FlowContext {
  /** From the WhatsApp webhook contact profile. */
  profileName?: string;
  /** people.display_name — the name the user asked to be called ("{nom}"). */
  displayName?: string;
  /** The flow_instance.data_json parsed — answers collected so far. */
  data: Record<string, unknown>;
}

/**
 * Normalized inbound handed to a flow step. `interpreted` is fed back by the
 * router after the AI provider maps off-script free text to a canonical value.
 */
export type FlowInput =
  | { kind: "text"; text: string }
  | { kind: "button"; id: string; title: string }
  | { kind: "list"; id: string; title: string }
  | { kind: "interpreted"; value: string; raw: string }
  | { kind: "unsupported"; msgType: string };

/** State changes for the flow_instance the router should persist. */
export interface FlowPatch {
  status?: FlowStatus;
  /** New current step; `null` clears it (flow no longer awaiting input). */
  step?: string | null;
  /** Shallow-merged into data_json. */
  data?: Record<string, unknown>;
  /** Written to people.display_name when set. */
  displayName?: string;
  /** Set when the flow reaches a terminal state, to stamp completed_at. */
  done?: boolean;
}

/**
 * Router instructions emitted when a step can't parse its input on its own.
 * The router runs the AI provider and then either feeds the interpreted value
 * back (`interpret`) or answers the question from the KB and re-asks `pending`.
 */
export interface DeferToAi {
  /** Ask the AI to map free text to one of `options` for `field`. */
  interpret?: { field: string; options: string[] };
}

export interface FlowResult {
  messages: OutMessage[];
  patch?: FlowPatch;
  deferToAi?: DeferToAi;
}

export interface FlowModule {
  /** flow_instance.flow_type, e.g. 'curs-sardanes'. */
  readonly type: string;
  /** Raw trigger phrase (normalized fuzzy-matched by the router). */
  readonly trigger: string;
  /** Begin (or restart) the flow. Returns the first question. */
  start(ctx: FlowContext): FlowResult;
  /** Handle an input for the given step. */
  onStep(ctx: FlowContext, step: string, input: FlowInput): FlowResult;
  /** The current step's question message(s) — re-asked after interruptions. */
  pending(ctx: FlowContext, step: string): OutMessage[];
  /** Optional: a person who already COMPLETED this flow re-triggers it. */
  onReturningCompleted?(ctx: FlowContext): FlowResult;
}
