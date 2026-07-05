<script lang="ts">
	import { simulate } from './simulate.remote';

	interface Opt {
		id: string;
		title: string;
	}
	interface ChatItem {
		from: 'person' | 'kudi';
		text: string;
		buttons?: Opt[];
		rows?: Opt[];
		contextId?: string;
	}
	// Both derived from the simulate command's signature — no server-only import.
	type SimArg = Parameters<typeof simulate>[0];
	type SimMessage = Awaited<ReturnType<typeof simulate>>['messages'][number]['message'];

	let waId = $state('34600' + '000000');
	let name = $state('Prova');
	let draft = $state('');
	let chat = $state<ChatItem[]>([]);
	let busy = $state(false);
	let error = $state<string | null>(null);

	/** Kudi's outbound message → its tappable options (narrowed by kind). */
	function optsOf(m: SimMessage): { buttons?: Opt[]; rows?: Opt[] } {
		if (m.kind === 'buttons') return { buttons: m.buttons };
		if (m.kind === 'list') return { rows: m.rows };
		return {};
	}

	async function drive(arg: SimArg, localEcho: string) {
		if (busy) return;
		busy = true;
		error = null;
		chat.push({ from: 'person', text: localEcho });
		try {
			const { messages } = await simulate(arg);
			for (const r of messages) {
				chat.push({
					from: 'kudi',
					text: r.message.body,
					...optsOf(r.message),
					contextId: r.wa_message_id
				});
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function sendText() {
		const text = draft.trim();
		if (!text) return;
		draft = '';
		drive({ wa_id: waId, name, text }, text);
	}

	function tapButton(contextId: string, id: string, title: string) {
		drive(
			{ wa_id: waId, name, button_reply: { id, title, context_wa_message_id: contextId } },
			title
		);
	}
	function tapRow(contextId: string, id: string, title: string) {
		drive(
			{ wa_id: waId, name, list_reply: { id, title, context_wa_message_id: contextId } },
			title
		);
	}

	function fresh() {
		const n = Math.abs(Date.now() % 1000000)
			.toString()
			.padStart(6, '0');
		waId = '34600' + n;
		chat = [];
		error = null;
	}

	// The most recent Kudi message with tappable options.
	const lastInteractive = $derived(
		[...chat].reverse().find((c) => c.from === 'kudi' && (c.buttons || c.rows))
	);
</script>

<div class="card">
	<div class="stack">
		<div class="row">
			<div style="flex:1">
				<label for="wa">Telèfon fals</label>
				<input id="wa" type="text" bind:value={waId} />
			</div>
			<div style="flex:1">
				<label for="nm">Nom del perfil</label>
				<input id="nm" type="text" bind:value={name} />
			</div>
		</div>
		<button class="btn ghost small" onclick={fresh}>Persona nova (reinicia)</button>
		<p class="muted">
			Escriu com si fossis la persona. Pots provar el trigger:
			<em>Explica'm això del curs de sardanes</em>
		</p>
	</div>
</div>

<div class="transcript">
	{#each chat as item, i (i)}
		<div class="bubble {item.from === 'person' ? 'out' : 'in'}">
			{item.text}
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
