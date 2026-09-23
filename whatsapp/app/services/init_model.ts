import db from '#services/workspace_database'

import { workspaceScope } from '#services/workspace_context'
import { LEAN_TABLE_STATEMENTS } from '#services/lean/lean_tables'
const initializations = new Map<string, Promise<void>>()

async function createTables() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS whatsapp_learning_state (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      revision CHAR(36) NOT NULL,
      active_version BIGINT UNSIGNED NULL,
      skill_id BIGINT UNSIGNED NULL,
      rules_json TEXT NOT NULL,
      next_run_at DATETIME NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_learning_versions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      rule_key VARCHAR(40) NOT NULL,
      status VARCHAR(30) NOT NULL,
      base_signature CHAR(64) NOT NULL,
      state_revision CHAR(36) NOT NULL,
      before_rules_json TEXT NOT NULL,
      after_rules_json TEXT NOT NULL,
      evidence_json MEDIUMTEXT NOT NULL,
      tests_json TEXT NULL,
      error VARCHAR(500) NULL,
      actor VARCHAR(190) NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY learning_candidate (rule_key,base_signature),
      KEY learning_status (status,updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_customer_memory (
      jid VARCHAR(190) NOT NULL, fact_key VARCHAR(64) NOT NULL, topic VARCHAR(30) NOT NULL,
      value TEXT NOT NULL, sources_json TEXT NOT NULL, source_id BIGINT UNSIGNED NOT NULL,
      anchor_id BIGINT UNSIGNED NOT NULL, updated_at DATETIME NOT NULL,
      PRIMARY KEY (jid, fact_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_evidence_cache (
      cache_key CHAR(64) NOT NULL PRIMARY KEY,
      result_json MEDIUMTEXT NOT NULL,
      stored_at BIGINT UNSIGNED NOT NULL,
      expires_at BIGINT UNSIGNED NOT NULL,
      KEY evidence_cache_expiry (expires_at), KEY evidence_cache_age (stored_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_chat_deletions (
      jid VARCHAR(190) NOT NULL PRIMARY KEY,
      cutoff DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_chat_cleanup (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      status VARCHAR(20) NOT NULL,
      cutoff DATETIME NOT NULL,
      files_json LONGTEXT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_skill_edits (
      id CHAR(36) NOT NULL PRIMARY KEY,
      actor VARCHAR(190) NOT NULL,
      instruction TEXT NOT NULL,
      status VARCHAR(20) NOT NULL,
      summary TEXT NULL,
      error_code VARCHAR(80) NULL,
      snapshot_json LONGTEXT NOT NULL,
      changes_json LONGTEXT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY skill_edits_status (status, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_skill_defaults (
      name VARCHAR(120) NOT NULL PRIMARY KEY, created_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_approval_wait_episodes (
      id CHAR(36) NOT NULL PRIMARY KEY,
      jid VARCHAR(190) NOT NULL,
      is_open TINYINT(1) NOT NULL DEFAULT 1,
      start_anchor_id BIGINT UNSIGNED NOT NULL,
      anchor_id BIGINT UNSIGNED NOT NULL,
      requests_json TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      message_id VARCHAR(190) NULL,
      due_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY approval_wait_room (jid,is_open), KEY approval_wait_due (status,due_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_payment_wait_notices (
      id CHAR(36) NOT NULL PRIMARY KEY,
      jid VARCHAR(190) NOT NULL,
      anchor_id BIGINT UNSIGNED NOT NULL,
      proof_message_id VARCHAR(190) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      message_id VARCHAR(190) NULL,
      due_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY payment_wait_due (status,due_at), KEY payment_wait_room (jid,status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_order_operations (
      order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      version CHAR(36) NOT NULL,
      data_json TEXT NOT NULL,
      group_jid VARCHAR(190) NULL,
      payment_trigger VARCHAR(20) NOT NULL DEFAULT 'first_payment',
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_order_shipping_jobs (
      order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      request_key CHAR(36) NOT NULL UNIQUE,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      progress_phase VARCHAR(40) NULL,
      agent_state_json TEXT NULL,
      rejected_attempt_ids_json TEXT NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      next_attempt_at DATETIME NOT NULL,
      lease_token CHAR(36) NULL,
      lease_until DATETIME NULL,
      create_started_at DATETIME NULL,
      external_id VARCHAR(190) NULL,
      tracking_number VARCHAR(190) NULL,
      last_error_code VARCHAR(80) NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY order_shipping_due (status,next_attempt_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_shipping_notices (
      order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      jid VARCHAR(190) NOT NULL,
      tracking_number VARCHAR(190) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      body TEXT NULL,
      message_id VARCHAR(190) NULL,
      claim_token CHAR(36) NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      next_attempt_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      KEY shipping_notice_due (status,next_attempt_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_order_operation_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      order_id BIGINT UNSIGNED NOT NULL,
      actor VARCHAR(190) NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      KEY order_operation_events (order_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_order_routing (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      version CHAR(36) NOT NULL,
      group_jid VARCHAR(190) NULL,
      payment_trigger VARCHAR(20) NOT NULL DEFAULT 'first_payment',
      refresh_requested TINYINT(1) NOT NULL DEFAULT 0,
      groups_updated_at DATETIME NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_order_groups (
      jid VARCHAR(190) NOT NULL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      available TINYINT(1) NOT NULL DEFAULT 1,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_order_group_jobs (
      order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      group_jid VARCHAR(190) NOT NULL,
      snapshot_json MEDIUMTEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      updated_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_order_group_parts (
      order_id BIGINT UNSIGNED NOT NULL,
      part_index INT UNSIGNED NOT NULL,
      message_id VARCHAR(64) NOT NULL UNIQUE,
      content_json TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      next_attempt_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      last_error VARCHAR(500) NULL,
      PRIMARY KEY (order_id,part_index),
      KEY order_group_due (status,next_attempt_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_production_policy (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      version VARCHAR(36) NOT NULL,
      policy_json TEXT NOT NULL,
      last_adjusted_at DATETIME NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_production_changes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      actor VARCHAR(20) NOT NULL,
      reason TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_production_signals (
      jid VARCHAR(190) NOT NULL,
      kind VARCHAR(20) NOT NULL,
      policy_version VARCHAR(36) NOT NULL,
      direction VARCHAR(20) NOT NULL,
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      PRIMARY KEY (jid,kind,policy_version),
      KEY production_signals_version (policy_version,kind,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_sync_retries (
      message_id VARCHAR(190) NOT NULL PRIMARY KEY,
      jid VARCHAR(190) NOT NULL,
      payload_json MEDIUMTEXT NOT NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 1,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      next_attempt_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY whatsapp_sync_retry_due (status,next_attempt_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_evaluation_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      jid VARCHAR(190) NOT NULL,
      anchor_id BIGINT UNSIGNED NOT NULL,
      event_id BIGINT UNSIGNED NOT NULL,
      skill_signature CHAR(64) NOT NULL,
      skills_json MEDIUMTEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      UNIQUE KEY whatsapp_evaluation_snapshot (jid,anchor_id,event_id,skill_signature)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_conversation_evaluations (
      jid VARCHAR(190) NOT NULL PRIMARY KEY,
      version CHAR(36) NOT NULL,
      anchor_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
      event_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
      skill_signature CHAR(64) NOT NULL DEFAULT '',
      skills_json MEDIUMTEXT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      result_json TEXT NULL,
      last_error VARCHAR(500) NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_customer_balance_entries (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      jid VARCHAR(190) NOT NULL,
      order_id BIGINT UNSIGNED NOT NULL,
      payment_id BIGINT UNSIGNED NULL UNIQUE,
      amount BIGINT NOT NULL,
      reason VARCHAR(30) NOT NULL,
      created_at DATETIME NOT NULL,
      KEY whatsapp_customer_balance_room (jid, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_payment_reviews (
      id CHAR(36) NOT NULL PRIMARY KEY,
      jid VARCHAR(190) NOT NULL,
      cart_version CHAR(36) NOT NULL,
      order_id BIGINT UNSIGNED NULL,
      order_paid BIGINT UNSIGNED NULL,
      proof_message_id VARCHAR(190) NOT NULL,
      proof_hash CHAR(64) NOT NULL,
      methods_signature TEXT NOT NULL,
      reading_json TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      KEY whatsapp_payment_reviews_room (jid, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_cart_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      jid VARCHAR(190) NOT NULL,
      action VARCHAR(30) NOT NULL,
      actor VARCHAR(190) NOT NULL,
      summary_json TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      KEY whatsapp_cart_events_room (jid, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_carts (
      jid VARCHAR(190) NOT NULL PRIMARY KEY,
      version CHAR(36) NOT NULL,
      items_json MEDIUMTEXT NOT NULL,
      recipient_json TEXT NOT NULL,
      shipping_json TEXT NOT NULL,
      note TEXT NOT NULL,
      payment_status VARCHAR(20) NOT NULL DEFAULT 'none',
      proof_message_id VARCHAR(190) NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      order_number VARCHAR(32) NULL,
      jid VARCHAR(190) NOT NULL,
      snapshot_json MEDIUMTEXT NOT NULL,
      total BIGINT UNSIGNED NOT NULL,
      paid BIGINT UNSIGNED NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY whatsapp_orders_room (jid, id),
      UNIQUE KEY whatsapp_orders_number_unique (order_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_order_payments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      order_id BIGINT UNSIGNED NOT NULL,
      request_key CHAR(36) NOT NULL UNIQUE,
      amount BIGINT UNSIGNED NOT NULL,
      method_id BIGINT UNSIGNED NOT NULL,
      method_json TEXT NOT NULL,
      reference VARCHAR(190) NULL,
      proof_message_id VARCHAR(190) NULL UNIQUE,
      confirmed_by VARCHAR(190) NOT NULL,
      created_at DATETIME NOT NULL,
      UNIQUE KEY whatsapp_payment_reference (method_id, reference),
      KEY whatsapp_order_payment_order (order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_ai_reviews (
      jid VARCHAR(190) NOT NULL PRIMARY KEY,
      version CHAR(36) NOT NULL,
      reason VARCHAR(30) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      requested_at DATETIME NOT NULL,
      KEY whatsapp_ai_reviews_pending (status, requested_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_payment_methods (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      destination VARCHAR(1000) NOT NULL,
      account_name VARCHAR(190) NOT NULL DEFAULT '',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_chat_goals (
      jid VARCHAR(190) NOT NULL PRIMARY KEY,
      version CHAR(36) NOT NULL,
      anchor_id BIGINT UNSIGNED NOT NULL,
      status VARCHAR(20) NOT NULL,
      objective TEXT NOT NULL,
      waiting_for TEXT NOT NULL,
      next_action TEXT NOT NULL,
      policy_json TEXT NULL,
      skill_hash CHAR(64) NULL,
      next_run_at DATETIME NULL,
      followup_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      last_followup_at DATETIME NULL,
      last_error TEXT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY whatsapp_chat_goals_due (status, next_run_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_ai_traces (
      id CHAR(36) NOT NULL PRIMARY KEY,
      jid VARCHAR(190) NOT NULL,
      message_id VARCHAR(190) NULL,
      status VARCHAR(20) NOT NULL,
      label VARCHAR(255) NULL,
      input_json MEDIUMTEXT NOT NULL,
      steps_json MEDIUMTEXT NOT NULL,
      decision_json TEXT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY whatsapp_ai_traces_room_index (jid, created_at),
      KEY whatsapp_ai_traces_message_index (message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_ai_usage (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      provider VARCHAR(20) NOT NULL,
      phase VARCHAR(40) NULL,
      model VARCHAR(120) NULL,
      status VARCHAR(20) NOT NULL,
      input_tokens BIGINT UNSIGNED NULL,
      output_tokens BIGINT UNSIGNED NULL,
      cached_tokens BIGINT UNSIGNED NULL,
      cache_write_tokens BIGINT UNSIGNED NULL,
      duration_ms INT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL,
      KEY whatsapp_ai_usage_created_index (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_ai_quota (
      provider VARCHAR(20) NOT NULL PRIMARY KEY,
      generation CHAR(36) NOT NULL,
      windows_json TEXT NOT NULL,
      checked_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
      failed TINYINT(1) NOT NULL DEFAULT 0,
      limited_until BIGINT UNSIGNED NULL,
      limited_code VARCHAR(64) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS account_identity (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      owner_handle VARCHAR(64) NOT NULL,
      issuer VARCHAR(1000) NOT NULL,
      verified_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS wa_users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(190) NOT NULL UNIQUE,
      name VARCHAR(120) NOT NULL DEFAULT '',
      password_hash VARCHAR(255) NOT NULL,
      last_login_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_settings (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      ai_enabled TINYINT(1) NOT NULL DEFAULT 0,
      mcp_seeded TINYINT(1) NOT NULL DEFAULT 0,
      skill_name VARCHAR(120) NULL,
      skill_content MEDIUMTEXT NULL,
      ai_provider VARCHAR(20) NOT NULL DEFAULT 'chatgpt',
      chatgpt_model VARCHAR(120) NULL,
      chatgpt_speed VARCHAR(20) NOT NULL DEFAULT 'auto',
      codex_bin VARCHAR(500) NULL,
      claude_model VARCHAR(120) NULL,
      claude_speed VARCHAR(20) NOT NULL DEFAULT 'auto',
      claude_bin VARCHAR(500) NULL,
      turn_window_ms INT UNSIGNED NOT NULL DEFAULT 6000,
      history_limit SMALLINT UNSIGNED NOT NULL DEFAULT 60,
      sweep_enabled TINYINT(1) NOT NULL DEFAULT 1,
      sweep_max_age_hours SMALLINT UNSIGNED NOT NULL DEFAULT 48,
      sweep_batch SMALLINT UNSIGNED NOT NULL DEFAULT 10,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_mcp_connections (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(64) NOT NULL,
      name VARCHAR(120) NOT NULL,
      url VARCHAR(1000) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      oauth_authenticated TINYINT(1) NOT NULL DEFAULT 0,
      chatgpt_authenticated TINYINT(1) NOT NULL DEFAULT 0,
      claude_authenticated TINYINT(1) NOT NULL DEFAULT 0,
      shared_authenticated TINYINT(1) NOT NULL DEFAULT 0,
      shared_oauth LONGTEXT NULL,
      last_error VARCHAR(1000) NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE KEY whatsapp_mcp_connections_slug_unique (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_skills (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      description TEXT NULL,
      content LONGTEXT NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE KEY whatsapp_skills_name_unique (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_connection (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      desired_connected TINYINT(1) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'disconnected',
      phone VARCHAR(80) NULL,
      qr_data_url LONGTEXT NULL,
      last_error TEXT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      message_id VARCHAR(190) NOT NULL,
      jid VARCHAR(190) NOT NULL,
      contact_name VARCHAR(190) NULL,
      direction ENUM('in','out') NOT NULL,
      sender_type VARCHAR(20) NOT NULL DEFAULT 'customer',
      body TEXT NOT NULL,
      media_type VARCHAR(20) NULL,
      media_url VARCHAR(1000) NULL,
      thumbnail_url VARCHAR(1000) NULL,
      media_mime VARCHAR(120) NULL,
      media_status VARCHAR(30) NULL,
      reply_to_message_id VARCHAR(190) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'received',
      created_at DATETIME NOT NULL,
      UNIQUE KEY whatsapp_messages_message_id_unique (message_id),
      KEY whatsapp_messages_jid_index (jid),
      KEY whatsapp_messages_created_at_index (created_at),
      KEY whatsapp_messages_jid_created_at_index (jid, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS baileys_auth (
      category VARCHAR(80) NOT NULL,
      auth_key VARCHAR(255) NOT NULL,
      payload LONGTEXT NOT NULL,
      PRIMARY KEY (category, auth_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_contacts (
      jid VARCHAR(190) NOT NULL PRIMARY KEY,
      name VARCHAR(190) NULL,
      profile_picture_url VARCHAR(1000) NULL,
      activity VARCHAR(40) NULL,
      activity_updated_at DATETIME NULL,
      handling_mode VARCHAR(20) NOT NULL DEFAULT 'ai',
      handoff_reason TEXT NULL,
      handoff_at DATETIME NULL,
      chat_note TEXT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_reactions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      target_message_id VARCHAR(190) NOT NULL,
      jid VARCHAR(190) NOT NULL,
      sender VARCHAR(190) NOT NULL,
      emoji VARCHAR(32) NOT NULL,
      from_me TINYINT(1) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'received',
      created_at DATETIME NOT NULL,
      UNIQUE KEY whatsapp_reactions_target_sender_unique (target_message_id, sender),
      KEY whatsapp_reactions_jid_index (jid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ]

  for (const statement of statements) await db.rawQuery(statement)
  for (const statement of LEAN_TABLE_STATEMENTS) await db.rawQuery(statement)
  // Beta 2: jalur balas ramping aktif secara bawaan; jalur lama tetap ada bila dimatikan.
  await db.rawQuery(
    'ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS lean_mode TINYINT(1) NOT NULL DEFAULT 1'
  )
  await db.rawQuery(
    'ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS beta3_mode TINYINT(1) NOT NULL DEFAULT 0'
  )
  await db.rawQuery(
    'ALTER TABLE whatsapp_chat_cleanup ADD COLUMN IF NOT EXISTS target_jids_json TEXT NULL'
  )
  await db.rawQuery(
    'ALTER TABLE whatsapp_chat_cleanup ADD COLUMN IF NOT EXISTS history_cutoff DATETIME NULL'
  )
  await db.rawQuery(
    'ALTER TABLE whatsapp_chat_cleanup ADD COLUMN IF NOT EXISTS request_id CHAR(36) NULL'
  )
  await db.rawQuery(
    "ALTER TABLE whatsapp_chat_cleanup ADD COLUMN IF NOT EXISTS mode VARCHAR(20) NOT NULL DEFAULT 'chat'"
  )
  await db.rawQuery('ALTER TABLE whatsapp_order_payments MODIFY COLUMN reference VARCHAR(190) NULL')
  await db.rawQuery(
    'ALTER TABLE whatsapp_order_payments ADD COLUMN IF NOT EXISTS proof_hash CHAR(64) NULL UNIQUE'
  )
  await db.rawQuery(
    'ALTER TABLE whatsapp_payment_reviews ADD COLUMN IF NOT EXISTS payment_quote_json TEXT NULL'
  )
  await db.rawQuery(
    'ALTER TABLE whatsapp_order_shipping_jobs ADD COLUMN IF NOT EXISTS progress_phase VARCHAR(40) NULL'
  )
  await db.rawQuery(
    'ALTER TABLE whatsapp_order_shipping_jobs ADD COLUMN IF NOT EXISTS agent_state_json TEXT NULL'
  )
  await db.rawQuery(
    'ALTER TABLE whatsapp_order_shipping_jobs ADD COLUMN IF NOT EXISTS rejected_attempt_ids_json TEXT NULL'
  )
  // Existing XAMPP tables may have been created with TIMESTAMP ON UPDATE.
  // Read/delivery/media updates must never rewrite the original message time.
  const [messageTimeColumns] = await db.rawQuery(
    "SHOW COLUMNS FROM whatsapp_messages LIKE 'created_at'"
  )
  if (
    String(messageTimeColumns[0]?.Extra || '')
      .toLowerCase()
      .includes('on update')
  ) {
    await db.rawQuery('ALTER TABLE whatsapp_messages MODIFY COLUMN created_at DATETIME NOT NULL')
  }
  await db.rawQuery(
    `ALTER TABLE whatsapp_customer_balance_entries MODIFY COLUMN payment_id BIGINT UNSIGNED NULL`
  )
  await db.rawQuery(
    `ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS balance_applied BIGINT UNSIGNED NOT NULL DEFAULT 0`
  )
  // Existing orders keep NULL and their original WA reference. Only new inserts receive INV.
  await db.rawQuery(
    `ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS order_number VARCHAR(32) NULL`
  )
  const [orderIndexes] = await db.rawQuery('SHOW INDEX FROM whatsapp_orders')
  if (
    !orderIndexes.some((index: any) =>
      String(index.Key_name).endsWith('whatsapp_orders_number_unique')
    )
  ) {
    try {
      await db.rawQuery(
        'ALTER TABLE whatsapp_orders ADD UNIQUE KEY whatsapp_orders_number_unique (order_number)'
      )
    } catch (error) {
      // WEB and WORKER may initialize the same workspace concurrently.
      if ((error as { code?: string }).code !== 'ER_DUP_KEYNAME') throw error
    }
  }

  await db.rawQuery(`ALTER TABLE whatsapp_connection
    ADD COLUMN IF NOT EXISTS worker_id CHAR(36) NULL,
    ADD COLUMN IF NOT EXISTS worker_heartbeat_at DATETIME NULL`)

  await db.rawQuery(`ALTER TABLE whatsapp_contacts
    ADD COLUMN IF NOT EXISTS workspace_read_id BIGINT UNSIGNED NOT NULL DEFAULT 0`)
  await db.rawQuery(`ALTER TABLE whatsapp_contacts
    ADD COLUMN IF NOT EXISTS ai_excluded TINYINT(1) NOT NULL DEFAULT 0`)
  await db.rawQuery(`ALTER TABLE whatsapp_contacts
    ADD COLUMN IF NOT EXISTS phone_jid VARCHAR(190) NULL,
    ADD COLUMN IF NOT EXISTS phone_resolved_at DATETIME NULL`)
  await db.rawQuery(`ALTER TABLE whatsapp_carts
    ADD COLUMN IF NOT EXISTS discount_json TEXT NULL`)

  await db.rawQuery(
    `ALTER TABLE whatsapp_mcp_connections
      ADD COLUMN IF NOT EXISTS chatgpt_authenticated TINYINT(1) NOT NULL DEFAULT 0 AFTER oauth_authenticated,
      ADD COLUMN IF NOT EXISTS claude_authenticated TINYINT(1) NOT NULL DEFAULT 0 AFTER chatgpt_authenticated,
      ADD COLUMN IF NOT EXISTS shared_authenticated TINYINT(1) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS shared_oauth LONGTEXT NULL`
  )
  await db.rawQuery(
    `UPDATE whatsapp_mcp_connections
     SET chatgpt_authenticated = oauth_authenticated
     WHERE oauth_authenticated = 1 AND chatgpt_authenticated = 0`
  )
  await db.rawQuery(
    `ALTER TABLE whatsapp_ai_usage
      ADD COLUMN IF NOT EXISTS phase VARCHAR(40) NULL AFTER provider,
      ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT UNSIGNED NULL AFTER cached_tokens`
  )
  await db.rawQuery(
    `ALTER TABLE whatsapp_ai_quota
      ADD COLUMN IF NOT EXISTS limited_until BIGINT UNSIGNED NULL,
      ADD COLUMN IF NOT EXISTS limited_code VARCHAR(64) NULL`
  )
  await db.rawQuery(
    `ALTER TABLE whatsapp_settings
      ADD COLUMN IF NOT EXISTS ai_failover TINYINT(1) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS ai_work_mode VARCHAR(16) NOT NULL DEFAULT 'always',
      ADD COLUMN IF NOT EXISTS ai_work_timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Jakarta',
      ADD COLUMN IF NOT EXISTS ai_work_days VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5,6,7',
      ADD COLUMN IF NOT EXISTS ai_work_start VARCHAR(5) NOT NULL DEFAULT '09:00',
      ADD COLUMN IF NOT EXISTS ai_work_end VARCHAR(5) NOT NULL DEFAULT '17:00',
      ADD COLUMN IF NOT EXISTS mcp_seeded TINYINT(1) NOT NULL DEFAULT 0 AFTER ai_enabled,
      ADD COLUMN IF NOT EXISTS skill_name VARCHAR(120) NULL AFTER ai_enabled,
      ADD COLUMN IF NOT EXISTS skill_content MEDIUMTEXT NULL AFTER skill_name`
  )
  await db.rawQuery(`ALTER TABLE whatsapp_skills MODIFY COLUMN description TEXT NULL`)
  await db.rawQuery(
    `ALTER TABLE whatsapp_contacts
      ADD COLUMN IF NOT EXISTS activity VARCHAR(40) NULL AFTER profile_picture_url,
      ADD COLUMN IF NOT EXISTS activity_updated_at DATETIME NULL AFTER activity,
      ADD COLUMN IF NOT EXISTS handling_mode VARCHAR(20) NOT NULL DEFAULT 'ai' AFTER activity_updated_at,
      ADD COLUMN IF NOT EXISTS handoff_reason TEXT NULL AFTER handling_mode,
      ADD COLUMN IF NOT EXISTS handoff_at DATETIME NULL AFTER handoff_reason`
  )
  await db.rawQuery(
    `ALTER TABLE whatsapp_messages
      ADD COLUMN IF NOT EXISTS sender_type VARCHAR(20) NULL AFTER direction,
      ADD COLUMN IF NOT EXISTS media_type VARCHAR(20) NULL AFTER body,
      ADD COLUMN IF NOT EXISTS media_url VARCHAR(1000) NULL AFTER media_type,
      ADD COLUMN IF NOT EXISTS thumbnail_url VARCHAR(1000) NULL AFTER media_url,
      ADD COLUMN IF NOT EXISTS media_mime VARCHAR(120) NULL AFTER thumbnail_url,
      ADD COLUMN IF NOT EXISTS media_status VARCHAR(30) NULL AFTER media_mime,
      ADD COLUMN IF NOT EXISTS media_upload_id CHAR(36) NULL,
      ADD COLUMN IF NOT EXISTS media_name VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS media_size INT UNSIGNED NULL,
      ADD COLUMN IF NOT EXISTS reply_to_message_id VARCHAR(190) NULL AFTER media_status`
  )
  await db.rawQuery(
    `ALTER TABLE whatsapp_contacts
      ADD COLUMN IF NOT EXISTS chat_note TEXT NULL AFTER handoff_at`
  )
  await db.rawQuery(
    `ALTER TABLE whatsapp_chat_goals
      ADD COLUMN IF NOT EXISTS analyzed_anchor_id BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER anchor_id,
      ADD COLUMN IF NOT EXISTS recovery_json TEXT NULL,
      ADD COLUMN IF NOT EXISTS level_state_json TEXT NULL`
  )
  // Upgrade existing successful decisions without paying for another model run.
  await db.rawQuery(
    `UPDATE whatsapp_chat_goals SET analyzed_anchor_id=anchor_id
      WHERE analyzed_anchor_id=0 AND status IN
        ('waiting','waiting_answer','waiting_reply','waiting_payment','waiting_approval','completed')`
  )
  await db.rawQuery(
    `ALTER TABLE whatsapp_settings
      ADD COLUMN IF NOT EXISTS ai_provider VARCHAR(20) NOT NULL DEFAULT 'chatgpt' AFTER skill_content,
      ADD COLUMN IF NOT EXISTS chatgpt_model VARCHAR(120) NULL AFTER ai_provider,
      ADD COLUMN IF NOT EXISTS chatgpt_speed VARCHAR(20) NOT NULL DEFAULT 'auto' AFTER chatgpt_model,
      ADD COLUMN IF NOT EXISTS chatgpt_reasoning VARCHAR(20) NULL AFTER chatgpt_speed,
      ADD COLUMN IF NOT EXISTS codex_bin VARCHAR(500) NULL AFTER chatgpt_speed,
      ADD COLUMN IF NOT EXISTS claude_model VARCHAR(120) NULL AFTER codex_bin,
      ADD COLUMN IF NOT EXISTS claude_speed VARCHAR(20) NOT NULL DEFAULT 'auto' AFTER claude_model,
      ADD COLUMN IF NOT EXISTS claude_reasoning VARCHAR(20) NULL AFTER claude_speed,
      ADD COLUMN IF NOT EXISTS claude_bin VARCHAR(500) NULL AFTER claude_speed,
      ADD COLUMN IF NOT EXISTS turn_window_ms INT UNSIGNED NOT NULL DEFAULT 6000 AFTER claude_bin,
      ADD COLUMN IF NOT EXISTS history_limit SMALLINT UNSIGNED NOT NULL DEFAULT 60 AFTER turn_window_ms,
      ADD COLUMN IF NOT EXISTS sweep_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER history_limit,
      ADD COLUMN IF NOT EXISTS sweep_max_age_hours SMALLINT UNSIGNED NOT NULL DEFAULT 48 AFTER sweep_enabled,
      ADD COLUMN IF NOT EXISTS sweep_batch SMALLINT UNSIGNED NOT NULL DEFAULT 10 AFTER sweep_max_age_hours`
  )
  await db.rawQuery(
    `UPDATE whatsapp_messages
     SET sender_type = CASE WHEN direction = 'in' THEN 'customer' ELSE 'cs' END
     WHERE sender_type IS NULL`
  )
  await db.rawQuery(
    `ALTER TABLE whatsapp_messages
     MODIFY COLUMN sender_type VARCHAR(20) NOT NULL DEFAULT 'customer'`
  )
  await db.rawQuery(
    `UPDATE whatsapp_settings SET ai_enabled = 0
     WHERE (skill_content IS NULL OR skill_content = '')
       AND NOT EXISTS (SELECT 1 FROM whatsapp_skills)`
  )
  await db.rawQuery(
    `INSERT IGNORE INTO whatsapp_skills (name, description, content, created_at, updated_at)
     SELECT skill_name, NULL, skill_content, updated_at, updated_at
     FROM whatsapp_settings
     WHERE skill_name IS NOT NULL AND skill_name <> ''
       AND skill_content IS NOT NULL AND skill_content <> ''`
  )
  await db.rawQuery(
    `UPDATE whatsapp_settings SET skill_name = NULL, skill_content = NULL
     WHERE skill_name IS NOT NULL OR skill_content IS NOT NULL`
  )
  // One-time legacy conversion. Old Speed values were reasoning, never service tiers.
  for (const provider of ['chatgpt', 'claude']) {
    await db.rawQuery(
      `UPDATE whatsapp_settings SET ${provider}_reasoning = CASE WHEN ${provider}_speed IN ('low','medium','high') THEN ${provider}_speed ELSE 'auto' END, ${provider}_speed = 'standard' WHERE ${provider}_reasoning IS NULL`
    )
  }
  // Narrow order evidence survives chat deletion, but is never part of the inbox.
  await db.rawQuery(
    'CREATE TABLE IF NOT EXISTS whatsapp_order_message_evidence LIKE whatsapp_messages'
  )
}

export function initializeDatabase() {
  const key = workspaceScope().prefix
  let initialization = initializations.get(key)
  if (!initialization) {
    initialization = createTables().catch((error) => {
      initializations.delete(key)
      throw error
    })
    initializations.set(key, initialization)
  }
  return initialization
}
