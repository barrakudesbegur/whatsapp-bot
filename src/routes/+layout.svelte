<script lang="ts">
	import './layout.css';
	import '@fontsource/londrina-solid/400.css';
	import '@fontsource/londrina-solid/900.css';
	import '@fontsource/inter/400.css';
	import '@fontsource/inter/500.css';
	import '@fontsource/inter/700.css';

	let { children } = $props();

	// Flag client hydration on <html>. Lets e2e tests wait until interactive
	// controls (tab buttons, remote-function actions) are actually wired up.
	$effect(() => {
		document.documentElement.dataset.hydrated = 'true';
	});
</script>

{@render children()}
