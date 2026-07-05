/**
 * Command-line conversation simulator — chat with Kudi like a WhatsApp user.
 *
 * Drives the REAL production path: builds genuine Cloud API envelopes, signs
 * them with WA_APP_SECRET from .dev.vars (X-Hub-Signature-256 over the raw
 * body) and POSTs them to the local /webhook. Kudi's replies are read from the
 * local D1 (miniflare sqlite) and rendered in the terminal, with interactive
 * buttons/lists shown as numbered options you can tap.
 *
 * Usage (start `npm run preview` in another terminal first):
 *   npm run chat                       interactive REPL (fresh person each run)
 *   npm run chat -- "hola" "em dic X"  one-shot: send messages, print replies
 *   CHAT_WA_ID=34699123456 npm run chat   continue as an existing person
 *   CHAT_URL=...           npm run chat   target another server (default :4193)
 *
 * REPL commands:
 *   <text>     send a text message
 *   /tap N     tap option N of the last interactive message
 *   /media     send an unsupported (image) message
 *   /new       start over as a brand-new person
 *   /state     dump the person + survey draft rows
 *   /quit      exit
 *
 * No deps: node:sqlite (Node >= 22.5), node:crypto, node:readline.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.CHAT_URL ?? 'http://localhost:4193';
const ROOT = new URL('..', import.meta.url);

// --- Secret (never printed) -------------------------------------------------

const devVars = readFileSync(new URL('.dev.vars', ROOT), 'utf8');
const SECRET = devVars
	.match(/^WA_APP_SECRET=(.*)$/m)?.[1]
	?.trim()
	.replace(/^"|"$/g, '');
if (!SECRET) {
	console.error('WA_APP_SECRET not found in .dev.vars');
	process.exit(1);
}

// --- Local D1 (miniflare sqlite) ---------------------------------------------

function d1Path(): string {
	const dir = new URL('.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', ROOT);
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sqlite'))
		.map((f) => ({ f, mtime: statSync(new URL(f, dir)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	if (!files[0]) throw new Error('no local D1 found — run `npm run db:apply:local` first');
	return new URL(files[0].f, dir).pathname;
}

interface OutRow {
	id: number;
	body_json: string;
	ai_meta_json: string | null;
	wa_message_id: string;
}

function query<T>(sql: string, ...params: (string | number)[]): T[] {
	const db = new DatabaseSync(d1Path(), { readOnly: true });
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}

// --- Envelope building + sending ---------------------------------------------

// CHAT_WA_ID pins the persona (continue a prior conversation); default = fresh.
let WA_ID =
	process.env.CHAT_WA_ID ?? `34699${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
let lastSeenId = 0;
let lastOptions: { id: string; title: string; kind: 'button' | 'list'; ctx: string }[] = [];

type Inbound =
	| { type: 'text'; text: { body: string } }
	| { type: 'image'; image: { id: string } }
	| {
			type: 'interactive';
			interactive:
				| { type: 'button_reply'; button_reply: { id: string; title: string } }
				| { type: 'list_reply'; list_reply: { id: string; title: string } };
			context: { id: string };
	  };

async function send(message: Inbound): Promise<void> {
	const raw = JSON.stringify({
		object: 'whatsapp_business_account',
		entry: [
			{
				id: 'chat-cli',
				changes: [
					{
						field: 'messages',
						value: {
							messaging_product: 'whatsapp',
							metadata: { display_phone_number: '000', phone_number_id: 'CHAT_CLI' },
							contacts: [{ profile: { name: 'Chat CLI' }, wa_id: WA_ID }],
							messages: [
								{
									from: WA_ID,
									id: `wamid.cli-${randomUUID()}`,
									timestamp: String(Math.floor(Date.now() / 1000)),
									...message
								}
							]
						}
					}
				]
			}
		]
	});
	const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');
	const t0 = Date.now();
	const res = await fetch(`${BASE}/webhook`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
		body: raw
	});
	if (!res.ok) {
		console.error(`✗ webhook ${res.status}: ${await res.text()}`);
		return;
	}
	printReplies(Date.now() - t0);
}

// --- Rendering -----------------------------------------------------------------

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const orange = (s: string) => `\x1b[38;5;208m${s}\x1b[0m`;

function printReplies(ms: number): void {
	const rows = query<OutRow>(
		`SELECT m.id, m.body_json, m.ai_meta_json, m.wa_message_id
       FROM messages m JOIN people p ON p.id = m.person_id
      WHERE p.wa_id = ? AND m.direction = 'out' AND m.id > ? ORDER BY m.id`,
		WA_ID,
		lastSeenId
	);
	if (rows.length === 0) {
		console.log(dim(`(cap resposta — ${ms}ms)`));
		return;
	}
	for (const row of rows) {
		lastSeenId = row.id;
		const body = JSON.parse(row.body_json) as {
			text?: { body?: string };
			interactive?: {
				body?: { text?: string };
				action?: {
					buttons?: { reply?: { id: string; title: string } }[];
					sections?: { rows?: { id: string; title: string; description?: string }[] }[];
				};
			};
		};
		let meta = '';
		if (row.ai_meta_json) {
			const m = JSON.parse(row.ai_meta_json) as { model?: string; latencyMs?: number };
			meta = ` · ${m.model?.split('/').pop()} ${m.latencyMs}ms`;
		}
		const text = body.text?.body ?? body.interactive?.body?.text ?? '';
		console.log(`\n${orange(bold('Kudi:'))} ${text}${dim(meta)}`);

		lastOptions = [];
		const buttons = body.interactive?.action?.buttons;
		const listRows = body.interactive?.action?.sections?.flatMap((s) => s.rows ?? []);
		const opts = buttons
			? buttons.map((b) => ({ id: b.reply!.id, title: b.reply!.title, kind: 'button' as const }))
			: (listRows ?? []).map((r) => ({ id: r.id, title: r.title, kind: 'list' as const }));
		if (opts.length > 0) {
			lastOptions = opts.map((o) => ({ ...o, ctx: row.wa_message_id }));
			opts.forEach((o, i) => console.log(dim(`   [${i + 1}] ${o.title}`)));
			console.log(dim('   (toca amb /tap N)'));
		}
	}
}

async function tap(n: number): Promise<void> {
	const opt = lastOptions[n - 1];
	if (!opt) {
		console.error(`✗ no hi ha opció ${n}`);
		return;
	}
	console.log(dim(`(toques «${opt.title}»)`));
	await send({
		type: 'interactive',
		interactive:
			opt.kind === 'button'
				? { type: 'button_reply', button_reply: { id: opt.id, title: opt.title } }
				: { type: 'list_reply', list_reply: { id: opt.id, title: opt.title } },
		context: { id: opt.ctx }
	});
}

function printState(): void {
	const people = query<Record<string, unknown>>(
		'SELECT id, display_name, gdpr_deleted FROM people WHERE wa_id = ?',
		WA_ID
	);
	console.log(dim('person: ') + JSON.stringify(people[0] ?? null));
	if (people[0]) {
		const flows = query<Record<string, unknown>>(
			'SELECT flow_type, status, data_json, completed_at FROM flow_instances WHERE person_id = ?',
			people[0].id as number
		);
		for (const f of flows) console.log(dim('flow:   ') + JSON.stringify(f));
	}
}

// --- Main ------------------------------------------------------------------------

const args = process.argv.slice(2);

// A pinned persona continues where it left off: only print NEW replies.
if (process.env.CHAT_WA_ID) {
	const last = query<{ max: number | null }>(
		`SELECT MAX(m.id) AS max FROM messages m JOIN people p ON p.id = m.person_id WHERE p.wa_id = ?`,
		WA_ID
	);
	lastSeenId = last[0]?.max ?? 0;
}

console.log(dim(`→ ${BASE} · persona ${WA_ID}${process.env.CHAT_WA_ID ? '' : ' (nova)'}`));

if (args.length > 0) {
	// One-shot mode: send each argument as a text message.
	for (const msg of args) {
		console.log(`\n${bold('Tu:')} ${msg}`);
		await send({ type: 'text', text: { body: msg } });
	}
	process.exit(0);
}

// REPL mode. Piped stdin (heredocs, CI) buffers all lines upfront — readline
// drops lines that arrive while a slow reply is pending and closes on EOF.
console.log(dim('Escriu un missatge, /tap N, /media, /new, /state o /quit\n'));

async function* inputLines(): AsyncGenerator<string> {
	if (!process.stdin.isTTY) {
		const buffered: string[] = [];
		for await (const l of createInterface({ input: process.stdin })) buffered.push(l);
		for (const l of buffered) {
			console.log(bold('Tu: ') + l);
			yield l;
		}
		return;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
	for (;;) {
		let answer: string | null;
		try {
			answer = await Promise.race([rl.question(bold('Tu: ')), closed]);
		} catch {
			break; // interface closed mid-question
		}
		if (answer === null) break;
		yield answer;
	}
	rl.close();
}

for await (const raw of inputLines()) {
	const line = raw.trim();
	if (!line) continue;
	if (line === '/quit' || line === '/exit') break;
	if (line === '/new') {
		WA_ID = `34699${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
		lastSeenId = 0;
		lastOptions = [];
		console.log(dim(`→ persona nova: ${WA_ID}`));
		continue;
	}
	if (line === '/state') {
		printState();
		continue;
	}
	if (line === '/media') {
		await send({ type: 'image', image: { id: 'cli-img' } });
		continue;
	}
	const tapMatch = line.match(/^\/tap\s+(\d+)$/);
	if (tapMatch) {
		await tap(Number(tapMatch[1]));
		continue;
	}
	if (line.startsWith('/')) {
		console.error('✗ ordre desconeguda');
		continue;
	}
	await send({ type: 'text', text: { body: line } });
}
process.exit(0);
