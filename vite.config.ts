import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			// SvelteKit config passed inline (supported since @sveltejs/kit 2.62).
			adapter: adapter({
				// The AI binding has no local emulator, so `vite dev` (getPlatformProxy)
				// opens an AUTHENTICATED remote proxy to it at boot — which needs
				// Cloudflare credentials and fails on a fresh clone / in CI. In fake-AI
				// mode (e2e + local smoke tests) the FakeDecider never calls env.AI, so
				// disable remote bindings entirely and boot with zero Cloudflare auth.
				// A manual `vite dev` (real Workers AI) keeps the default remote proxy.
				platformProxy: process.env.DEV_FAKE_AI === 'true' ? { remoteBindings: false } : undefined
			}),
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
