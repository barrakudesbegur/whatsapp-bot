# AI-first understanding (deferred redesign)

> **Owner complaint, 2026-07-05:** "I saw that you do a lot of pattern matching
> and canned responses. That is NOT how I want the chatbot to work. I want it to
> use AI to understand the messages. The regex should barely be used."

This is a **large change** and is deliberately deferred (agreed with the owner)
so it doesn't destabilise the working end-to-end system. This note captures the
gap and a sketch of the target so it can be picked up cleanly.

## What the bot does today

The `curs-sardanes` flow is a scripted state machine where **regex/keyword
matching is the primary parser** and the AI is only a _fallback_:

- `src/flows/curs-sardanes.ts` — `parseName()` (strips Catalan lead-ins),
  `parseAvailability()` (keyword regex → bucket), `parseActionText()` (keyword
  regex → button id).
- `src/lib/normalize.ts` — `parseYesNo()` and normalisation helpers.
- `src/router.ts` — `gdprIntent()` (regex), and the routing order tries the
  scripted parse first, only calling `interpretStepAnswer()` (Workers AI) when
  the regex fails.
- Several **canned** strings (the AI stub's apology line, GDPR copy, etc.).

So a message is understood by regex first; the model is the safety net.

## What the owner wants

**AI-first**: the model should be the primary way inbound free text is
understood, with regex reduced to (at most) a cheap fast-path / cost guard, and
canned responses minimised in favour of Kudi answering in-voice.

## Sketch of the target (not yet implemented)

- Make `interpretStepAnswer()` (or a broader `understand()` call) the **first**
  step for any free-text answer, returning a structured intent:
  `{ kind: 'answer', field, value } | { kind: 'question' } | { kind: 'gdpr' } |
{ kind: 'chitchat' } | ...`. The flow acts on the structured intent.
- Keep a tiny deterministic fast-path ONLY for exact interactive replies
  (button/list ids never need AI) and maybe an obvious-yes/no shortcut, to save
  neurons — everything else goes through the model.
- Replace canned lines with model-generated Kudi replies grounded in the KB
  (the KB + persona plumbing from §4.6 already exists — reuse it).
- Add an intent-classification eval (extend `scripts/eval-catalan.ts`) and unit
  tests that mock the model so the flow logic stays testable.

## Why deferred / risks

- Cost: every inbound message hitting Workers AI raises neuron usage (free tier
  is 10k/day — still likely fine, but worth measuring). The fast-path for
  interactive replies keeps the common survey path cheap.
- Latency + reliability: the graceful-degradation fallback (canned line on model
  error) must stay, or the webhook risks failing when the model is down.
- Determinism in tests: flow unit tests currently assert exact scripted
  behaviour; they'll need to mock the model's structured output instead.

Until this lands, the scripted parser + AI fallback is what ships.
