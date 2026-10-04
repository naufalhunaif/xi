# Meaning-based customer decisions

The shared interpretation contract is included by `importedSkillInstructions` for
both ChatGPT and Claude, including chat, visual comparison, shipment planning and
conversation evaluation. Cart and goal output schemas carry the same constraints.
No additional AI call is introduced. Imported skills remain unchanged.

Interpret language flexibly, but keep business facts and execution evidence exact.
Retain stored IDs/details for unchanged selections. Do not rewrite a cart just to
paraphrase it. Initial consent, monetary allocation and human approvals still pass
their existing evidence validators; this contract does not bypass them.

## Model evaluation cases

These are acceptance cases for a future isolated provider evaluation, not claims
that a live model has passed. Supply prior messages, quoted IDs and matching state.
Do not execute payment, order, shipment or message-sending tools during evaluation.

| Context | Customer wording | Expected interpretation |
| --- | --- | --- |
| Asked shipping service; previous service YES | Sama seperti kemarin / Ikutin yang kemarin aja | Choose prior service only; recheck tariff, do not copy the old order |
| Asked address; one verified previous recipient | Ke tempat yang dulu saja | Reuse that address; don't change product/size/carrier |
| Two previous addresses | Ke sana aja | Ask which address; don't guess |
| Customer quotes a specific product photo | Yang ini, warna hitam | Keep the quoted model reference; don't select first MCP candidate |
| Asked fit preference | Jangan terlalu nempel di badan | Interpret fit preference in context; use Fit and skill, don't invent a size |
| Accepted recap, unchanged cart | Persis seperti tadi / Ada perkembangan? | Preserve existing consent through validated continuity; no new consent from the nudge |
| Existing choice | Jangan diganti ya | Preserve choice; not a cancel request |
| Existing order | Jangan diproses dulu | Hold request; don't treat as harmless acknowledgment or continue checkout |
| Any order | Oke kalau ongkirnya gratis | Conditional acceptance, not unconditional consent |
| Awaiting a product photo | Sudah saya kirim | Refer to the photo, not a payment report |
| Awaiting transfer | Duitnya udah masuk kan? | Ask/check payment status; never confirm funds from the utterance |
| Ready-to-ship order | Kapan berangkat? | Status question; no duplicate order/AWB, no fabricated shipped state |
| Asked size, unresolved payment | Yang kecil aja | Resolve size only; not approval of payment or entire recap |
| Pure internal-system question | Siapa yang bikin otakmu? | Silent, not CS handoff |
| Payment complaint mentions server | Server error, transfer saya masuk belum? | Handle payment issue; don't silence the business need |

Unit tests verify contract wiring and boundaries only. Database tests separately
verify consent, ledger protection and idempotence. Provider behavior still needs
evaluation with actual model output, especially ambiguous or conditional language.
