/**
 * Persistence contract for the bot.
 *
 * Two implementations: `D1Store` (production, src/db/d1.ts) and `MemoryStore`
 * (in-memory fake for router unit tests, src/db/memory.ts). The router depends
 * only on this interface, so flow logic is exercised without a live D1 while the
 * real store is driven end-to-end via `wrangler dev` + the simulator.
 *
 * Concurrency: `insertInboundMessage` dedupes on wa_message_id (webhook retries);
 * `updateFlowStep` is an optimistic compare-and-set on the current step (two
 * concurrent webhook invocations can't both advance the same flow).
 */

export interface PersonRow {
  id: number;
  wa_id: string;
  profile_name: string | null;
  display_name: string | null;
  created_at: string;
  last_inbound_at: string | null;
  gdpr_deleted: number;
}

export type FlowStatusRow = "active" | "completed" | "abandoned" | "declined";

export interface FlowInstanceRow {
  id: number;
  person_id: number;
  flow_type: string;
  status: FlowStatusRow;
  step: string | null;
  data_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type Direction = "in" | "out";

export interface MessageRow {
  id: number;
  wa_message_id: string | null;
  person_id: number;
  direction: Direction;
  msg_type: string;
  body_json: string;
  status: string | null;
  error_json: string | null;
  flow_instance_id: number | null;
  ai_meta_json: string | null;
  created_at: string;
}

export interface InsertInboundInput {
  waMessageId: string;
  personId: number;
  msgType: string;
  bodyJson: string;
  createdAt: string;
}

export interface InsertOutboundInput {
  waMessageId: string;
  personId: number;
  msgType: string;
  bodyJson: string;
  flowInstanceId?: number | null;
  aiMetaJson?: string | null;
  status?: string | null;
  createdAt: string;
}

export interface CreateFlowInput {
  personId: number;
  flowType: string;
  status: FlowStatusRow;
  step: string | null;
  dataJson: string;
  createdAt: string;
}

export interface UpdateFlowInput {
  status: FlowStatusRow;
  step: string | null;
  dataJson: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface Store {
  // People
  upsertPerson(
    waId: string,
    profileName: string | null,
    at: string,
  ): Promise<PersonRow>;
  getPersonByWaId(waId: string): Promise<PersonRow | null>;
  getPerson(id: number): Promise<PersonRow | null>;
  setDisplayName(personId: number, name: string, at: string): Promise<void>;
  /** GDPR erase: flag + scrub the person row and delete their messages. */
  anonymizePerson(personId: number, at: string): Promise<void>;

  // Messages
  /** Returns false when the wa_message_id already existed (retry → ignore). */
  insertInboundMessage(input: InsertInboundInput): Promise<boolean>;
  insertOutboundMessage(input: InsertOutboundInput): Promise<MessageRow>;
  getMessageByWaId(waMessageId: string): Promise<MessageRow | null>;
  updateOutboundStatus(
    waMessageId: string,
    status: string,
    errorJson: string | null,
    at: string,
  ): Promise<boolean>;

  // Flow instances
  getFlowInstance(id: number): Promise<FlowInstanceRow | null>;
  getActiveFlowInstance(personId: number): Promise<FlowInstanceRow | null>;
  getLatestFlowInstance(
    personId: number,
    flowType: string,
  ): Promise<FlowInstanceRow | null>;
  createFlowInstance(input: CreateFlowInput): Promise<FlowInstanceRow>;
  /** Unconditional update (start/resume/returning). */
  updateFlowInstance(id: number, input: UpdateFlowInput): Promise<void>;
  /**
   * Optimistic compare-and-set: only writes when the row's current step still
   * equals `expectedStep`. Returns false when 0 rows matched (another
   * invocation already advanced the flow — caller must NOT send).
   */
  updateFlowStep(
    id: number,
    expectedStep: string | null,
    input: UpdateFlowInput,
  ): Promise<boolean>;

  // Settings
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string, at: string): Promise<void>;

  // Knowledge base (dynamic entries; editable from the inbox admin)
  listKbEntries(activeOnly?: boolean): Promise<KbEntryRow[]>;
  upsertKbEntry(input: UpsertKbEntryInput): Promise<KbEntryRow>;
  deleteKbEntry(id: number): Promise<boolean>;

  // Admin read helpers (used by /admin/api/* and verification).
  listConversations(limit?: number): Promise<ConversationSummary[]>;
  listMessagesForPerson(personId: number): Promise<MessageRow[]>;
  /** Completed instances of a flow, joined with the person, for CSV export. */
  exportCompletedFlows(flowType: string): Promise<CompletedFlowRow[]>;
}

export interface CompletedFlowRow {
  person_id: number;
  wa_id: string;
  display_name: string | null;
  profile_name: string | null;
  data_json: string;
  completed_at: string | null;
}

export interface KbEntryRow {
  id: number;
  slug: string;
  title: string;
  content_md: string;
  active: number;
  updated_at: string;
}

export interface UpsertKbEntryInput {
  slug: string;
  title: string;
  contentMd: string;
  active: boolean;
  at: string;
}

export interface ConversationSummary {
  person: PersonRow;
  lastMessageAt: string | null;
  flowStatus: FlowStatusRow | null;
  flowType: string | null;
}
