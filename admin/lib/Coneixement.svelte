<script lang="ts">
  import { api, type KbEntry, type Settings } from "./api";

  // --- Course status ---
  let settings = $state<Settings>({
    course_status: "exploring",
    course_status_note: "",
  });
  let savingSettings = $state(false);
  let settingsSaved = $state(false);

  // --- KB entries ---
  let entries = $state<KbEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Editor form. `editing` tracks whether we're updating an existing entry
  // (loaded via edit()) vs. composing a new one — a new entry needs a slug too,
  // so we can't key the heading on the slug being non-empty.
  let form = $state({ slug: "", title: "", content_md: "", active: true });
  let editing = $state(false);
  let saving = $state(false);

  function loadAll() {
    loading = true;
    Promise.all([api.settings(), api.kb()])
      .then(([s, k]) => {
        settings = s;
        entries = k.entries;
      })
      .catch((e) => (error = String(e?.message ?? e)))
      .finally(() => (loading = false));
  }

  // Client-only SPA (no SSR): load once at init.
  loadAll();

  async function saveSettings() {
    savingSettings = true;
    settingsSaved = false;
    try {
      settings = await api.saveSettings(settings);
      settingsSaved = true;
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      savingSettings = false;
    }
  }

  function edit(entry: KbEntry) {
    form = {
      slug: entry.slug,
      title: entry.title,
      content_md: entry.content_md,
      active: entry.active === 1,
    };
    editing = true;
  }

  function reset() {
    form = { slug: "", title: "", content_md: "", active: true };
    editing = false;
  }

  async function save() {
    if (!/^[a-z0-9-]+$/.test(form.slug) || !form.title.trim()) {
      error = "Cal un slug en minúscules-amb-guions i un títol.";
      return;
    }
    saving = true;
    error = null;
    try {
      await api.saveKb(form);
      reset();
      const k = await api.kb();
      entries = k.entries;
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      saving = false;
    }
  }

  async function remove(entry: KbEntry) {
    if (!confirm(`Esborrar "${entry.title}"?`)) return;
    try {
      await api.deleteKb(entry.id);
      if (form.slug === entry.slug) reset();
      entries = entries.filter((e) => e.id !== entry.id);
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
  }
</script>

{#if loading}
  <p class="spinner">Carregant…</p>
{:else}
  {#if error}<p class="error">{error}</p>{/if}

  <div class="card">
    <h2 style="font-size:1.2rem;margin-bottom:0.6rem">Estat del curs</h2>
    <div class="stack">
      <div>
        <label for="cs">Com respon en Kudi a "hi ha novetats?"</label>
        <select id="cs" bind:value={settings.course_status}>
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
          bind:value={settings.course_status_note}
          placeholder="p. ex. comencem a l'octubre"
        />
      </div>
      <div class="row">
        <button class="btn" disabled={savingSettings} onclick={saveSettings}>
          {savingSettings ? "Desant…" : "Desa l'estat"}
        </button>
        {#if settingsSaved}<span class="muted">Desat ✓</span>{/if}
      </div>
    </div>
  </div>

  <div class="card">
    <h2 style="font-size:1.2rem;margin-bottom:0.6rem">
      {editing ? `Edita: ${form.slug}` : "Nova entrada de coneixement"}
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
        <input
          id="title"
          type="text"
          bind:value={form.title}
          placeholder="Assaig de dijous"
        />
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
        <button class="btn" disabled={saving} onclick={save}>
          {saving ? "Desant…" : editing ? "Desa" : "Crea"}
        </button>
        {#if editing}
          <button class="btn ghost small" onclick={reset}>Nova</button>
        {/if}
      </div>
    </div>
  </div>

  <h3 style="font-size:1rem;margin:1rem 0 0.5rem">
    Entrades ({entries.length})
  </h3>
  {#if entries.length === 0}
    <p class="muted">Cap entrada encara. Crea'n una a dalt.</p>
  {:else}
    {#each entries as e (e.id)}
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
    {/each}
  {/if}
{/if}
