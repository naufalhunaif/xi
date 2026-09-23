# Owner-directed skill updates

Settings → Skills includes an instruction field and an explicit **Update with AI** action.
It uses the selected ChatGPT/Claude OAuth runtime; it does not enable automatic chat replies.
Requests about style/format are instructions to edit skill text, not changes to order accounting.

- Authenticated, CSRF-protected POST starts a per-number request with an idempotency UUID.
- WEB runs the AI task outside the HTTP request and database transaction; the UI polls its status.
- No MCP connections or customer messages are supplied. The existing restricted provider runtime is used.
- Updates replace a unique exact passage or append a rule; new skills are permitted without frontmatter.
- The current skill snapshot must still match before commit. Workspace changes, concurrent edits,
  expired requests, invalid patches and provider failures leave the existing skill set unchanged.
- Snapshot, owner instruction, actor and before/after changes are stored in `whatsapp_skill_edits`
  within the active workspace prefix. This is audit storage, not a public history endpoint.
- A request expires after 15 minutes. A WEB restart does not silently replay the AI call; an
  interrupted request expires and can be submitted again. Late results cannot overwrite newer skills.
- No chat sweep is triggered just by editing a skill. Subsequent AI turns use the updated skills.

Verification (all AI/network responses are fixtures):

```sh
node scripts/test_cart_discount_database.mjs --skill-edits
node ace test unit --files=tests/unit/skill_edit.spec.ts
node --test tests/skill_editor_ui.test.mjs
```

The database script only creates/drops a random local fixture schema, never the application database.
