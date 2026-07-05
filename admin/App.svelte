<script lang="ts">
  import { api, type Config } from "./lib/api";
  import Converses from "./lib/Converses.svelte";
  import Coneixement from "./lib/Coneixement.svelte";
  import Simulador from "./lib/Simulador.svelte";

  type Tab = "converses" | "coneixement" | "simulador";

  let tab = $state<Tab>("converses");
  let config = $state<Config | null>(null);
  let loadError = $state<string | null>(null);

  // Client-only SPA (no SSR): load config once at init.
  api
    .config()
    .then((c) => (config = c))
    .catch((e) => (loadError = String(e?.message ?? e)));
</script>

<div class="app">
  <div class="topbar">
    <h1>Panell d'en Kudi</h1>
    {#if config}
      <span class="who">{config.email}</span>
    {/if}
  </div>

  {#if loadError}
    <div class="content">
      <div class="card">
        <p class="error">No s'ha pogut carregar el panell: {loadError}</p>
        <p class="muted">
          Si veus això en producció, comprova que has iniciat sessió amb
          Cloudflare Access.
        </p>
      </div>
    </div>
  {:else}
    <nav class="tabs">
      <button
        aria-current={tab === "converses"}
        onclick={() => (tab = "converses")}
      >
        Converses
      </button>
      <button
        aria-current={tab === "coneixement"}
        onclick={() => (tab = "coneixement")}
      >
        Coneixement
      </button>
      {#if config?.simulatorEnabled}
        <button
          aria-current={tab === "simulador"}
          onclick={() => (tab = "simulador")}
        >
          Simulador
        </button>
      {/if}
    </nav>

    <div class="content">
      {#if tab === "converses"}
        <Converses waEnabled={config?.waEnabled ?? false} />
      {:else if tab === "coneixement"}
        <Coneixement />
      {:else if tab === "simulador" && config?.simulatorEnabled}
        <Simulador />
      {/if}
    </div>
  {/if}
</div>
