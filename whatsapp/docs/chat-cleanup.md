# Delete chats and media

Settings → General → Delete chats & media requests a permanent, active-number-only
cleanup with explicit confirmation. It does not delete anything from the customer's
WhatsApp or delete contacts, carts, orders, balances, AI accounts, skills, MCP,
payment/production settings, profile pictures, guide assets or Baileys credentials.

The authenticated, CSRF-protected endpoint requires the current workspace version.
Mutation handlers use a per-database/workspace advisory lock; cleanup blocks new
mutations and outbound socket actions. The worker closes the transport without
logging out, drains tracked tasks, clears pending turns, then performs cleanup under
the same mutation lock. The stored session reconnects automatically afterward.

Only messages before the confirmation's whole-second cutoff are deleted; new
arrivals are preserved. Old timestamped history is rejected on reconnect. History
without timestamps is rejected after a cleanup, but new live messages are allowed.
Chat goals, review queues, notes, reactions and process/evaluation history are
cleared with the old conversation. Usage counters and business records stay intact.

Files are limited to validated, same-workspace chat attachment paths and validated
CS upload UUIDs. No recursive directory deletion or remote media deletion is used.
Referenced order/payment/approval source messages move into an order-only evidence
table, not the inbox, so order verification and media references remain usable.
Shared order media and new-message media are retained. The durable deletion manifest
survives crashes; missing files are safe to retry, other filesystem errors keep the
job pending rather than reporting success. Completion rotates the workspace version
to refresh browser tabs. Existing evidence schema should track message-schema changes.

Tests use an isolated disposable database and mocked file removal/WhatsApp; browser
tests use mocked API responses. Never invoke the real cleanup endpoint as a smoke test.
