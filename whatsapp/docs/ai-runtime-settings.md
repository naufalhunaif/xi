# Model, reasoning and speed

The AI settings page uses visible native model selects (including a custom model ID),
not browser-dependent datalists. A custom ID is preserved on reload. These are model
suggestions, not an entitlement list; the connected account and CLI determine availability.

Reasoning and service speed are separate:

| Provider | Reasoning | Speed |
| --- | --- | --- |
| ChatGPT/Codex | `model_reasoning_effort` | `features.fast_mode` and `service_tier="fast"` |
| Claude | `--effort` | `--settings '{"fastMode":true}'` |

Standard explicitly disables Fast. Fast never lowers effort or silently switches the
model. Fast may consume additional usage credits and is account/model dependent.
Claude noninteractive Fast requires CLI 2.1.205 or newer and a supported Opus model.
Reasoning levels also depend on the model; Auto leaves selection to the provider.
The service's inherited `CLAUDE_CODE_EFFORT_LEVEL` cannot override workspace settings.

Existing Speed low/medium/high values actually represented reasoning. Init-model
copies them once into separate reasoning columns and selects Standard, without
enabling billable Fast. Older browser payloads are interpreted the same way.
Fresh settings initialize reasoning to Auto and Speed to Standard. No migration CLI
is required. Deploy/restart WEB and WORKER for the new controls to take effect.

Checks: unit CLI-argument tests; disposable MySQL initialization/legacy upgrade,
partial saves and restart; Chromium/WebKit light/dark desktop/mobile UI fixtures.
No real provider generation or billing is triggered by these tests.

References checked September 16, 2026:
- https://developers.openai.com/codex/config-reference/
- https://developers.openai.com/codex/speed/
- https://code.claude.com/docs/en/model-config
- https://code.claude.com/docs/en/fast-mode
