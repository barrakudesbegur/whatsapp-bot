/**
 * Message router (PLAN 4.3 + 4.5 edge cases).
 *
 * Given a raw webhook envelope, dedupes, upserts the person, and routes each
 * inbound message. Routing order:
 *   0. GDPR erase intent (text) — interrupts anything.
 *   0. Unsupported media/audio/sticker — apologize + re-ask pending question.
 *   1. Interactive reply → context.id → outbound message → flow_instance → step.
 *   2. Trigger text → start / resume / returning-completed prompt.
 *   3. Active flow → treat text as the current step's answer (AI on no-parse).
 *   4. No active flow → AI fallback (KB Q&A, offer the survey).
 *
 * All flow-state writes use optimistic concurrency (updateFlowStep CAS on the
 * current step): if another concurrent webhook already advanced the flow, we
 * skip sending. All outbound messages are recorded in D1 by the Sender.
 *
 * Returns the outbound messages produced (used by /dev/simulate; ignored by the
 * real webhook, which just 200s).
 */

import type { AiProvider } from "./ai/provider.ts";
import type { Store, FlowInstanceRow, PersonRow } from "./db/store.ts";
import type { Env } from "./types.ts";
import type { OutMessage } from "./messages.ts";
import type {
  FlowContext,
  FlowInput,
  FlowModule,
  FlowResult,
} from "./flows/types.ts";
import { flowByType, flowForTrigger } from "./flows/registry.ts";
import { parseWebhook, type ParsedInbound } from "./wa/parse.ts";
import type { WebhookEnvelope, StatusUpdate } from "./wa/wire.ts";
import { Sender, type SentMessage } from "./wa/sender.ts";
import { nowIso } from "./lib/time.ts";
import { normalizeText, parseYesNo } from "./lib/normalize.ts";

const CURS_SARDANES = "curs-sardanes";
const GDPR_FLOW = "gdpr-erase";

export interface RouterDeps {
  env: Env;
  store: Store;
  ai: AiProvider;
  sender: Sender;
}

export function makeDeps(env: Env, store: Store, ai: AiProvider): RouterDeps {
  return { env, store, ai, sender: new Sender(env, store) };
}

// --- GDPR intent + copy ---------------------------------------------------

export function gdprIntent(text: string): boolean {
  const n = normalizeText(text);
  if (!n) return false;
  return /esborr.*dad|elimin.*dad|suprim.*dad|dad.*esborr|dret a l oblit|\brgpd\b|\bgdpr\b/.test(
    n,
  );
}

const GDPR_CONFIRM: OutMessage = {
  kind: "buttons",
  body: "Segur que vols que esborri totes les teves dades? Això no es pot desfer.",
  buttons: [
    { id: "gdpr_yes", title: "Sí, esborra-ho" },
    { id: "gdpr_no", title: "No, cancel·la" },
  ],
};
const GDPR_DONE =
  "Fet! He esborrat les teves dades 🧹 Si algun dia vols tornar, escriu-me i comencem de nou.";
const GDPR_KEPT = "Tranquil, no esborro res 😊 Segueix tot igual.";
const GDPR_CLARIFY = "Digues-me «sí» o «no», si us plau 🙏";
const UNSUPPORTED = "Ho sento, només sé llegir text 😅";

// --- Public entry ---------------------------------------------------------

/** Process a whole webhook envelope; returns all outbound messages produced. */
export async function handleWebhook(
  envelope: WebhookEnvelope,
  deps: RouterDeps,
): Promise<SentMessage[]> {
  const parsed = parseWebhook(envelope);
  for (const status of parsed.statuses) {
    await handleStatus(status, deps);
  }
  const out: SentMessage[] = [];
  for (const inbound of parsed.messages) {
    out.push(...(await handleMessage(inbound, deps)));
  }
  return out;
}

// --- Status webhooks (PLAN 4.5) ------------------------------------------

async function handleStatus(
  status: StatusUpdate,
  deps: RouterDeps,
): Promise<void> {
  const errorJson =
    status.errors && status.errors.length > 0
      ? JSON.stringify(status.errors)
      : null;
  const matched = await deps.store.updateOutboundStatus(
    status.id,
    status.status,
    errorJson,
    nowIso(),
  );
  if (status.status === "failed" && status.errors) {
    console.error("WA status failed", { id: status.id, errors: status.errors });
  }
  // Unknown message id → ignore gracefully (matched === false).
  void matched;
}

