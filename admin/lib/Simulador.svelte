<script lang="ts">
  import { simulate, type SimReply } from "./api";

  interface ChatItem {
    from: "person" | "kudi";
    text: string;
    buttons?: { id: string; title: string }[];
    rows?: { id: string; title: string }[];
    contextId?: string;
  }

  let waId = $state("34600" + "000000");
  let name = $state("Prova");
  let draft = $state("");
  let chat = $state<ChatItem[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function rowsOf(m: SimReply["message"]): { id: string; title: string }[] {
    if (m.rows) return m.rows;
    return (m.sections ?? []).flatMap((s) => s.rows ?? []);
  }

  function appendReplies(replies: SimReply[]) {
    for (const r of replies) {
      const m = r.message;
      const rows = rowsOf(m);
      chat.push({
        from: "kudi",
        text: m.body ?? "",
        buttons: m.buttons,
        rows: rows.length ? rows : undefined,
        contextId: r.wa_message_id,
      });
    }
  }

  async function drive(payload: Record<string, unknown>, localEcho: string) {
    if (busy) return;
    busy = true;
    error = null;
    chat.push({ from: "person", text: localEcho });
    try {
      const replies = await simulate({ wa_id: waId, name, ...payload });
      appendReplies(replies);
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      busy = false;
    }
  }

  function sendText() {
    const text = draft.trim();
    if (!text) return;
    draft = "";
    drive({ text }, text);
  }

  function tapButton(contextId: string, id: string, title: string) {
    drive(
      { button_reply: { id, title, context_wa_message_id: contextId } },
      title,
    );
  }

  function tapRow(contextId: string, id: string, title: string) {
    drive(
      { list_reply: { id, title, context_wa_message_id: contextId } },
      title,
    );
  }

  function fresh() {
    // New fake person: bump the trailing digits so flows start clean.
    const n = Math.abs(Date.now() % 1000000)
      .toString()
      .padStart(6, "0");
    waId = "34600" + n;
    chat = [];
    error = null;
  }

  // The most recent Kudi message with tappable options (interactive reply must
  // reference its context id).
  const lastInteractive = $derived(
    [...chat].reverse().find((c) => c.from === "kudi" && (c.buttons || c.rows)),
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
    <button class="btn ghost small" onclick={fresh}
      >Persona nova (reinicia)</button
    >
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
              onclick={() => tapButton(item.contextId ?? "", b.id, b.title)}
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
              onclick={() => tapRow(item.contextId ?? "", r.id, r.title)}
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
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendText();
      }
    }}></textarea>
  <button class="btn" disabled={busy || !draft.trim()} onclick={sendText}>
    Envia
  </button>
</div>
