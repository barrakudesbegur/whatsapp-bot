/**
 * In-memory Store fake for router unit tests. Mirrors D1Store semantics:
 * wa_message_id dedupe, optimistic step CAS, upsert-by-wa_id. No SQL — plain
 * JS maps. (Signature verification and outbound payloads are still exercised
 * with real WebCrypto / real payload builders; only persistence is faked here.)
 */

import type {
	CampaignRow,
	CompletedFlowRow,
	ConversationSummary,
	CreateFlowInput,
	FlowInstanceRow,
	InsertInboundInput,
	InsertOutboundInput,
	KbEntryRow,
	MessageRow,
	PersonRow,
	Store,
	UpdateFlowInput,
	UpsertCampaignInput,
	UpsertKbEntryInput
} from './store.ts';

export class MemoryStore implements Store {
	private people: PersonRow[] = [];
	private flows: FlowInstanceRow[] = [];
	private messages: MessageRow[] = [];
	private kb: KbEntryRow[] = [];
	private campaigns: CampaignRow[] = [];
	private settings = new Map<string, string>();
	private seq = { person: 0, flow: 0, message: 0, kb: 0, campaign: 0 };

	constructor() {
		this.settings.set('course_status', 'exploring');
		this.settings.set('course_status_note', '');
		// Mirror the 0002 migration seed: the sardanes survey is campaign #1.
		this.campaigns.push({
			id: ++this.seq.campaign,
			slug: 'curs-sardanes',
			title: 'Curs de sardanes',
			pitch_md:
				'Estem explorant muntar un curs per aprendre a ballar sardanes a Begur. Estem recollint qui s’hi apuntaria amb una mini-enquesta per WhatsApp (tu mateix la pots fer!).',
			active: 1,
			priority: 10,
			updated_at: '2026-07-06T00:00:00.000Z'
		});
	}

	// People ----------------------------------------------------------------
	async upsertPerson(waId: string, profileName: string | null, at: string): Promise<PersonRow> {
		const existing = this.people.find((p) => p.wa_id === waId);
		if (existing) {
			if (profileName != null) existing.profile_name = profileName;
			existing.last_inbound_at = at;
			return { ...existing };
		}
		const row: PersonRow = {
			id: ++this.seq.person,
			wa_id: waId,
			profile_name: profileName,
			display_name: null,
			created_at: at,
			last_inbound_at: at,
			gdpr_deleted: 0,
			is_test: 0
		};
		this.people.push(row);
		return { ...row };
	}

	async getPersonByWaId(waId: string): Promise<PersonRow | null> {
		const p = this.people.find((p) => p.wa_id === waId);
		return p ? { ...p } : null;
	}

	async getPerson(id: number): Promise<PersonRow | null> {
		const p = this.people.find((p) => p.id === id);
		return p ? { ...p } : null;
	}

	async setDisplayName(personId: number, name: string, at: string): Promise<void> {
		const p = this.people.find((p) => p.id === personId);
		if (p) {
			p.display_name = name;
			p.last_inbound_at ??= at;
		}
	}

	async markPersonTest(personId: number): Promise<void> {
		const p = this.people.find((p) => p.id === personId);
		if (p) p.is_test = 1;
	}

	async anonymizePerson(personId: number, at: string): Promise<void> {
		this.messages = this.messages.filter((m) => m.person_id !== personId);
		const p = this.people.find((p) => p.id === personId);
		if (p) {
			p.gdpr_deleted = 1;
			p.display_name = null;
			p.profile_name = null;
			p.wa_id = `deleted:${p.id}`;
			p.last_inbound_at = at;
		}
	}

	// Messages --------------------------------------------------------------
	async insertInboundMessage(input: InsertInboundInput): Promise<boolean> {
		if (this.messages.some((m) => m.wa_message_id === input.waMessageId)) {
			return false; // duplicate
		}
		this.messages.push({
			id: ++this.seq.message,
			wa_message_id: input.waMessageId,
			person_id: input.personId,
			direction: 'in',
			msg_type: input.msgType,
			body_json: input.bodyJson,
			status: null,
			error_json: null,
			flow_instance_id: null,
			ai_meta_json: null,
			created_at: input.createdAt
		});
		return true;
	}

	async insertOutboundMessage(input: InsertOutboundInput): Promise<MessageRow> {
		const row: MessageRow = {
			id: ++this.seq.message,
			wa_message_id: input.waMessageId,
			person_id: input.personId,
			direction: 'out',
			msg_type: input.msgType,
			body_json: input.bodyJson,
			status: input.status ?? null,
			error_json: null,
			flow_instance_id: input.flowInstanceId ?? null,
			ai_meta_json: input.aiMetaJson ?? null,
			created_at: input.createdAt
		};
		this.messages.push(row);
		return { ...row };
	}

	async getMessageByWaId(waMessageId: string): Promise<MessageRow | null> {
		const m = this.messages.find((m) => m.wa_message_id === waMessageId);
		return m ? { ...m } : null;
	}

	async updateOutboundStatus(
		waMessageId: string,
		status: string,
		errorJson: string | null,
		_at: string
	): Promise<boolean> {
		const m = this.messages.find((m) => m.wa_message_id === waMessageId && m.direction === 'out');
		if (!m) return false;
		m.status = status;
		if (errorJson != null) m.error_json = errorJson;
		return true;
	}

