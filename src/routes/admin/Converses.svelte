<script lang="ts">
	import { resolve } from '$app/paths';
	import { conversations, conversation, reply, erasePerson } from './data.remote';

	let { waEnabled }: { waEnabled: boolean } = $props();

	let openId = $state<number | null>(null);
	let draft = $state('');
	let sending = $state(false);
	let actionError = $state<string | null>(null);
	// Hide simulator-driven (test) conversations from the list.
	let hideTests = $state(false);

	function fmtTime(iso: string | null): string {
		if (!iso) return '';
		return new Date(iso).toLocaleString('ca-ES', {
			day: '2-digit',
			month: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	async function send(personId: number) {
		const text = draft.trim();
		if (!text || sending) return;
		sending = true;
		actionError = null;
		try {
			await reply({ personId, text });
			draft = '';
		} catch (e) {
			actionError = e instanceof Error ? e.message : String(e);
		} finally {
			sending = false;
		}
	}

	async function erase(personId: number, name: string) {
		if (!confirm(`Segur que vols esborrar totes les dades de ${name}?`)) return;
		actionError = null;
		try {
			await erasePerson(personId);
			openId = null;
		} catch (e) {
			actionError = e instanceof Error ? e.message : String(e);
		}
	}
</script>

{#if openId === null}
	{@const all = await conversations()}
	{@const visible = hideTests ? all.filter((c) => !c.isTest) : all}
	<div class="toolbar">
		<a class="btn small" href={resolve('/admin/export/curs-sardanes.csv')}>Exporta CSV</a>
		{#if all.some((c) => c.isTest)}
			<label class="row" style="font-weight:400;margin-left:auto">
				<input type="checkbox" bind:checked={hideTests} />
				Amaga proves ({all.filter((c) => c.isTest).length})
			</label>
		{/if}
	</div>
	{#each visible as c (c.id)}
		<button class="list-item" onclick={() => (openId = c.id)}>
			<div class="row">
				<span class="name">{c.name}</span>
				{#if c.isTest}<span class="badge off">test</span>{/if}
				{#if c.flowStatus}<span class="badge {c.flowStatus}">{c.flowStatus}</span>{/if}
				{#if c.gdprDeleted}<span class="badge off">esborrat</span>{/if}
				<span class="preview" style="margin-left:auto">{fmtTime(c.lastMessageAt)}</span>
			</div>
		</button>
	{:else}
		<div class="card">
			<p class="muted">
				{hideTests && all.length > 0
					? 'Només hi ha converses de prova (amagades).'
					: 'Encara no hi ha cap conversa. Prova el simulador! 💬'}
			</p>
		</div>
	{/each}
{/if}

{#if openId !== null}
	{@const detail = await conversation(openId)}
	<button class="back" onclick={() => (openId = null)}>← Totes les converses</button>

	<div class="row" style="margin-bottom:0.4rem">
		<h2 style="font-size:1.3rem">{detail.person.name}</h2>
		{#if detail.person.isTest}<span class="badge off">test</span>{/if}
		<button
			class="btn danger"
			style="margin-left:auto"
			onclick={() => erase(detail.person.id, detail.person.name)}
		>
			Esborra dades
		</button>
	</div>

	<div class="transcript">
		{#each detail.messages as m (m.id)}
			<div class="bubble {m.direction}">
				{#if m.header}<strong>{m.header}</strong><br />{/if}{m.text}
				{#if m.buttons?.length}
					<div class="opts">
						{#each m.buttons as b (b.id)}<span class="opt">{b.title}</span>{/each}
					</div>
				{/if}
				{#if m.rows?.length}
					<div class="opts">
						{#each m.rows as r (r.id)}<span class="opt">{r.title}</span>{/each}
					</div>
				{/if}
				<div class="meta">
					{fmtTime(m.createdAt)}
					{#if m.ai}· {m.ai.model}{/if}
					{#if m.direction === 'out' && m.status}· {m.status}{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if detail.person.gdprDeleted}
		<div class="window-closed">Aquesta persona ha estat esborrada (RGPD).</div>
	{:else if detail.person.windowOpen}
		<div class="composer">
			<textarea bind:value={draft} placeholder="Respon com en Kudi…" rows="1"></textarea>
			<button
				class="btn"
				disabled={sending || !draft.trim()}
				onclick={() => send(detail.person.id)}
			>
				{sending ? '…' : 'Envia'}
			</button>
		</div>
		{#if actionError}<p class="error">{actionError}</p>{/if}
		{#if !waEnabled}
			<p class="muted">
				WhatsApp està desactivat (WA_ENABLED=false): els enviaments es registren però no surten de
				debò.
			</p>
		{/if}
	{:else}
		<div class="window-closed">
			Fa més de 24 h del darrer missatge seu, així que WhatsApp no deixa respondre-li lliurement
			(finestra tancada). Els missatges amb plantilla arribaran en una fase posterior.
		</div>
	{/if}
{/if}
