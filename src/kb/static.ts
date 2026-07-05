/**
 * Static knowledge base, versioned in the repo (PLAN 4.6, layer 1). The .md
 * files are imported as plain text: wrangler bundles them via the `rules`
 * entry in wrangler.jsonc; vitest via the `raw-md` plugin in vitest.config.ts;
 * scripts/eval-catalan.ts reads the same files from disk instead.
 */

import queEsBarrakudes from "../../kb/que-es-barrakudes.md";
import kudi from "../../kb/kudi.md";
import xarxes from "../../kb/xarxes.md";
import cursSardanesFaq from "../../kb/curs-sardanes-faq.md";

export const STATIC_KB = [queEsBarrakudes, kudi, xarxes, cursSardanesFaq].join(
  "\n\n",
);
