# Interrupted activity, repeated sweeps and quota failures

## Evidence and limits

The user supplied an interrupted analysis with no recorded tool calls, an estimated 108,627-token initial prompt and 10,576 estimated schema tokens. The supplied worker logs span multiple historical releases and include MySQL connection resets/refusals, pool acquisition timeouts, repeated quota refusals, and repeated sweep messages. One timestamped MySQL refusal is 2026-09-16T06:30:29.559Z, so these logs cannot by themselves prove the cause of a September 20 trace. Production has not been accessed or changed from this workspace.

Raw logs are deliberately not copied here: they contain customer data and WhatsApp session key material.

## Verified code defects and changes

- Trace reads infer `interrupted` after four minutes without a stored update. That is missing progress evidence, not a confirmed MCP/schema failure. The UI now shows the pending analysis rather than the last completed schema event, and reports `TRACE_UPDATES_STALE` with a check-worker action. Up to 40 prompt sections survive redaction and percentages use the full prompt size instead of the truncated visible subtotal.
- MCP teardown previously had no application-level deadline, and the AI phase's terminal audit waited for teardown. Shutdown now stops the loopback listener first, closes connections concurrently, and waits at most five seconds. A stalled cleanup gets a separate `MCP_CLEANUP_TIMEOUT` event without rerunning AI. This is a robustness fix; the user's logs do not establish that teardown caused their incident.
- A paused goal with a failure could be reclaimed repeatedly by backlog/reconnect despite unchanged input. SQL selection, goal claiming, recovery and review queuing now respect that pause. New external input or explicit activation/human decision may resume it. Failed work remains failed, never marked successfully analyzed. Operational consequence: after repairing the underlying issue, explicitly reactivate the affected room; failed unchanged requests do not resume on a periodic sweep alone.
- Provider planning previously still included a known exhausted engine when failover was off or both engines were limited. Known limited engines are now excluded until their recorded recovery time. No process is spawned when none is available. Enabled failover can use the healthy alternate engine. An expired limit makes the engine eligible again for a new/explicitly resumed request.
- A database error reading quota state previously fell back to launching the configured provider. That fallback is removed: unavailable state storage cannot bypass quota checks and start work whose result may not be persisted.
- The review path attached a customer image without its `messageId`, although the live/backlog paths supplied it. Review now forwards the real ID for custom-cart source validation. No missing reference is guessed.
- MySQL/Knex/tarn connection failures now classify as `DATABASE_UNAVAILABLE`; an application-enforced 180-second AI deadline becomes `AI_TIMEOUT`. Generic network `ETIMEDOUT` remains a network failure when database evidence is absent.
- Sweep logs no longer claim a reply was sent merely because `deliverAiDecision` returned (silent/cancelled/held decisions also return). They log the input anchor. Worker startup logs include PID and cwd to identify the running release.
- The historical duplicate outgoing insert error is already handled by `saveSentAiMessage`; regression tests confirm same-room outgoing echoes are merged without resending, while other-room collisions remain rejected.

## Validation

Tests use fake sockets/providers and disposable local databases only. They cover repeated failed snapshots across sweeps/reconnects, explicit retry/new input, successful waiting idempotence, quota exclusion and expiry, reference ID propagation, outgoing echo races, bounded MCP shutdown, database diagnostics and stale UI rendering.

Result: 22 unit tests, 38 waiting/recovery/goal/evaluation database tests, 6 quota/failover database tests, and 2 Chromium tests passed (68 total). Typecheck, scoped lint and production build passed.

MySQL server health, active production worker PID/release, and actual post-deploy token savings remain unverified. No model, reasoning setting, business rule, history context or visual verification was reduced in this change. The large imported production skills still require content review before any semantic reduction.
