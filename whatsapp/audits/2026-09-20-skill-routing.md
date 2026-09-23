# Skill routing for customer replies

The reported prompt included about 108,627 estimated tokens, dominated by two merged Chameleon skills. Customer replies now select relevant policy sections before invoking the configured AI. Routing itself is local code and consumes no AI tokens. The model, reasoning setting, customer history, memory, goal, cart/order state, payment configuration and server-side business verification remain available as before.

## Route map

| Need | Initial policy domains |
| --- | --- |
| Catalogue / price / stock | Catalogue |
| Photo / visual reference | Visual, catalogue |
| Size / fit | Sizing, catalogue |
| Custom work | Custom, sizing, catalogue, cart |
| Cart / checkout | Cart, custom, sizing, catalogue, payment, shipping |
| Payment | Payment, cart, custom, catalogue, shipping |
| Shipping | Shipping, cart, custom, catalogue |
| Complaint / return | All domains |
| Unclear input | Complete original skills |

Multiple needs combine domains. Short replies also consider the previous outgoing message and stored waiting-for context. An active cart adds checkout-related policies. These hints never replace customer history or authorize skipping a new customer message. Existing anchor-based waiting/retry controls remain responsible for deciding whether to invoke AI at all.

## Policy preservation

- Common rules, unknown imports and unclassified top-level sections remain inline. Mandatory/global headings remain inline even inside a deferred topic.
- Initially recognised merged documents are `chameleon-cs-gabungan`, its numbered variants, and `cs-chameleon-cloth`. They are split at Markdown headings, preserving original text, order, fenced code and ancestor sections. Documents without useful headings remain full.
- `cs-detail-visual` is a visual module; `cs-chameleon-media` is a visual/catalogue module. Other individual imports stay complete, including cart, boundaries, context and answer-format rules.
- Deferred section IDs, source skill names, headings and domains appear in the prompt. The read-only local MCP `business_skill_library.read_business_skill` serves selected sections plus ancestors, or all original sections using `all=true`.
- The library is an immutable per-turn snapshot. It cannot read files, other rooms or other workspaces. Its reserved connection cannot be overridden by a saved remote source. Reads are not cached across phases and do not count as MCP business evidence.
- Every AI phase checks its draft for newly required policy domains, cart/checkout changes, visual outputs, payment-wait state, handoff, scheduled follow-up or explicit `needsFullSkillContext`. If necessary rules have not reached that provider phase, the customer-reply pipeline retries once with all original skills before returning any actionable decision. Fallback trace keys have a separate prefix so initial usage is retained.
- Full original skills still determine visual-cache fingerprints. Editing deferred policy therefore invalidates relevant cached observations as before.

## Observability and limits

`skill-routing` records selected routes, section counts, raw skill character totals before/after (after includes the section index), and the reason for full-context fallback. `prompt-size` measures the actual assembled prompt sections, including `peta-skill`; provider phase usage remains authoritative. `skill-routing-fallback` marks the bounded full-policy retry.

This is conservative routing, not a claim that keyword matching understands every conversation. Ambiguous input, unfamiliar skill formats and uncertain decisions use complete policy. On-demand reads and fallback may reduce savings for complex turns; a fallback can cost more than a full-only run. No hard truncation or arbitrary token cap was added.

Production skill bodies and the production server were unavailable locally. Their actual routing coverage, savings and answer quality require checking deployed traces and representative real conversations. No percentage of production savings or unchanged model-answer quality is claimed from fixture tests. Database availability and provider limits remain separate operational issues.

## Validation

Local tests use disposable databases and executable provider fixtures, never paid AI or WhatsApp sends:

- Routing unit tests cover mixed needs, short follow-ups, ambiguous context, active carts, mandatory/unknown policy, exact source reconstruction, fenced headings, per-phase reads, out-of-scope access rejection and late-decision fallback.
- Pipeline tests exercise an ordinary routed answer, live local MCP policy retrieval, domain expansion and explicit uncertainty. They verify unchanged customer context and at most one full-policy retry.
- Results: 18 routing/business-policy unit tests, 4 local-provider pipeline tests, 7 visual tests, 38 waiting/recovery/goal tests and 29 catalogue/cart tests passed (96 total). One explicitly paid live-model visual test remained skipped. Typecheck, scoped ESLint, whitespace checks and production build passed.

Deploy through the existing WhatsApp release workflow after pulling `main`. Inspect `skill-routing` and `prompt-size` for representative catalogue, size, custom, payment and waiting conversations; compare provider usage rather than raw character estimates.

## Follow-up: strict output schema regression

The routing change added `needsFullSkillContext` to the reply schema's properties but omitted it from the root `required` list. OpenAI Structured Outputs requires all properties to be required: https://developers.openai.com/api/docs/guides/structured-outputs#all-fields-must-be-required. This defect is consistent with a fast provider failure before tool calls; the supplied sanitized `AI_OUTPUT_INVALID` trace alone does not prove the server's exact rejection reason.

Added the missing required field. Recursive request-schema tests reproduced the defect for text and visual replies before the fix and passed afterward, including nested object variants. The executable routing fixture now checks the actual schema file passed to `--output-schema`, instead of merely returning a canned valid response. Explicit invalid-schema provider errors now surface as `AI_SCHEMA_INVALID`, with no raw provider output and no automatic retry/failover.

Validation: 26 focused unit tests and 4 disposable-DB/provider-fixture pipeline tests passed, as did production build and scoped ESLint. No live paid model or production server was exercised. Deploy/restart the corrected build, then explicitly retry a failed chat once; unchanged failed snapshots intentionally remain paused to prevent another token retry storm.

## Follow-up: provider error events and deployed-schema identification

A subsequent reported attempt still showed `AI_OUTPUT_INVALID`, zero tool calls and 7364 ms. The user confirmed a new attempt after deployment. Local measurement using the same `estimateTokens(JSON.stringify(DECISION_SCHEMA))` path gives 5823 before the required-field hotfix and 5829 afterward; the supplied trace shows 5823. This is evidence of an old schema in the displayed activity, not proof of why the deployment/worker/activity differs. Production access is still unavailable.

Found a separate observability defect: standalone Codex `error` events were retained only for quota failures. An explicit schema or context rejection followed by a clean exit without a final message could therefore become a generic output error. Known request-error events are now retained, later generic failures cannot overwrite them, and a successful `turn.completed` clears provisional errors. Context-capacity failures and missing final messages have separate codes; none trigger automatic failover or retry.

Each completed/failed provider phase now reports diagnosticsVersion=3, the actual schema file's SHA-256 prefix, whether its required list contains the routing field, and the worker PID. No prompt, credentials or raw error body is added. Tests reproduce standalone schema/context errors with a real local CLI fixture and no final message, verify preserved diagnostics, and verify one provider attempt. Validation: 17 focused unit tests, 6 disposable-DB pipeline tests, build and scoped lint passed. Root cause of the reported production attempt still needs the active-worker/new-trace evidence.
