# Verified evidence cache

Created by `app:init`, without migrations: `whatsapp_evidence_cache`, scoped using
the existing per-number workspace prefix. Used by both ChatGPT and Claude. It
stores tool evidence/visual observations, never a prior AI reply, decision or cart
mutation. Restart/build does not erase it. Chat/media cleanup erases the cache too.

| Evidence | Maximum age | Invalidation |
| --- | --- | --- |
| `check_shipping_rates` | 15 minutes | Every exact tool argument, source URL, source schema, OAuth token identity, workspace |
| `search_destinations` | 24 hours | Same full request key; empty results not cached |
| `fit_advisor` | 24 hours | Type, height, weight, optional style/age and every other argument; source/auth/schema/workspace |
| Unfiltered product identity digest | 6 hours | Exact request/source/auth/schema/workspace; price/stock omitted; searches discover new products |
| Product search and `get_product` / product `get_record` | 60 seconds, one reply only | All arguments/source/auth/schema/workspace; discarded for the next customer turn |
| Tool schema discovery | 60 seconds, one reply only | Source/auth/server version/instructions/workspace and pagination arguments |
| Verified visual comparison | 24 hours | Hashes of all prepared customer/catalog pixels, candidate metadata, question, provider/model, skills, visual policy, workspace |

The tool bridge is loopback-only, bearer-protected with a fresh per-run secret and
closed after the provider exits. Upstream OAuth tokens are hashed for cache keys,
not stored in the cache or trace. Tool discovery/auth still run. A matching call
returns the original result to the model and existing evidence validators; the
expensive business request is skipped. Object argument order is ignored, but
array order, types and all values remain significant. Switching provider alone
does not invalidate MCP evidence. Refreshing/reconnecting OAuth can safely cause
a cache miss. Identical in-flight reads in one run are coalesced.

For a quote containing REG and YES, choosing another returned service can reuse
the same quote if the request inputs are identical. Different weight, destination,
origin, dimensions or service arguments use a new request. No stale-on-error
fallback. Invalid/error results are not stored. Cache read/write failure permits
live lookup instead of failing the conversation. Unknown tools, non-product
`list_records`, dedicated stock queries, AWB creation/tracking, order status and
payments remain live. Product detail price/stock can be reused for at most 60
seconds inside one reply; the next customer turn reads it again. A catalog snapshot
is not a stock reservation or payment confirmation.

The reply owns a bounded in-memory cache (64 entries, at most 128 KiB per entry)
shared with its fallback, visual and provider phases. It coalesces identical
concurrent reads and does not renew expiry on hits. Empty/failed/unknown product
results are not stored. No stale result is served on upstream failure. Product
requests marked destructive or explicitly non-read-only bypass result caching.
Local skill-library/history discovery stays live because it is phase-specific.
MCP authentication still runs, and a changed identity invalidates reuse.

Trace cache details identify `scope: reply`, `workspace`, or `none`. Cached schemas
still have to be sent to the model, and a cached tool result still consumes model
input tokens. This avoids redundant upstream work, not the model tool turn itself.
The provider's tool activity and the app's cache activity can describe the same
logical call; similarly named adjacent rows do not alone prove duplicate remote
requests. Large prompt reduction remains separate from this cache optimization.

An unchanged shipping selection already saved in the current room's cart is
retained when only the recipient name/phone is completed. Both the pre-reply
business check and the final cart validator use the same package/address/service/
cost comparison. This does not create fresh MCP evidence, extend the quote cache
TTL, or accept a tariff copied from chat history. A changed destination, package,
service or cost still requires matching MCP evidence. Other business verification,
cart version checks and checkout authorization remain in force.

For a short reply to an active cart question, the initial policy uses the cart
route even if the wording has no recognized domain keyword. The model receives
the original message and context and remains responsible for its meaning. The
pattern route accepts net policy savings of at least 5%; the main cart policy
stays complete and unrelated visual modules can be read on demand. A scheduled
follow-up requires its complete named source policy, rather than every unrelated
skill. Unknown sources, unread required rules and handoff still trigger coverage
checks. Current cart values never enter the shared pattern-plan cache.

Visual hits skip repeated pixel comparison in the comparison phase, not the
entire conversation turn. The current reply/actions are generated again from
current state. Uncertain/non-product results are not reused. Catalog discovery
and initial customer-media analysis still run; there is no claim that all vision
work is eliminated. The cache is conservative and exact, not perceptual matching.

For a single **previously analyzed, explicitly quoted** product photo, a separate
follow-up observation record can also skip the initial image pass. The first pass
is text-only with prior observations and current business lookup. The model must
explicitly report that no new visual inspection is needed. Freshly downloaded
candidate pixels and metadata must match their original fingerprint. Otherwise
the whole visual path runs again, once; no unverified draft is sent. New attachments,
multiple images, unknown references and uncertain results never use this shortcut.
Room, reference message ID, customer pixels, sources, provider/model, skills and
policy all bind the record; it expires after 24 hours and hits do not renew it.

Very detailed garment observations cover lapels, trim, buttons, pockets,
construction, sleeves, hem, texture/pattern, color and visibility. Back details
are unknown without a usable back view; fabric composition, body size, hidden
buttons and accessories included in a package cannot be invented. New visual
questions not covered by stored observations require fresh inspection. Detail is
audit evidence, not private reasoning, and does not lengthen the customer reply.

`whatsapp_customer_memory` is initialized per workspace with at most 64 facts per
room. Each turn can supply 16 source-cited updates in the same AI response (no
extra summarization call). Original non-AI messages must belong to the room and
precede the run anchor; edits/deletions invalidate the source digest. Facts are
advisory, never financial/approval authority. Recent 24 messages, all replies,
recaps, human decisions and unsummarized input are retained. Only older customer
text reproduced verbatim in the memory source section may be deduplicated.
Read-only `business_conversation_history.read_conversation_history` can retrieve
older originals in pages of 20, constrained to this room and run anchor. It cannot
count as business MCP verification. If memory is unavailable, full history wins.
Chat deletion removes these memories too; imported skills are unchanged.

Process details include context preparation milliseconds, read/shown message
counts, memory-fact count, prompt characters, queue/batching delay and total AI
processing time (excluding delivery). No model downgrade or artificial speed
target is applied. Real production latency still needs measurement after deploy.

Process details show **MCP result · Cache / Live** and **Visual comparison · Cache /
New analysis**, with source/tool, hit/miss/expired/bypass/unavailable/coalesced and
stored/expiry timestamps where available. Provider token-cache usage is separate.
The cache holds approximately 500 records per workspace; MCP records over 128 KiB
are not stored. Expired entries are purged on write. No admin cache settings added.

Tests use memory stores, local MCP fixture transport and a disposable database.
They do not log in to providers, call business services or send customer messages.
