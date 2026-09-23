# Visual reference matching

The current customer attachment is image 1. Live turns carry its message ID; backlog
selection is newest-first (up to four images), not the first four historical images.
An unreadable primary reference stops processing instead of promoting an older image.
Quoted/context images keep their own source labels, even if another attachment fails.

Catalog images are candidates, never customer selections. The comparison receives
verified product/Fit/shipping data but not the first-stage draft identity. Candidate
coverage is partial; no match does not prove absence from the entire catalog.

Visual turns return `visualMatch`: target image, status, source-qualified product ID,
and separate customer/catalog observations. Runtime requires two distinct identifying
features without contradictions and an actually attached candidate for `matched`.
Color alone is insufficient. Hidden features are unknown. Reply images must belong
to the matched candidate. `uncertain`/`no_match` cannot substitute catalog images or
mutate a catalog cart. An unpriced custom draft can refer to the current message;
the normal customer-confirmation and human model/price approval checks still apply.

An inconsistent decision gets at most one correction pass in its phase. A second invalid result
is withheld and routed for human review, with the reference identified in the note.
Evidence appears in the process trace and is appended to conversation notes. This is
a provenance/consistency gate, not a guarantee of model perception accuracy.

Preparation is labeled “Referensi katalog dimuat” with `matchStatus: not_evaluated`.
It does not expose a product list as if those products were selected. The final
comparison has a distinct label for matched/no-match/uncertain and an explicit
`matchedProducts` array. No-match and uncertain always have an empty selection;
their product ID/server are cleared before saving visual-reference notes.

Tests (no customer messages or real AI):

```
node ace test unit --files=tests/unit/visual_match_contract.spec.ts
node scripts/test_cart_discount_database.mjs --visual-match
```

The second command creates and removes only a fresh local fixture database, runs a
local image server and fake CLI. The existing live-model test is skipped by default.

## Observation and answer phases

For the exact reviewed policy sources, `visual-observation` compares the original
reference/candidate images with the visual policy and observation schema only. It
has no business MCP, history access or cart schema. One invalid observation may be
corrected; a second invalid observation is withheld for human review. Unknown or
changed policy sources retain the full-policy comparison path.

The answer phase receives the current conversation, selected reply policy, verified
business evidence and validated observations. It receives no image attachments when
observations are available, including on its one permitted validation correction.
Observed identity/findings are locked before validating answer images/cart actions;
the answer cannot replace them with an old identity. Neither observations nor cache
entries grant customer consent or payment approval.

The existing observation cache skips the pixel phase when its exact inputs match.
`visual-phase-plan` and provider `inputProfile` show cache use, image count and local
text-token estimates (excluding image/provider overhead). A cold comparison adds a
small observation call; total latency/cost savings require production measurement.
Initial catalog discovery can still consume substantial tokens.

With `COMPACT_SKILL_FIXTURE_DIR` pointing to local exports, the offline suite also
checks reviewed-source splitting, rejection/correction, cache reuse, and zero image
attachments in the answer phase in compact and full modes. Exports are read locally
and are not included in repository fixtures or sent to a real AI provider.
