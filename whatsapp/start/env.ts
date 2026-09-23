/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'
import { validateWorkspaceUrls } from '#services/workspace_urls'

const env = await Env.create(new URL('../', import.meta.url), {
  // Node
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  // App
  APP_KEY: Env.schema.secret(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),

  // Session
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory', 'database'] as const),
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),
  // Kosong = mode standalone (login lokal, tanpa bundle Account).
  ACCOUNT_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  AUTH_MODE: Env.schema.enum.optional(['local', 'oauth'] as const),
  // '' atau '/' = dipasang di akar domain.
  APP_BASE_PATH: Env.schema.string.optional(),
  CODEX_BIN: Env.schema.string.optional(),
  // Explicit beta opt-in. Unset preserves the existing production path.
  AI_COMPACT_REPLY_ENABLED: Env.schema.boolean.optional(),
  // Unset follows compact opt-in; false restores the single-model path.
  AI_ADAPTIVE_ROUTING_ENABLED: Env.schema.boolean.optional(),
  AI_CHATGPT_LIGHT_MODEL: Env.schema.string.optional(),
  AI_CHATGPT_LIGHT_REASONING: Env.schema.enum.optional([
    'auto',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ] as const),
  AI_CHATGPT_STANDARD_MODEL: Env.schema.string.optional(),
  AI_CHATGPT_STANDARD_REASONING: Env.schema.enum.optional([
    'auto',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ] as const),
  AI_CLAUDE_LIGHT_MODEL: Env.schema.string.optional(),
  AI_CLAUDE_LIGHT_REASONING: Env.schema.enum.optional([
    'auto',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ] as const),
  AI_CLAUDE_STANDARD_MODEL: Env.schema.string.optional(),
  AI_CLAUDE_STANDARD_REASONING: Env.schema.enum.optional([
    'auto',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ] as const),
  CLAUDE_BIN: Env.schema.string.optional(),
  MCP_OAUTH_CALLBACK_PORT: Env.schema.number.optional(),
})

if (env.get('NODE_ENV') === 'production') {
  validateWorkspaceUrls(env.get('APP_URL'), env.get('ACCOUNT_URL') || '', env.get('APP_BASE_PATH') || '')
}

export default env
