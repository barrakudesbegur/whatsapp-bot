/**
 * D1-backed Store. Uses `... RETURNING` to detect inserts/updates rather than
 * relying on driver-specific `meta` fields:
 *  - INSERT ... ON CONFLICT DO NOTHING RETURNING → row present iff not a dup.
 *  - UPDATE ... WHERE step IS ? RETURNING → row present iff the CAS matched.
 */

import type {
  ConversationSummary,
  CreateFlowInput,
  FlowInstanceRow,
  InsertInboundInput,
  InsertOutboundInput,
  MessageRow,
  PersonRow,
  Store,
  UpdateFlowInput,
} from "./store.ts";

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async upsertPerson(
    waId: string,
    profileName: string | null,
    at: string,
  ): Promise<PersonRow> {
    const row = await this.db
      .prepare(
        `INSERT INTO people (wa_id, profile_name, created_at, last_inbound_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(wa_id) DO UPDATE SET
           profile_name = COALESCE(excluded.profile_name, people.profile_name),
           last_inbound_at = excluded.last_inbound_at
         RETURNING *`,
      )
      .bind(waId, profileName, at)
      .first<PersonRow>();
    // RETURNING on upsert always yields a row.
    return row as PersonRow;
  }

  async getPersonByWaId(waId: string): Promise<PersonRow | null> {
    return await this.db
      .prepare(`SELECT * FROM people WHERE wa_id = ?1`)
      .bind(waId)
      .first<PersonRow>();
  }

  async setDisplayName(
    personId: number,
    name: string,
    at: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE people SET display_name = ?2, last_inbound_at = COALESCE(last_inbound_at, ?3) WHERE id = ?1`,
      )
      .bind(personId, name, at)
      .run();
  }

  async anonymizePerson(personId: number, at: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM messages WHERE person_id = ?1`)
        .bind(personId),
      this.db
        .prepare(
          `UPDATE people
             SET gdpr_deleted = 1,
                 display_name = NULL,
                 profile_name = NULL,
                 wa_id = 'deleted:' || id,
                 last_inbound_at = ?2
           WHERE id = ?1`,
        )
        .bind(personId, at),
    ]);
  }

  async insertInboundMessage(input: InsertInboundInput): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO messages (wa_message_id, person_id, direction, msg_type, body_json, created_at)
         VALUES (?1, ?2, 'in', ?3, ?4, ?5)
         ON CONFLICT(wa_message_id) DO NOTHING
         RETURNING id`,
      )
      .bind(
        input.waMessageId,
        input.personId,
        input.msgType,
        input.bodyJson,
        input.createdAt,
      )
      .first<{ id: number }>();
    return row !== null; // null → conflict ignored (duplicate)
  }

  async insertOutboundMessage(input: InsertOutboundInput): Promise<MessageRow> {
    const row = await this.db
      .prepare(
        `INSERT INTO messages
           (wa_message_id, person_id, direction, msg_type, body_json, status, flow_instance_id, ai_meta_json, created_at)
         VALUES (?1, ?2, 'out', ?3, ?4, ?5, ?6, ?7, ?8)
         RETURNING *`,
      )
      .bind(
        input.waMessageId,
        input.personId,
        input.msgType,
        input.bodyJson,
        input.status ?? null,
        input.flowInstanceId ?? null,
        input.aiMetaJson ?? null,
        input.createdAt,
      )
      .first<MessageRow>();
    return row as MessageRow;
  }

  async getMessageByWaId(waMessageId: string): Promise<MessageRow | null> {
    return await this.db
      .prepare(`SELECT * FROM messages WHERE wa_message_id = ?1`)
      .bind(waMessageId)
      .first<MessageRow>();
  }

  async updateOutboundStatus(
    waMessageId: string,
    status: string,
    errorJson: string | null,
    _at: string,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `UPDATE messages SET status = ?2, error_json = COALESCE(?3, error_json)
           WHERE wa_message_id = ?1 AND direction = 'out'
         RETURNING id`,
      )
      .bind(waMessageId, status, errorJson)
      .first<{ id: number }>();
    return row !== null;
  }

  async getFlowInstance(id: number): Promise<FlowInstanceRow | null> {
    return await this.db
      .prepare(`SELECT * FROM flow_instances WHERE id = ?1`)
      .bind(id)
      .first<FlowInstanceRow>();
  }

  async getActiveFlowInstance(
    personId: number,
  ): Promise<FlowInstanceRow | null> {
    return await this.db
      .prepare(
        `SELECT * FROM flow_instances
           WHERE person_id = ?1 AND status = 'active'
           ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .bind(personId)
      .first<FlowInstanceRow>();
  }

  async getLatestFlowInstance(
    personId: number,
    flowType: string,
  ): Promise<FlowInstanceRow | null> {
    return await this.db
      .prepare(
        `SELECT * FROM flow_instances
           WHERE person_id = ?1 AND flow_type = ?2
           ORDER BY id DESC LIMIT 1`,
      )
      .bind(personId, flowType)
      .first<FlowInstanceRow>();
  }

  async createFlowInstance(input: CreateFlowInput): Promise<FlowInstanceRow> {
    const row = await this.db
      .prepare(
        `INSERT INTO flow_instances
           (person_id, flow_type, status, step, data_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         RETURNING *`,
      )
      .bind(
        input.personId,
        input.flowType,
        input.status,
        input.step,
        input.dataJson,
        input.createdAt,
      )
      .first<FlowInstanceRow>();
    return row as FlowInstanceRow;
  }

  async updateFlowInstance(id: number, input: UpdateFlowInput): Promise<void> {
    await this.db
      .prepare(
        `UPDATE flow_instances
           SET status = ?2, step = ?3, data_json = ?4, updated_at = ?5,
               completed_at = COALESCE(?6, completed_at)
         WHERE id = ?1`,
      )
      .bind(
        id,
        input.status,
        input.step,
        input.dataJson,
        input.updatedAt,
        input.completedAt ?? null,
      )
      .run();
  }

  async updateFlowStep(
    id: number,
    expectedStep: string | null,
    input: UpdateFlowInput,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `UPDATE flow_instances
           SET status = ?3, step = ?4, data_json = ?5, updated_at = ?6,
               completed_at = COALESCE(?7, completed_at)
         WHERE id = ?1 AND step IS ?2
         RETURNING id`,
      )
      .bind(
        id,
        expectedStep,
        input.status,
        input.step,
        input.dataJson,
        input.updatedAt,
        input.completedAt ?? null,
      )
      .first<{ id: number }>();
    return row !== null;
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT value FROM settings WHERE key = ?1`)
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string, at: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, at)
      .run();
  }

  async listConversations(limit = 50): Promise<ConversationSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT
           p.*,
           (SELECT MAX(created_at) FROM messages m WHERE m.person_id = p.id) AS last_message_at,
           (SELECT status FROM flow_instances f WHERE f.person_id = p.id ORDER BY f.id DESC LIMIT 1) AS flow_status,
           (SELECT flow_type FROM flow_instances f WHERE f.person_id = p.id ORDER BY f.id DESC LIMIT 1) AS flow_type
         FROM people p
         ORDER BY last_message_at DESC NULLS LAST
         LIMIT ?1`,
      )
      .bind(limit)
      .all<
        PersonRow & {
          last_message_at: string | null;
          flow_status: string | null;
          flow_type: string | null;
        }
      >();
    return (results ?? []).map((r) => {
      const { last_message_at, flow_status, flow_type, ...person } = r;
      return {
        person: person as PersonRow,
        lastMessageAt: last_message_at,
        flowStatus: (flow_status as ConversationSummary["flowStatus"]) ?? null,
        flowType: flow_type ?? null,
      };
    });
  }

  async listMessagesForPerson(personId: number): Promise<MessageRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages WHERE person_id = ?1 ORDER BY created_at ASC, id ASC`,
      )
      .bind(personId)
      .all<MessageRow>();
    return results ?? [];
  }
}
