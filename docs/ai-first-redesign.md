# AI-first understanding — IMPLEMENTED (2026-07-06)

The AI-first redesign the owner asked for is **done** (branch
`ai-first-understanding`). The canonical description now lives in the README
("Architecture — AI-first" and "The decision contract" sections). Short version:

- **Every** human message is understood by one `decide()` model call that
  returns `{ reply, actions[], control? }` — the model decides what to do and
  acts through a whitelisted action set (save/change the name, record survey
  answers, start/restart/decline the survey, initiate/confirm/cancel erasure).
- The model also **generates the tappable options** (buttons/list); code assigns
  ids, clamps to WhatsApp limits, and a tap flows back through `decide()` as
  text — free text and taps are equal citizens.
- All regex parsers, trigger phrases and the step state machine were **deleted**
  (`flows/`, `normalize.ts`, the interpret/answer provider). The only
  deterministic paths left are language-free: dedupe, media apology, and the
  `gdpr_yes`/`gdpr_no` confirm taps.
- Unexpected answers are handled conversationally (e.g. refusing to give a name
  → "Anònim", conversation continues). The bot never demands a specific
  sentence.
- Safety: a degraded model turn never mutates state; a single message can never
  erase data (two-turn arm→confirm gate, proven in `test/erasure-gate.test.ts`);
  actions are validated by code (valibot) and carry no target.

Test a conversation from the terminal: `npm run chat` (see README).