// --- Inbound messages -----------------------------------------------------

async function handleMessage(
  inbound: ParsedInbound,
  deps: RouterDeps,
): Promise<SentMessage[]> {
  const { store } = deps;
  const now = nowIso();
  const person = await store.upsertPerson(
    inbound.waId,
    inbound.profileName ?? null,
    now,
  );

  // Dedupe (webhook retries / out-of-order): stop if we've seen this id.
  const fresh = await store.insertInboundMessage({
    waMessageId: inbound.message.waMessageId,
    personId: person.id,
    msgType: inbound.message.msgType,
    bodyJson: JSON.stringify(inbound.message.raw),
    createdAt: now,
  });
  if (!fresh) return [];

  const input = inbound.message.input;
  const contextId = inbound.message.contextId;

  // Unsupported media/audio/sticker → apologize + re-ask (PLAN 4.5).
  if (input.kind === "unsupported") {
    return handleUnsupported(person, deps);
  }

  // Interactive reply routes by context.id (concurrent-flow safe).
  if ((input.kind === "button" || input.kind === "list") && contextId) {
    const ctxMsg = await store.getMessageByWaId(contextId);
    if (ctxMsg?.flow_instance_id) {
      const instance = await store.getFlowInstance(ctxMsg.flow_instance_id);
      if (instance) return dispatchToInstance(person, instance, input, deps);
    }
    return aiFallback(person, input, deps, null);
  }

  if (input.kind === "text") {
    const text = input.text;

    // GDPR erase intent interrupts everything.
    if (gdprIntent(text)) return startGdprErase(person, deps);

    // Trigger a flow.
    const flow = flowForTrigger(text);
    if (flow) return startOrResume(person, flow, deps);

    // Otherwise feed the active flow, if any.
    const active = await store.getActiveFlowInstance(person.id);
    if (active) return dispatchToInstance(person, active, input, deps);

    // No active flow → AI fallback (+ offer survey).
    return aiFallback(person, input, deps, null);
  }

  // Interactive reply without context → best effort via active flow / AI.
  const active = await store.getActiveFlowInstance(person.id);
  if (active) return dispatchToInstance(person, active, input, deps);
  return aiFallback(person, input, deps, null);
}

// --- Instance dispatch ----------------------------------------------------

