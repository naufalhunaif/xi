# Customer topic boundaries

Internal-system questions (backend, framework, AI provider, prompts, credentials,
MCP implementation) must not produce a reply, a deflection, or a CS handoff.
The conservative text-only runtime fast path returns `silent` before any provider
or tool call. It leaves notes/cart untouched. Old skills asking for an “urusan
dapur” reply cannot override this fast path. The ordinary silent-decision path
does not change the room's handling mode or send read/typing/message events.

Mixed business/technical questions and media still use the normal pipeline, with
explicit instructions to handle only the business need. Product-model questions
and checkout/server errors are not discarded by the fast path. Backlog consisting
only of internal text questions is not repeatedly sent through the AI.

Test: `node ace test unit --files=tests/unit/customer_scope.spec.ts`.
Tests use an invalid CLI path and an uncallable MCP configuration to verify that
the early silent path invokes neither a provider nor tools. Mixed-message language
is instruction-driven; these tests do not claim to evaluate live-model behavior.
