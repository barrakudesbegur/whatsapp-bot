<script lang="ts">
	import Converses from '../Converses.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<Converses waEnabled={data.waEnabled} />
