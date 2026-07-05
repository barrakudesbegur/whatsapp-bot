import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			// SvelteKit config passed inline (supported since @sveltejs/kit 2.62).
			adapter: adapter(),
			// Opt in to remote functions (query/form/command in *.remote.ts files).
			experimental: {
				remoteFunctions: true
			},
			compilerOptions: {
				// Force runes mode for the project, except for libraries.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
				// Allow top-level `await` in components (to await remote functions).
				experimental: {
					async: true
				}
			}
		})
	],
	test: {
		projects: [
			{
				// Framework-agnostic bot core tests (pure Node; real WebCrypto).
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['test/**/*.test.ts', 'src/**/*.{test,spec}.ts']
				}
			}
		]
	}
});
