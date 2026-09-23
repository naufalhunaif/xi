# Conversation AI shipping

The authenticated Orion `tools/list` supplied on 2026-09-15 confirms `create_awb`,
`track_awb`, `list_orion_data`, `get_orion_data`, `search_destinations`, and
`check_shipping_rates`. Their output schemas are open objects, not field-level
contracts. Runtime parsing therefore rejects unrecognized or contradictory data.
`node ace.js orion:inspect --shipping` additionally reads AWB discovery metadata;
it does not create shipments, read customer records, or send messages.

## Execution

- Marking an active order Ready to ship stores a unique per-number shipping job
  in the same transaction. The worker backfills older ready orders as well.
- Every five seconds the worker may schedule one due shipping conversation under
  the room lock and a database lease. AI off, exclusions, CS takeover, a changed
  conversation or archived workspace prevent AI tool execution. Restart resumes
  durable jobs; it never replays an uncertain create.
- The selected ChatGPT/Claude OAuth runtime receives the same imported skills,
  room history, notes, waiting goal, and the exact invoice snapshot. It selects
  one typed tool intent at a time: `list_orion_data`, `prepare_awb`, `create_awb`,
  `track_awb`, or `wait`. This is not a restored provider session; conversation
  continuity comes from the application's persisted context, like normal chat.
- The application bridge executes the selected intent and returns verified
  observations/errors for the next AI decision (at most six decisions per run).
  `prepare_awb` bundles destination and rate checks; creation parameters come
  exclusively from that validated preparation, not free-form model arguments.
  No alternate autonomous shipment executor runs alongside the AI path.
- The ordinary chat runtime restricts recognized Orion connections to read tools;
  shipment writes use the fenced bridge. Tool activity and concise decision
  summaries appear in the room's Process details; private reasoning is not stored.
  Waiting/next action are persisted on the shipment and included in future chat
  context. The internal run sends no customer message and does not overwrite
  unrelated customer follow-up goals. A wait is revisited after five minutes.
- New `create_awb` calls use the exact WhatsApp invoice number (`INV-...`, or the
  displayed `WA-...` number for legacy orders) as Orion's `order_id`. No separate
  Orion order number or manual entry is required. Draft carts are not shipping orders.
- Lookup checks both the invoice number and the unchanged request UUID used by
  older releases. Conflicting AWBs fail closed; fuzzy hits cannot supply another
  customer's AWB. Existing uncertain attempts are never reset by this change.
- The destination/postcode and selected rate are verified against Orion. Parcel
  weight must already be stored in the shipping quote; customer body weight is
  never parcel weight. Multiple destination matches, changed prices and missing
  facts stop creation and appear in Order and Cart & Order.
- `street` preserves the customer's delivery address. `address` uses the selected
  Orion destination's `full_address` (administrative region), never a fallback to
  the customer's street. Older destination `address`/`name` fields and structured
  administrative fields remain supported. A carrier code can cover multiple
  villages: observed `CXP10022` resolves to Bulupayung by code, but a Cinyawang
  search supplies a distinct destination with the same code. The bridge checks
  village, district and city against the recipient address, searches individual
  administrative names when necessary, and rejects missing/ambiguous matches.
  This affects new preparations only; existing AWBs are not edited or recreated.
- `create_started_at` is committed before calling `create_awb`. A crash or timeout
  after this fence permits only reconciliation, never another automatic create.
  Orion's schema does not promise idempotency, so an empty lookup after an uncertain
  attempt is not permission to retry the side effect.
- Observed Orion audit records (2026-09-15) reject kilogram-valued `weight` with
  `Weight must be greater than zero.` Successful AWB calls use grams. Rate lookup
  still uses `weight_kg`; the create bridge converts the invoice's kilograms to
  integer grams. Successful create results wrap the record in `{ id, awb: {...} }`.
