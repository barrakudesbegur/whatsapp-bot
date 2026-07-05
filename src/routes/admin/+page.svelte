<script lang="ts">
	import type { PageProps } from './$types';
	import Converses from './Converses.svelte';
	import Coneixement from './Coneixement.svelte';
	import Simulador from './Simulador.svelte';

	let { data }: PageProps = $props();

	type Tab = 'converses' | 'coneixement' | 'simulador';
	let tab = $state<Tab>('converses');
</script>

<svelte:head>
	<title>Panell d'en Kudi</title>
</svelte:head>

<div class="app">
	<div class="topbar">
		<h1>Panell d'en Kudi</h1>
		{#if data.email}<span class="who">{data.email}</span>{/if}
	</div>

	<nav class="tabs">
		<button aria-current={tab === 'converses'} onclick={() => (tab = 'converses')}>Converses</button
		>
		<button aria-current={tab === 'coneixement'} onclick={() => (tab = 'coneixement')}>
			Coneixement
		</button>
		{#if data.simulatorEnabled}
			<button aria-current={tab === 'simulador'} onclick={() => (tab = 'simulador')}
				>Simulador</button
			>
		{/if}
	</nav>

	<div class="content">
		<!-- One boundary handles the components' `await` (top-level + in-markup). -->
		<svelte:boundary>
			{#if tab === 'converses'}
				<Converses waEnabled={data.waEnabled} />
			{:else if tab === 'coneixement'}
				<Coneixement />
			{:else if tab === 'simulador' && data.simulatorEnabled}
				<Simulador />
			{/if}

			{#snippet pending()}
				<p class="spinner">Carregant…</p>
			{/snippet}
		</svelte:boundary>
	</div>
</div>