	// Flow instances --------------------------------------------------------
	async getLatestFlowInstance(personId: number, flowType: string): Promise<FlowInstanceRow | null> {
		const list = this.flows
			.filter((f) => f.person_id === personId && f.flow_type === flowType)
			.sort((a, b) => b.id - a.id);
		return list[0] ? { ...list[0] } : null;
	}

	async createFlowInstance(input: CreateFlowInput): Promise<FlowInstanceRow> {
		const row: FlowInstanceRow = {
			id: ++this.seq.flow,
			person_id: input.personId,
			flow_type: input.flowType,
			status: input.status,
			step: input.step,
			data_json: input.dataJson,
			created_at: input.createdAt,
			updated_at: input.createdAt,
			completed_at: null
		};
		this.flows.push(row);
		return { ...row };
	}

	async updateFlowInstance(id: number, input: UpdateFlowInput): Promise<void> {
		const f = this.flows.find((f) => f.id === id);
		if (!f) return;
		f.status = input.status;
		f.step = input.step;
		f.data_json = input.dataJson;
		f.updated_at = input.updatedAt;
		if (input.completedAt != null) f.completed_at = input.completedAt;
	}

	// Settings --------------------------------------------------------------
	async getSetting(key: string): Promise<string | null> {
		return this.settings.get(key) ?? null;
	}

	async setSetting(key: string, value: string, _at?: string): Promise<void> {
		this.settings.set(key, value);
	}

	// Knowledge base ----------------------------------------------------------
	async listKbEntries(activeOnly = false): Promise<KbEntryRow[]> {
		return this.kb
			.filter((e) => !activeOnly || e.active === 1)
			.sort((a, b) => a.slug.localeCompare(b.slug))
			.map((e) => ({ ...e }));
	}

	async upsertKbEntry(input: UpsertKbEntryInput): Promise<KbEntryRow> {
		const existing = this.kb.find((e) => e.slug === input.slug);
		if (existing) {
			existing.title = input.title;
			existing.content_md = input.contentMd;
			existing.active = input.active ? 1 : 0;
			existing.updated_at = input.at;
			return { ...existing };
		}
		const row: KbEntryRow = {
			id: ++this.seq.kb,
			slug: input.slug,
			title: input.title,
			content_md: input.contentMd,
			active: input.active ? 1 : 0,
			updated_at: input.at
		};
		this.kb.push(row);
		return { ...row };
	}

	async deleteKbEntry(id: number): Promise<boolean> {
		const before = this.kb.length;
		this.kb = this.kb.filter((e) => e.id !== id);
		return this.kb.length < before;
	}

	// Campaigns ---------------------------------------------------------------
	async listCampaigns(activeOnly = false): Promise<CampaignRow[]> {
		return this.campaigns
			.filter((c) => !activeOnly || c.active === 1)
			.sort((a, b) => b.priority - a.priority || a.slug.localeCompare(b.slug))
			.map((c) => ({ ...c }));
	}

	async upsertCampaign(input: UpsertCampaignInput): Promise<CampaignRow> {
		const existing = this.campaigns.find((c) => c.slug === input.slug);
		if (existing) {
			existing.title = input.title;
			existing.pitch_md = input.pitchMd;
			existing.active = input.active ? 1 : 0;
			existing.priority = input.priority;
			existing.updated_at = input.at;
			return { ...existing };
		}
		const row: CampaignRow = {
			id: ++this.seq.campaign,
			slug: input.slug,
			title: input.title,
			pitch_md: input.pitchMd,
			active: input.active ? 1 : 0,
			priority: input.priority,
			updated_at: input.at
		};
		this.campaigns.push(row);
		return { ...row };
	}

	async deleteCampaign(id: number): Promise<boolean> {
		const before = this.campaigns.length;
		this.campaigns = this.campaigns.filter((c) => c.id !== id);
		return this.campaigns.length < before;
	}

	// Admin -----------------------------------------------------------------
	async listConversations(limit = 50): Promise<ConversationSummary[]> {
		return this.people
			.map((person) => {
				const msgs = this.messages.filter((m) => m.person_id === person.id);
				const lastMessageAt =
					msgs.length > 0
						? (msgs
								.map((m) => m.created_at)
								.sort()
								.at(-1) ?? null)
						: null;
				const latestFlow = this.flows
					.filter((f) => f.person_id === person.id)
					.sort((a, b) => b.id - a.id)[0];
				return {
					person: { ...person },
					lastMessageAt,
					flowStatus: latestFlow?.status ?? null,
					flowType: latestFlow?.flow_type ?? null
				};
			})
			.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
			.slice(0, limit);
	}

	async listMessagesForPerson(personId: number): Promise<MessageRow[]> {
		return this.messages
			.filter((m) => m.person_id === personId)
			.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
			.map((m) => ({ ...m }));
	}

	async exportCompletedFlows(flowType: string): Promise<CompletedFlowRow[]> {
		return this.flows
			.filter((f) => f.flow_type === flowType && f.status === 'completed')
			.filter((f) => this.people.find((p) => p.id === f.person_id)?.is_test !== 1)
			.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? '') || b.id - a.id)
			.map((f) => {
				const p = this.people.find((p) => p.id === f.person_id);
				return {
					person_id: f.person_id,
					wa_id: p?.wa_id ?? '',
					display_name: p?.display_name ?? null,
					profile_name: p?.profile_name ?? null,
					data_json: f.data_json,
					completed_at: f.completed_at
				};
			});
	}
}
