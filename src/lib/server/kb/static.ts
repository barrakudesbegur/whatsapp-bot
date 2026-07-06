/**
 * Static knowledge base, versioned in the repo. The .md
 * files live next to this module and are imported as plain text via Vite's
 * `?raw` suffix (typed as string by vite/client). scripts/eval-catalan.ts reads
 * the same files from disk instead.
 */

import queEsBarrakudes from './que-es-barrakudes.md?raw';
import kudi from './kudi.md?raw';
import xarxes from './xarxes.md?raw';
import cursSardanesFaq from './curs-sardanes-faq.md?raw';

export const STATIC_KB = [queEsBarrakudes, kudi, xarxes, cursSardanesFaq].join('\n\n');
