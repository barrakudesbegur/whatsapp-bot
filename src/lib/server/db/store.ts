/**
 * Persistence contract for the bot.
 *
 * Two implementations: `D1Store` (production, src/db/d1.ts) and `MemoryStore`
 * (in-memory fake for router unit tests, src/db/memory.ts). The router depends
 * only on this interface, so flow logic is exercised without a live D1 while the
 * real store is driven end-to-end via `wrangler dev` + the simulator.
 *
 * Concurrency: `insertInboundMessage` dedupes on wa_message_id — an atomic UNIQUE
 * guard (webhook retries / double-delivery process a message at most once). Action
 * writes are idempotent set-semantics, so no per-step compare-and-set is needed.
 */

export interface PersonRow {
	id: number;
	wa_id: string;
	profile_name: string | null;
	display_name: string | null;
	created_at: string;
	last_inbound_at: string | null;
	gdpr_deleted: number;
	/** 1 = simulator-driven person (admin Simulador / chat CLI), not a real user. */
	is_test: number;
}

export type FlowStatusRow = 'active' | 'completed' | 'abandoned' | 'declined';

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

export type Direction = 'in' | 'out';

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
	upsertPerson(waId: string, profileName: string | null, at: string): Promise<PersonRow>;
	getPersonByWaId(waId: string): Promise<PersonRow | null>;
	getPerson(id: number): Promise<PersonRow | null>;
	setDisplayName(personId: number, name: string, at: string): Promise<void>;
	/**
	 * GDPR erase: flag + scrub the person row and delete their messages. Admin-only
	 * (data.remote.ts) — people who ask in the chat are pointed to email instead.
	 */
	anonymizePerson(personId: number, at: string): Promise<void>;
	/** Flag a person as simulator-driven test data (idempotent). */
	markPersonTest(personId: number): Promise<void>;

	// Messages
	/** Returns false when the wa_message_id already existed (retry → ignore). */
	insertInboundMessage(input: InsertInboundInput): Promise<boolean>;
	insertOutboundMessage(input: InsertOutboundInput): Promise<MessageRow>;
	getMessageByWaId(waMessageId: string): Promise<MessageRow | null>;
	updateOutboundStatus(
		waMessageId: string,
		status: string,
		errorJson: string | null,
		at: string
	): Promise<boolean>;
	/** Count inbound messages from a person at/after `sinceIso` — the per-sender
	 *  daily budget guard (keeps one spammer from draining the free-tier AI quota). */
	countInboundSince(personId: number, sinceIso: string): Promise<number>;

	// Flow instances (the per-person, per-flow submission draft).
	/** The latest instance of `flowType` for a person (their survey draft). */
	getLatestFlowInstance(personId: number, flowType: string): Promise<FlowInstanceRow | null>;
	/** Create a new instance. THROWS on the partial-unique-index violation when an
	 *  active instance already exists for this (person, flow) — persistSurvey turns
	 *  that into an update of the winner (the create race). */
	createFlowInstance(input: CreateFlowInput): Promise<FlowInstanceRow>;
	/**
	 * Compare-and-swap update: only writes when `expectedDataJson` still matches the
	 * stored `data_json`, so a concurrent turn that changed a different field can't be
	 * clobbered. Returns true on match, false on a stale CAS (caller re-reads +
	 * retries). Unlike the old updateFlowInstance, completed_at is SET explicitly
	 * (not COALESCE-preserved), so reopening an instance clears a stale timestamp.
	 */
	casUpdateFlowInstance(
		id: number,
		expectedDataJson: string,
		input: UpdateFlowInput
	): Promise<boolean>;

	// Settings
	getSetting(key: string): Promise<string | null>;
	setSetting(key: string, value: string, at: string): Promise<void>;

	// Knowledge base (dynamic entries; editable from the inbox admin)
	listKbEntries(activeOnly?: boolean): Promise<KbEntryRow[]>;
	upsertKbEntry(input: UpsertKbEntryInput): Promise<KbEntryRow>;
	deleteKbEntry(id: number): Promise<boolean>;

	// Campaigns — what the association is pushing right now (0..N active). Kudi
	// reads the active ones each turn and gently steers conversation toward them.
	/** Active-only (highest priority first) for the prompt; all rows for the admin. */
	listCampaigns(activeOnly?: boolean): Promise<CampaignRow[]>;
	upsertCampaign(input: UpsertCampaignInput): Promise<CampaignRow>;
	deleteCampaign(id: number): Promise<boolean>;

	// Admin read helpers (used by /admin/api/* and verification).
	listConversations(limit?: number): Promise<ConversationSummary[]>;
	/** ALL messages for a person, chronological — the admin conversation view. */
	listMessagesForPerson(personId: number): Promise<MessageRow[]>;
	/** The last `limit` messages, chronological — the decide() transcript tail.
	 *  Bounds per-turn rows-read + JSON parsing no matter how long the chat gets. */
	listRecentMessagesForPerson(personId: number, limit: number): Promise<MessageRow[]>;
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

export interface CampaignRow {
	id: number;
	slug: string;
	title: string;
	pitch_md: string;
	active: number;
	priority: number;
	updated_at: string;
}

export interface UpsertCampaignInput {
	slug: string;
	title: string;
	pitchMd: string;
	active: boolean;
	priority: number;
	at: string;
}

export interface ConversationSummary {
	person: PersonRow;
	lastMessageAt: string | null;
	flowStatus: FlowStatusRow | null;
	flowType: string | null;
}
