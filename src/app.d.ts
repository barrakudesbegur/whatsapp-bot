// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}

		interface Locals {
			/** Set by hooks.server.ts for /admin routes (Cloudflare Access identity). */
			identity?: import('$lib/server/access').AccessIdentity;
		}

		// interface Error {}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
