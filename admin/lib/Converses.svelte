<script lang="ts">
  import {
    api,
    ApiError,
    type Conversation,
    type RenderedMessage,
    type PersonDetail,
  } from "./api";

  let { waEnabled }: { waEnabled: boolean } = $props();

  let conversations = $state<Conversation[]>([]);
  let loading = $state(true);
  let listError = $state<string | null>(null);

  let openId = $state<number | null>(null);
  let person = $state<PersonDetail | null>(null);
  let messages = $state<RenderedMessage[]>([]);
  let threadLoading = $state(false);
  let draft = $state("");
  let sending = $state(false);
  let replyError = $state<string | null>(null);

  function loadList() {
    loading = true;
    api
      .conversations()
      .then((r) => (conversations = r.conversations))
      .catch((e) => (listError = String(e?.message ?? e)))
      .finally(() => (loading = false));
  }

  // Client-only SPA (no SSR): load the list once at init.
  loadList();

  function open(id: number) {
    openId = id;
    threadLoading = true;
    replyError = null;
    draft = "";
    api
      .messages(id)
      .then((r) => {
        person = r.person;
        messages = r.messages;
      })
      .catch((e) => (replyError = String(e?.message ?? e)))
      .finally(() => (threadLoading = false));
  }

  function back() {
    openId = null;
    person = null;
    messages = [];
    loadList();
  }

  async function send() {
    const text = draft.trim();
    if (!text || !person || sending) return;
    sending = true;
    replyError = null;
    try {
      await api.reply(person.id, text);
      draft = "";
      const r = await api.messages(person.id);
      person = r.person;
      messages = r.messages;
    } catch (e) {
      replyError =
        e instanceof ApiError && e.status === 409
          ? "window_closed"
          : String((e as Error)?.message ?? e);
    } finally {
      sending = false;
    }
  }

  async function erase() {
    if (!person) return;
    if (!confirm(`Segur que vols esborrar totes les dades de ${person.name}?`))
      return;
    try {
      await api.erase(person.id);
      back();
    } catch (e) {
      replyError = String((e as Error)?.message ?? e);
    }
  }

  function fmtTime(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString("ca-ES", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

{#if openId === null}
  <div class="toolbar">
    <button class="btn ghost small" onclick={loadList}>↻ Actualitza</button>
    <a class="btn small" href={api.exportUrl()}>Exporta CSV</a>
  </div>

  {#if loading}
    <p class="spinner">Carregant converses…</p>
  {:else if listError}
    <p class="error">{listError}</p>
  {:else if conversations.length === 0}
    <div class="card">
      <p class="muted">Encara no hi ha cap conversa. Prova el simulador! 💬</p>
    </div>
  {:else}
    {#each conversations as c (c.id)}
      <button class="list-item" onclick={() => open(c.id)}>
        <div class="row">
          <span class="name">{c.name}</span>
          {#if c.flowStatus}
            <span class="badge {c.flowStatus}">{c.flowStatus}</span>
          {/if}
          {#if c.gdprDeleted}
            <span class="badge off">esborrat</span>
          {/if}
          <span class="preview" style="margin-left:auto">
            {fmtTime(c.lastMessageAt)}
          </span>
        </div>
      </button>
    {/each}
  {/if}
{:else}
  <button class="back" onclick={back}>← Totes les converses</button>

  {#if threadLoading}
    <p class="spinner">Carregant…</p>
  {:else if person}
    <div class="row" style="margin-bottom:0.4rem">
      <h2 style="font-size:1.3rem">{person.name}</h2>
      <button class="btn danger" style="margin-left:auto" onclick={erase}>
        Esborra dades
      </button>
    </div>

    <div class="transcript">
      {#each messages as m (m.id)}
        <div class="bubble {m.direction}">
          {#if m.header}<strong>{m.header}</strong><br />{/if}{m.text}
          {#if m.buttons?.length}
            <div class="opts">
              {#each m.buttons as b (b.id)}<span class="opt">{b.title}</span
                >{/each}
            </div>
          {/if}
          {#if m.rows?.length}
            <div class="opts">
              {#each m.rows as r (r.id)}<span class="opt">{r.title}</span
                >{/each}
            </div>
          {/if}
          <div class="meta">
            {fmtTime(m.createdAt)}
            {#if m.ai}· {m.ai.model}{/if}
            {#if m.direction === "out" && m.status}· {m.status}{/if}
          </div>
        </div>
      {/each}
    </div>

    {#if person.gdprDeleted}
      <div class="window-closed">
        Aquesta persona ha estat esborrada (RGPD).
      </div>
    {:else if person.windowOpen}
      <div class="composer">
        <textarea bind:value={draft} placeholder="Respon com en Kudi…" rows="1"
        ></textarea>
        <button class="btn" disabled={sending || !draft.trim()} onclick={send}>
          {sending ? "…" : "Envia"}
        </button>
      </div>
      {#if replyError && replyError !== "window_closed"}
        <p class="error">{replyError}</p>
      {/if}
      {#if !waEnabled}
        <p class="muted">
          WhatsApp està desactivat (WA_ENABLED=false): els enviaments es
          registren però no surten de debò.
        </p>
      {/if}
    {:else}
      <div class="window-closed">
        Fa més de 24 h del darrer missatge seu, així que WhatsApp no deixa
        respondre-li lliurement (finestra tancada). Els missatges amb plantilla
        arribaran en una fase posterior.
      </div>
    {/if}
  {/if}
{/if}
