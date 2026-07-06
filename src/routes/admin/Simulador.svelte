<script lang="ts">
	import { simulate } from './simulate.remote';
	import { conversations, conversation } from './data.remote';

	interface Opt {
		id: string;
		title: string;
	}
	interface ChatItem {
		from: 'person' | 'kudi';
		text: string;
		/** Poster URL when Kudi sends an image message (text = caption). */
		image?: string;
		buttons?: Opt[];
		rows?: Opt[];
		contextId?: string;
		/** Sent-message ticks: ✓✓ grey → blue once Kudi has "read" it. */
		seen?: boolean;
	}
	// Both derived from the simulate command's signature — no server-only import.
	type SimArg = Parameters<typeof simulate>[0];
	type SimMessage = Awaited<ReturnType<typeof simulate>>['messages'][number]['message'];

	// Every visit starts as a brand-new person (random fake number), so a "new"
	// chat can never silently continue an old person's draft — observed live: the
	// old fixed default number resumed a stale conversation with someone else's
	// name. Continuing a previous test conversation is an explicit pick below.
	function freshWaId(): string {
		return '34600' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
	}

	let waId = $state(freshWaId());
	let personLabel = $state<string | null>(null); // set when continuing an old conversation
	let draft = $state('');
	let chat = $state<ChatItem[]>([]);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let pickerValue = $state('');

	/** Kudi's outbound message → its tappable options (narrowed by kind). */
	function optsOf(m: SimMessage): { buttons?: Opt[]; rows?: Opt[] } {
		if (m.kind === 'buttons') return { buttons: m.buttons };
		if (m.kind === 'list') return { rows: m.rows };
		return {};
	}

	/** Bubble text of an outbound message (an image's text is its caption). */
	function textOf(m: SimMessage): string {
		return m.kind === 'image' ? (m.caption ?? '') : m.body;
	}

	function fresh() {
		waId = freshWaId();
		personLabel = null;
		pickerValue = '';
		chat = [];
		error = null;
	}

	/** Continue an existing test conversation: same person, history loaded. */
	async function resume(personId: number) {
		error = null;
		try {
			const detail = await conversation(personId);
			waId = detail.person.waId;
			personLabel = detail.person.name;
			chat = detail.messages.map((m): ChatItem => ({
				from: m.direction === 'in' ? 'person' : 'kudi',
				text: m.text,
				image: m.image,
				buttons: m.buttons,
				rows: m.rows,
				contextId: m.waMessageId,
				seen: true
			}));
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function drive(arg: SimArg, localEcho: string) {
		if (busy) return;
		busy = true;
		error = null;
		chat.push({ from: 'person', text: localEcho });
		// Mutate the PROXIED element ($state deep-proxies on push), so ticks react.
		const sent = chat[chat.length - 1]!;
		// Mirror the real flow: the router marks the message read (blue ticks) and
		// shows "typing…" right before the model call.
		const seenTimer = setTimeout(() => (sent.seen = true), 350);
		try {
			const { messages } = await simulate(arg);
			sent.seen = true;
			for (const r of messages) {
				chat.push({
					from: 'kudi',
					text: textOf(r.message),
					...(r.message.kind === 'image' ? { image: r.message.link } : {}),
					...optsOf(r.message),
					contextId: r.wa_message_id
				});
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			clearTimeout(seenTimer);
			busy = false;
		}
		// Refresh the picker (the new persona appears) OUTSIDE the busy window —
		// awaiting it kept the option buttons disabled while it settled.
		conversations()
			.refresh()
			.catch(() => {});
	}

	function sendText() {
		const text = draft.trim();
		if (!text) return;
		draft = '';
		// Only brand-new people get a synthetic profile name — resuming must not
		// overwrite the existing person's profile name.
		drive({ wa_id: waId, ...(personLabel ? {} : { name: `Prova ${waId.slice(-3)}` }), text }, text);
	}

	function tapButton(contextId: string, id: string, title: string) {
		drive({ wa_id: waId, button_reply: { id, title, context_wa_message_id: contextId } }, title);
	}
	function tapRow(contextId: string, id: string, title: string) {
		drive({ wa_id: waId, list_reply: { id, title, context_wa_message_id: contextId } }, title);
	}

	// The most recent Kudi message with tappable options.
	const lastInteractive = $derived(
		[...chat].reverse().find((c) => c.from === 'kudi' && (c.buttons || c.rows))
	);
</script>

<div class="card">
	<div class="stack">
		<div class="row">
			<button class="btn small" onclick={fresh} disabled={busy}>💬 Conversa nova</button>
			{#if (await conversations()).some((c) => c.isTest && !c.gdprDeleted)}
				{@const tests = (await conversations()).filter((c) => c.isTest && !c.gdprDeleted)}
				<select
					aria-label="Continua una conversa de prova"
					bind:value={pickerValue}
					onchange={() => pickerValue && resume(Number(pickerValue))}
					style="flex:1"
				>
					<option value="">…o continua una conversa de prova</option>
					{#each tests as t (t.id)}
						<option value={String(t.id)}>{t.name} ({t.waId})</option>
					{/each}
				</select>
			{/if}
		</div>
		<p class="muted">
			{#if personLabel}
				Continues com a <strong>{personLabel}</strong> ({waId}).
			{:else}
				Persona nova ({waId}). Escriu com si fossis tu qui pregunta (en Kudi entén text lliure). Per
				exemple: <em>Explica'm això del curs de sardanes 💃</em>
			{/if}
		</p>
	</div>
</div>

<div class="transcript">
	{#each chat as item, i (i)}
		<div class="bubble {item.from === 'person' ? 'out' : 'in'}">
			{#if item.image}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external poster URL -->
				<a href={item.image} target="_blank" rel="noreferrer">
					<img class="poster" src={item.image} alt="Cartell" />
				</a>
			{/if}
			{item.text}{#if item.from === 'person'}<span class="ticks" class:seen={item.seen}>✓✓</span
				>{/if}
			{#if item.buttons?.length}
				<div class="opts">
					{#each item.buttons as b (b.id)}
						<button
							class="opt"
							disabled={busy || item.contextId !== lastInteractive?.contextId}
							onclick={() => tapButton(item.contextId ?? '', b.id, b.title)}
						>
							{b.title}
						</button>
					{/each}
				</div>
			{/if}
			{#if item.rows?.length}
				<div class="opts">
					{#each item.rows as r (r.id)}
						<button
							class="opt"
							disabled={busy || item.contextId !== lastInteractive?.contextId}
							onclick={() => tapRow(item.contextId ?? '', r.id, r.title)}
						>
							{r.title}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/each}
	{#if busy}
		<div class="bubble in typing" aria-label="En Kudi està escrivint…">
			<span class="dot"></span><span class="dot"></span><span class="dot"></span>
		</div>
	{/if}
</div>

{#if error}<p class="error">{error}</p>{/if}

<div class="composer">
	<textarea
		bind:value={draft}
		placeholder="Escriu un missatge…"
		rows="1"
		onkeydown={(e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendText();
			}
		}}></textarea>
	<button class="btn" disabled={busy || !draft.trim()} onclick={sendText}> Envia </button>
</div>