function buildContext(
  person: PersonRow,
  instance: FlowInstanceRow | null,
): FlowContext {
  let data: Record<string, unknown> = {};
  if (instance) {
    try {
      data = JSON.parse(instance.data_json) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  return {
    profileName: person.profile_name ?? undefined,
    displayName: person.display_name ?? undefined,
    data,
  };
}

async function dispatchToInstance(
  person: PersonRow,
  instance: FlowInstanceRow,
  input: FlowInput,
  deps: RouterDeps,
): Promise<SentMessage[]> {
  if (instance.flow_type === GDPR_FLOW) {
    return handleGdprConfirm(person, instance, input, deps);
  }
  const flow = flowByType(instance.flow_type);
  if (!flow) return aiFallback(person, input, deps, instance);

  const ctx = buildContext(person, instance);
  const result = flow.onStep(ctx, instance.step ?? "", input);
  return applyResult(person, instance, flow, ctx, input, result, deps);
}

async function applyResult(
  person: PersonRow,
  instance: FlowInstanceRow,
  flow: FlowModule,
  ctx: FlowContext,
  input: FlowInput,
  result: FlowResult,
  deps: RouterDeps,
): Promise<SentMessage[]> {
  const { store, ai, sender } = deps;

  if (result.deferToAi) {
    // Try structured interpretation first (stub returns null).
    if (result.deferToAi.interpret) {
      const { field, options } = result.deferToAi.interpret;
      const interp = await ai.interpretStepAnswer({
        text: rawText(input),
        field,
        options,
      });
      if (interp.value !== null) {
        const result2 = flow.onStep(ctx, instance.step ?? "", {
          kind: "interpreted",
          value: interp.value,
          raw: interp.raw,
        });
        return applyResult(person, instance, flow, ctx, input, result2, deps);
      }
    }
    // Answer from the KB, then re-ask the pending question.
    const hasCompleted = await hasCompletedSurvey(store, person.id);
    const answer = await ai.answerQuestion({
      question: rawText(input),
      displayName: person.display_name ?? undefined,
      hasCompletedSurvey: hasCompleted,
      hasPendingQuestion: true,
    });
    const sentAnswer = await sender.send(
      person,
      [{ kind: "text", body: answer.text }],
      { flowInstanceId: instance.id, aiMeta: answer.meta },
    );
    const reask = flow.pending(ctx, instance.step ?? "");
    const sentReask = await sender.send(person, reask, {
      flowInstanceId: instance.id,
    });
    return [...sentAnswer, ...sentReask];
  }

  // Persist the state patch with optimistic concurrency, then send.
  if (result.patch) {
    const now = nowIso();
    const merged = { ...ctx.data, ...(result.patch.data ?? {}) };
    const newStatus = result.patch.status ?? instance.status;
    const newStep =
      "step" in result.patch ? (result.patch.step ?? null) : instance.step;
    const completedAt = result.patch.done ? now : null;
    const ok = await store.updateFlowStep(instance.id, instance.step, {
      status: newStatus,
      step: newStep,
      dataJson: JSON.stringify(merged),
      updatedAt: now,
      completedAt,
    });
    if (!ok) return []; // concurrency: another invocation won → skip sending
    if (result.patch.displayName) {
      await store.setDisplayName(person.id, result.patch.displayName, now);
    }
  }

  return sender.send(person, result.messages, { flowInstanceId: instance.id });
}

// --- Start / resume (PLAN 4.4 + returning-completed edge case) ------------

async function startOrResume(
  person: PersonRow,
  flow: FlowModule,
  deps: RouterDeps,
): Promise<SentMessage[]> {
  const { store, sender } = deps;
  const now = nowIso();
  const latest = await store.getLatestFlowInstance(person.id, flow.type);

  // Returning person who already completed → offer to change answers.
  if (latest && latest.status === "completed" && flow.onReturningCompleted) {
    const ctx = buildContext(person, latest);
    const result = flow.onReturningCompleted(ctx);
    const patch = result.patch ?? {};
    const merged = { ...ctx.data, ...(patch.data ?? {}) };
    await store.updateFlowInstance(latest.id, {
      status: patch.status ?? latest.status,
      step: "step" in patch ? (patch.step ?? null) : latest.step,
      dataJson: JSON.stringify(merged),
      updatedAt: now,
      completedAt: null, // preserve original completed_at (COALESCE)
    });
    return sender.send(person, result.messages, { flowInstanceId: latest.id });
  }

  // Fresh start (new / declined / abandoned / active re-trigger).
  const ctx = buildContext(person, null);
  const result = flow.start(ctx);
  const patch = result.patch ?? {};
  const instanceId = latest
    ? (await reactivate(store, latest.id, patch, now), latest.id)
    : (
        await store.createFlowInstance({
          personId: person.id,
          flowType: flow.type,
          status: patch.status ?? "active",
          step: "step" in patch ? (patch.step ?? null) : null,
          dataJson: JSON.stringify(patch.data ?? {}),
          createdAt: now,
        })
      ).id;
  return sender.send(person, result.messages, { flowInstanceId: instanceId });
}

async function reactivate(
  store: Store,
  id: number,
  patch: FlowResult["patch"] & object,
  now: string,
): Promise<void> {
  await store.updateFlowInstance(id, {
    status: patch.status ?? "active",
    step: "step" in patch ? (patch.step ?? null) : null,
    dataJson: JSON.stringify(patch.data ?? {}),
    updatedAt: now,
    completedAt: null,
  });
}

// --- AI fallback (PLAN 4.3 step 4) ---------------------------------------

async function aiFallback(
  person: PersonRow,
  input: FlowInput,
  deps: RouterDeps,
  activeInstance: FlowInstanceRow | null,
): Promise<SentMessage[]> {
  const hasCompleted = await hasCompletedSurvey(deps.store, person.id);
  const answer = await deps.ai.answerQuestion({
    question: rawText(input),
    displayName: person.display_name ?? undefined,
    hasCompletedSurvey: hasCompleted,
    hasPendingQuestion: activeInstance !== null,
  });
  return deps.sender.send(person, [{ kind: "text", body: answer.text }], {
    flowInstanceId: activeInstance?.id ?? null,
    aiMeta: answer.meta,
  });
}

// --- Unsupported media (PLAN 4.5) ----------------------------------------

async function handleUnsupported(
  person: PersonRow,
  deps: RouterDeps,
): Promise<SentMessage[]> {
  const active = await deps.store.getActiveFlowInstance(person.id);
  const messages: OutMessage[] = [{ kind: "text", body: UNSUPPORTED }];
  if (active) {
    const flow = flowByType(active.flow_type);
    if (flow) {
      const ctx = buildContext(person, active);
      messages.push(...flow.pending(ctx, active.step ?? ""));
    }
  }
  return deps.sender.send(person, messages, {
    flowInstanceId: active?.id ?? null,
  });
}

// --- GDPR erase (PLAN 4.5) -----------------------------------------------

async function startGdprErase(
  person: PersonRow,
  deps: RouterDeps,
): Promise<SentMessage[]> {
  const { store, sender } = deps;
  const now = nowIso();
  const latest = await store.getLatestFlowInstance(person.id, GDPR_FLOW);
  let instanceId: number;
  if (latest) {
    await store.updateFlowInstance(latest.id, {
      status: "active",
      step: "confirm_erase",
      dataJson: "{}",
      updatedAt: now,
      completedAt: null,
    });
    instanceId = latest.id;
  } else {
    instanceId = (
      await store.createFlowInstance({
        personId: person.id,
        flowType: GDPR_FLOW,
        status: "active",
        step: "confirm_erase",
        dataJson: "{}",
        createdAt: now,
      })
    ).id;
  }
  return sender.send(person, [GDPR_CONFIRM], { flowInstanceId: instanceId });
}

async function handleGdprConfirm(
  person: PersonRow,
  instance: FlowInstanceRow,
  input: FlowInput,
  deps: RouterDeps,
): Promise<SentMessage[]> {
  const { store, sender } = deps;
  const now = nowIso();

  let decision: "yes" | "no" | null = null;
  if (input.kind === "button") {
    decision =
      input.id === "gdpr_yes" ? "yes" : input.id === "gdpr_no" ? "no" : null;
  } else if (input.kind === "text") {
    decision = parseYesNo(input.text);
  }

  if (decision === "yes") {
    const ok = await store.updateFlowStep(instance.id, instance.step, {
      status: "completed",
      step: null,
      dataJson: "{}",
      updatedAt: now,
      completedAt: now,
    });
    if (!ok) return [];
    const sent = await sender.send(
      person,
      [{ kind: "text", body: GDPR_DONE }],
      {
        flowInstanceId: instance.id,
      },
    );
    // Scrub the person + delete their messages (the confirmation row included).
    await store.anonymizePerson(person.id, now);
    return sent;
  }

  if (decision === "no") {
    const ok = await store.updateFlowStep(instance.id, instance.step, {
      status: "declined",
      step: null,
      dataJson: "{}",
      updatedAt: now,
      completedAt: null,
    });
    if (!ok) return [];
    return sender.send(person, [{ kind: "text", body: GDPR_KEPT }], {
      flowInstanceId: instance.id,
    });
  }

  // Unclear → re-ask.
  return sender.send(
    person,
    [{ kind: "text", body: GDPR_CLARIFY }, GDPR_CONFIRM],
    {
      flowInstanceId: instance.id,
    },
  );
}

// --- Helpers --------------------------------------------------------------

function rawText(input: FlowInput): string {
  switch (input.kind) {
    case "text":
      return input.text;
    case "button":
    case "list":
      return input.title;
    case "interpreted":
      return input.raw;
    default:
      return "";
  }
}

async function hasCompletedSurvey(
  store: Store,
  personId: number,
): Promise<boolean> {
  const latest = await store.getLatestFlowInstance(personId, CURS_SARDANES);
  return (
    latest != null &&
    (latest.status === "completed" || latest.completed_at != null)
  );
}
