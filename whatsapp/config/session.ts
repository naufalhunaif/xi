import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig, stores } from '@adonisjs/session'

/**
 * Session configuration.
 * Defines how user sessions are managed, stored, and secured.
 */
const sessionConfig = defineConfig({
  /**
   * Enable or disable session management globally.
   */
  enabled: true,

  /**
   * The name of the cookie used to store the session ID.
   */
  cookieName: 'whatsapp_session',

  /**
   * When set to true, the session id cookie will be deleted
   * once the user closes the browser.
   */
  clearWithBrowser: false,

  /**
   * Define how long to keep the session data alive without
   * any activity.
   */
  age: '2h',

  /**
   * Configuration for session cookie and the
   * cookie store
   */
  cookie: {
    /**
     * The path for which the cookie is valid.
     * The cookie is accessible for all routes when the value is '/'.
     */
    path: env.get('APP_BASE_PATH') || '/',

    /**
     * When true, the cookie is only accessible via HTTP(S) and not
     * by client-side JavaScript, helping prevent XSS attacks.
     */
    httpOnly: true,

    /**
     * When true, the cookie is only sent over HTTPS connections.
     * Enabled in production for security.
     */
    // Standalone bisa dibuka lewat http://IP:PORT dan https://domain sekaligus,
    // jadi cookie tidak dipaksa Secure di sana; bundle tetap Secure di produksi.
    secure:
      app.inProduction &&
      !(env.get('AUTH_MODE') === 'local' || !String(env.get('ACCOUNT_URL') || '').trim()),

    /**
     * Controls when cookies are sent with cross-site requests.
     * This setting provides reasonable security while allowing some cross-site
     * usage (value: 'lax').
     */
    sameSite: 'lax',
  },

  /**
   * The store to use. Make sure to validate the environment
   * variable in order to infer the store name without any
   * errors.
   */
  store: env.get('SESSION_DRIVER'),

  /**
   * List of configured stores. Refer documentation to see
   * list of available stores and their config.
   */
  stores: {
    /**
     * Cookie store saves session data in encrypted cookies.
     * Suitable for small session data that doesn't exceed cookie size limits.
     */
    cookie: stores.cookie(),
    /**
     * Database store persists sessions in the configured SQL database.
     */
    database: stores.database(),
  },
})

export default sessionConfig
