# Follow-up: 2,182,452-token trace and custom cart reference

User-reported production trace: analysis 1,933,969 tokens, visual comparison 248,483 tokens.
Reported active release: `/www/wwwroot/Project/whatsapp/.deploy/release-brMVzQ/app`.
The folder name does not establish its source revision. Production has not been inspected or changed from this workspace.

## Findings and changes

- `redactTrace` matched every key containing `token`, including numeric `tokens`, `estimatedTokens`, and `savedTokens`. The prompt table formatted the redaction string as a number, producing `NaN`. Only these exact numeric accounting keys now bypass redaction; credentials and invalid values remain hidden. The UI also reconstructs estimates from character counts in older stored traces, including tool accounting.
- ChatGPT still used the default Codex coding instructions. Each process now receives the same focused WhatsApp system instructions already used by Claude, through a private per-run `model_instructions_file`. Business skills, history, model/reasoning settings, MCP evidence, output schema, and visual comparison are retained. Official option: https://learn.chatgpt.com/docs/config-file/config-reference (`model_instructions_file`).
- Byte-identical imported skill bodies can reference their first occurrence when that saves characters. Names and order are preserved. Different bodies, including nearly identical merged skill versions, remain complete. The supplied names `chameleon-cs-gabungan` and `chameleon-cs-gabungan-2` alone do not establish duplication; their production contents were unavailable locally.
- Custom-model photo validation threw a generic Error. The worker rethrew it and classified it as `AI_PROCESS_FAILED`; a failed turn never recorded a successful analyzed anchor. Validation now distinguishes missing ID, absent/wrong-room/incoming source, nonvisual source, and unloaded media with `CART_REFERENCE_UNAVAILABLE`. It uses the existing held-cart/CS-review route, sends no unverified confirmation/payment request, and records the analyzed anchor to prevent background reanalysis of the same input. This is a held decision, not a successful cart write. Human review remains necessary for an unresolved reference.
- The cart schema explicitly requires the original incoming photo `message_id`, and distinguishes custom size on a catalog model from a noncatalog custom model. No reference is guessed, substituted from another room, or fabricated when absent.

## Interpretation and limits

Provider usage includes input processed over model steps and cache reads. The 2.18M reported total is not the size of a single initial prompt, and this change does not replace actual usage with smaller estimates. Duplicate provider/bridge trace rows are not proof of duplicate upstream calls.

No production token reduction percentage or unchanged live answer quality has been measured. A controlled before/after evaluation on representative conversations is still required after deploying. In particular, the two large production skills may contain overlapping but different rules that this conservative optimization intentionally retains.

## Validation

Targeted unit tests cover redaction, legacy diagnostics, exact-content reuse, complete differing skills, business evidence, and loop policy. Browser fixtures cover Indonesian/current and English/legacy redacted trace rendering. Disposable-database cart tests cover valid and invalid media sources, unchanged cart on rejection, no outgoing message, no order, explicit CS review, and rejection of repeated analysis for the same message. Visual tests use a fake provider and retain complete visual skill contents and reference/candidate attachments; the paid live-model test remains skipped.

No real AI request, customer send, or production database modification is used by these tests.

Result: 28 unit tests, 29 cart/database tests, 7 fake-provider visual tests and 2 Chromium tests passed (66 total); one live-model visual test skipped. Typecheck and production build passed. Scoped lint passed except the unchanged `!= null` idioms already present in `cart_contract.ts`; that file's changed schema description is covered by typecheck.

## Active-release check

Read-only check on the reported server:

```sh
grep -n 'analyzed_anchor_id' /www/wwwroot/Project/whatsapp/.deploy/release-brMVzQ/app/app/services/conversation_goal_service.js
```

An empty result means that particular runtime file lacks the previous waiting-idempotence marker. Nonempty output establishes the marker's presence, not an exact commit or worker process cwd. Deploy through the repository's aaPanel script and verify both web and worker after the commit has reached the intended remote.
