<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
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
		<a href={resolve('/admin/converses')} aria-current={page.url.pathname === '/admin/converses'}>
			Converses
		</a>
		<a
			href={resolve('/admin/coneixement')}
			aria-current={page.url.pathname === '/admin/coneixement'}
		>
			Coneixement
		</a>
		{#if data.simulatorEnabled}
			<a
				href={resolve('/admin/simulador')}
				aria-current={page.url.pathname === '/admin/simulador'}
			>
				Simulador
			</a>
		{/if}
	</nav>

	<div class="content">
		<!-- One boundary handles the pages' `await` (top-level + in-markup). -->
		<svelte:boundary>
			{@render children()}

			{#snippet pending()}
				<p class="spinner">Carregant…</p>
			{/snippet}
		</svelte:boundary>
	</div>
</div>
