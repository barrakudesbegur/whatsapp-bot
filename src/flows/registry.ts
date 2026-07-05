/**
 * Registry of flow modules. Future flows (event RSVPs, announcements) register
 * here; the router looks them up by trigger (to start) or by flow_type (to
 * resume a stored flow_instance).
 */

import { triggerMatches } from "../lib/normalize.ts";
import type { FlowModule } from "./types.ts";
import { cursSardanesFlow } from "./curs-sardanes.ts";

export const FLOWS: readonly FlowModule[] = [cursSardanesFlow];

const BY_TYPE = new Map<string, FlowModule>(FLOWS.map((f) => [f.type, f]));

/** Look up a flow by its flow_type (to resume a stored instance). */
export function flowByType(type: string): FlowModule | undefined {
  return BY_TYPE.get(type);
}

/** Find the flow whose trigger phrase fuzzy-matches the inbound text. */
export function flowForTrigger(text: string): FlowModule | undefined {
  return FLOWS.find((f) => triggerMatches(text, f.trigger));
}