- Narrow recovery exception: after complete, empty exact-reference AWB lookups,
  the bridge may inspect `mcp_activity` for the same invoice/request reference.
  Only one completed, explicit weight-validation rejection with matching original
  weight, recipient phone and destination, no result, and no contradictory attempt
  permits re-preparation. The audit ID is consumed atomically under the lease and
  order lock; it cannot authorize a later retry after a new uncertain creation.
  Generic failures/timeouts, missing audit access and empty audit results never
  clear the creation fence. Unrelated audit records are not put into chat traces.
- A saved AWB remains Ready to ship. A newly created or reconciled AWB is tracked
  immediately in the same run, without another model decision. A due job with a
  known AWB also goes straight to tracking without invoking the model. Successful
  checks without movement are revisited after two minutes; failed checks defer
  with backoff while preserving the AWB, rather than repeating in the same run.
  Only a timestamped pickup/transit/delivery event matching the requested AWB and
  not older than the local order may advance it to Shipped. Booking alone cannot.
- The observed JNE response is nested under `tracking.data`, with `cnote.cnote_no`
  and history dates in `dd-MM-yyyy HH:mm` WIB. Pickup codes PU0/S01 and receipt RC1
  require the matching AWB and their explicit pickup/receipt descriptions. Generic
  `on process` alone is not movement evidence. Test AWBs belonging to other orders
  must not be attached to the customer's invoice or trigger customer notifications.
- A second observed tracking response has matching outer/tracking AWB IDs,
  `tracking.status: null`, and `tracking.data: {error: "Cnote No. Not Found.", status: false}`.
  Only this exact non-error MCP envelope is normalized to an empty tracking history:
  the job stays `waiting_pickup`, clears the old error, and checks again in two minutes.
  UI shows "Waiting for shipping update" without failure/retry counters. This means
  tracking is not available, not proof the parcel has or has not been dispatched.
  No AWB recreation, Shipped transition or customer notification is authorized.
  Auth/tool errors, different AWB IDs and malformed responses still fail validation.
- Transient failures use bounded exponential delay (15 seconds to 15 minutes).
  Leases expire after ten minutes. Missing authorization/data remain visible and
  are rechecked without changing the order or hiding failure details.

## Customer notification

A unique notification is queued in the same transaction as verified movement.
The existing OAuth AI composes its wording from imported skills and verified
order/AWB facts, with no MCP access during composition. It respects AI off,
exclusions and CS takeover, and uses the normal read/online/typing delivery flow.
The transport message ID is saved before sending. An unknown delivery result is
not resent automatically; subsequent outgoing-message evidence can reconcile it.
This prevents blind duplicates, but does not claim exactly-once delivery across
an external service outage. Cancelled orders never send notifications.

## Verification

`node scripts/test_cart_discount_database.mjs --shipping-queue` creates and drops
only an isolated local database; Orion, AI composition and WhatsApp are mocked.
Tests use a deterministic model stub, not live OAuth AI decisions. Unit tests exercise response parsing, pagination and movement evidence. UI tests
cover English/Indonesian, desktop/mobile, Chromium/WebKit. These do not prove a
live carrier response shape or real shipment; verify the first deployed order's
result before treating production integration as confirmed. Never run real
`create_awb` solely as a smoke test.

## Delivered orders

- Known AWBs continue tracking after `shipped` (every 30 minutes after verified movement). Existing shipped jobs resume after a worker restart; shipped orders with an AWB but no job are backfilled.
- Only a matching AWB with a valid dated `delivered` history event (or explicit JNE `DELIVERED TO …` history description) completes the operational order. Booking, out-for-delivery, missing dates, future events, and mismatched AWBs do not count.
- Completion stores `deliveredAt`, preserves `shippedOn`, records an operation event, and ends tracking. No new AWB or customer message is created. Pending obsolete shipping notices are cancelled.
- Orders opens on Active, with Completed and All filters. Search and pagination remain server-side; the closed-drawer list refreshes every 30 seconds. Financial order records and history are retained.
