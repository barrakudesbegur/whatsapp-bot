<script lang="ts">
	import {
		kbEntries,
		saveKb,
		deleteKb,
		settings,
		saveSettings,
		campaigns,
		saveCampaign,
		deleteCampaign
	} from './data.remote';

	type KbEntry = Awaited<ReturnType<typeof kbEntries>>[number];
	type Campaign = Awaited<ReturnType<typeof campaigns>>[number];

	// Course status is editable, so seed local state from the server. Top-level
	// `await` (Svelte 5.36+) — the parent <svelte:boundary> shows the pending UI.
	type CourseStatus = 'exploring' | 'confirmed' | 'cancelled';
	const current = await settings();
	let settingsForm = $state<{ course_status: CourseStatus; course_status_note: string }>({
		course_status: current.course_status as CourseStatus,
		course_status_note: current.course_status_note
	});
	let savingSettings = $state(false);
	let settingsSaved = $state(false);

	// KB editor form. `editing` distinguishes updating an existing entry from a new one.
	let form = $state({ slug: '', title: '', content_md: '', active: true });
	let editing = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	async function persistSettings() {
		savingSettings = true;
		settingsSaved = false;
		try {
			await saveSettings(settingsForm);
			settingsSaved = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			savingSettings = false;
		}
	}

	function edit(entry: KbEntry) {
		form = {
			slug: entry.slug,
			title: entry.title,
			content_md: entry.content_md,
			active: entry.active === 1
		};
		editing = true;
	}
	function reset() {
		form = { slug: '', title: '', content_md: '', active: true };
		editing = false;
	}

	async function persistKb() {
		if (!/^[a-z0-9-]+$/.test(form.slug) || !form.title.trim()) {
			error = 'Cal un slug en minúscules-amb-guions i un títol.';
			return;
		}
		saving = true;
		error = null;
		try {
			await saveKb(form);
			reset();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	async function remove(entry: KbEntry) {
		if (!confirm(`Esborrar "${entry.title}"?`)) return;
		try {
			if (form.slug === entry.slug) reset();
			await deleteKb(entry.id);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	// Campaign editor form (same edit/create pattern as the KB above).
	let campaignForm = $state({ slug: '', title: '', pitch_md: '', active: true, priority: 0 });
	let editingCampaign = $state(false);
	let savingCampaign = $state(false);

	function editCampaign(c: Campaign) {
		campaignForm = {
			slug: c.slug,
			title: c.title,
			pitch_md: c.pitch_md,
			active: c.active === 1,
			priority: c.priority
		};
		editingCampaign = true;
	}
	function resetCampaign() {
		campaignForm = { slug: '', title: '', pitch_md: '', active: true, priority: 0 };
		editingCampaign = false;
	}

	async function persistCampaign() {
		if (!/^[a-z0-9-]+$/.test(campaignForm.slug) || !campaignForm.title.trim()) {
			error = 'Cal un slug en minúscules-amb-guions i un títol.';
			return;
		}
		savingCampaign = true;
		error = null;
		try {
			await saveCampaign(campaignForm);
			resetCampaign();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			savingCampaign = false;
		}
	}

	async function removeCampaign(c: Campaign) {
		if (!confirm(`Esborrar la campanya "${c.title}"?`)) return;
		try {
			if (campaignForm.slug === c.slug) resetCampaign();
			await deleteCampaign(c.id);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
</script>

{#if error}<p class="error">{error}</p>{/if}

<div class="card">
	<h2 style="font-size:1.2rem;margin-bottom:0.6rem">Estat del curs</h2>
	<div class="stack">
		<div>
			<label for="cs">Com respon en Kudi a "hi ha novetats?"</label>
			<select id="cs" bind:value={settingsForm.course_status}>
				<option value="exploring">Explorant (és una idea)</option>
				<option value="confirmed">Confirmat (es fa!)</option>
				<option value="cancelled">Cancel·lat</option>
			</select>
		</div>
		<div>
			<label for="note">Nota (opcional)</label>
			<input
				id="note"
				type="text"
				bind:value={settingsForm.course_status_note}
				placeholder="p. ex. comencem a l'octubre"
			/>
		</div>
		<div class="row">
			<button class="btn" disabled={savingSettings} onclick={persistSettings}>
				{savingSettings ? 'Desant…' : "Desa l'estat"}
			</button>
			{#if settingsSaved}<span class="muted">Desat ✓</span>{/if}
		</div>
	</div>
</div>

<div class="card">
	<h2 style="font-size:1.2rem;margin-bottom:0.6rem">
		{editingCampaign ? `Edita campanya: ${campaignForm.slug}` : 'Campanyes actives'}
	</h2>
	<p class="muted" style="margin-bottom:0.6rem">
		En Kudi les coneix i hi apunta suaument quan algú saluda o pregunta què es cou. Cap campanya
		activa = conversa normal sense empènyer res.
	</p>
	<div class="stack">
		<div>
			<label for="c-slug">Slug (minúscules-amb-guions)</label>
			<input
				id="c-slug"
				type="text"
				bind:value={campaignForm.slug}
				placeholder="curs-sardanes"
				readonly={editingCampaign}
			/>
		</div>
		<div>
			<label for="c-title">Títol</label>
			<input
				id="c-title"
				type="text"
				bind:value={campaignForm.title}
				placeholder="Curs de sardanes"
			/>
		</div>
		<div>
			<label for="c-pitch">Pitch (com ho explica en Kudi, 1-2 frases)</label>
			<textarea id="c-pitch" bind:value={campaignForm.pitch_md}></textarea>
		</div>
		<div>
			<label for="c-priority">Prioritat (més alta = s'esmenta primer)</label>
			<input id="c-priority" type="number" bind:value={campaignForm.priority} />
		</div>
		<label class="row" style="font-weight:400">
			<input type="checkbox" bind:checked={campaignForm.active} />
			Activa (en Kudi la promociona)
		</label>
		<div class="row">
			<button class="btn" disabled={savingCampaign} onclick={persistCampaign}>
				{savingCampaign ? 'Desant…' : editingCampaign ? 'Desa' : 'Crea'}
			</button>
			{#if editingCampaign}
				<button class="btn ghost small" onclick={resetCampaign}>Nova</button>
			{/if}
		</div>
	</div>
	<h3 style="font-size:1rem;margin:1rem 0 0.5rem">Campanyes ({(await campaigns()).length})</h3>
	{#each await campaigns() as c (c.id)}
		<div class="list-item">
			<div class="row">
				<span class="name">{c.title}</span>
				{#if c.active !== 1}<span class="badge off">inactiva</span>{/if}
				<span class="preview" style="margin-left:auto">{c.slug} · prioritat {c.priority}</span>
			</div>
			<div class="row" style="margin-top:0.3rem">
				<button class="btn ghost small" onclick={() => editCampaign(c)}>Edita</button>
				<button class="btn danger" onclick={() => removeCampaign(c)}>Esborra</button>
			</div>
		</div>
	{:else}
		<p class="muted">Cap campanya. Crea'n una a dalt quan hi hagi res a promoure.</p>
	{/each}
</div>

<div class="card">
	<h2 style="font-size:1.2rem;margin-bottom:0.6rem">
		{editing ? `Edita: ${form.slug}` : 'Nova entrada de coneixement'}
	</h2>
	<div class="stack">
		<div>
			<label for="slug">Slug (minúscules-amb-guions)</label>
			<input
				id="slug"
				type="text"
				bind:value={form.slug}
				placeholder="assaig-dijous"
				readonly={editing}
			/>
		</div>
		<div>
			<label for="title">Títol</label>
			<input id="title" type="text" bind:value={form.title} placeholder="Assaig de dijous" />
		</div>
		<div>
			<label for="content">Contingut (Markdown)</label>
			<textarea id="content" bind:value={form.content_md}></textarea>
		</div>
		<label class="row" style="font-weight:400">
			<input type="checkbox" bind:checked={form.active} />
			Activa (en Kudi la fa servir)
		</label>
		<div class="row">
			<button class="btn" disabled={saving} onclick={persistKb}>
				{saving ? 'Desant…' : editing ? 'Desa' : 'Crea'}
			</button>
			{#if editing}
				<button class="btn ghost small" onclick={reset}>Nova</button>
			{/if}
		</div>
	</div>
</div>

<h3 style="font-size:1rem;margin:1rem 0 0.5rem">Entrades ({(await kbEntries()).length})</h3>
{#each await kbEntries() as e (e.id)}
	<div class="list-item">
		<div class="row">
			<span class="name">{e.title}</span>
			{#if e.active !== 1}<span class="badge off">inactiva</span>{/if}
			<span class="preview" style="margin-left:auto">{e.slug}</span>
		</div>
		<div class="row" style="margin-top:0.3rem">
			<button class="btn ghost small" onclick={() => edit(e)}>Edita</button>
			<button class="btn danger" onclick={() => remove(e)}>Esborra</button>
		</div>
	</div>
{:else}
	<p class="muted">Cap entrada encara. Crea'n una a dalt.</p>
{/each}
