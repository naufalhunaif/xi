# Shared MCP OAuth

Business Data connections can now be authorized once per WhatsApp number and used
by both ChatGPT and Claude. AI account login remains separate. No API key is needed.

## Deploy with aaPanel

1. Pull the committed changes, then run `bash deploy/build.sh` from the
   repository root. If Node is missing from PATH, select the installed Node version
   or export `/www/server/nodejs/v24.21.0/bin` into PATH first.
2. Restart both WEB and WORKER. Database columns are added by the existing init model,
   not a migration. Keep the same APP_KEY on both processes and subsequent builds;
   encrypted MCP credentials depend on it. Keep APP_URL at the public HTTPS address.
3. Settings → Business Data → Connect → Login for each MCP once. Approve the
   `WhatsApp Workspace` client. Existing CLI credentials are not copied/deleted;
   the connect icon remains available for upgrading legacy connections.
4. Check the connected tooltip says it is shared by ChatGPT and Claude. Switch AI
   provider and check again. Selecting another WhatsApp number remains isolated.

Callbacks use `/whatsapp/oauth/mcp/callback/shared/<slug>` through the authenticated
WEB service. The existing `location ^~ /whatsapp/oauth/mcp/callback/` rule in
`deploy/nginx-rewrite.conf` covers this path and disables access logging of codes.
Keep that rule; never route this path directly to a CLI listener. No new port is needed.

## Fit discovery compatibility

For configured Fit URLs ending in `/fit/mcp`, a 404 on known OAuth metadata paths
is retried through `/fit/index.php/.well-known/...` on exactly the same origin.
The issuer, token endpoint and MCP resource audience are not rewritten.
This lets WhatsApp authorize Fit with the existing CI3 front controller. Other MCP
clients still need the Nginx discovery rules in `FIT-MCP-AAPANEL.md`.

## Credentials and boundaries

- Shared OAuth state is encrypted in each workspace's MCP connection row with an
  encryption purpose bound to number, slug and URL. WEB/WORKER refresh is serialized
  with a row lock. No model login is required to connect a business-data MCP.
- Callback validation checks browser session, one-time state, expiry, PKCE and issuer.
  A callback can only operate on the currently selected workspace.
- A successful token exchange is followed by MCP initialize and tools/list; no
  business tool is executed during authorization.
- Access tokens are refreshed before AI runs when near expiry. Each child receives
  scoped token environment variables; command arguments and Claude config contain
  variable names, not token values. Long-running turns that exceed the access-token
  lifetime may still fail; no business tool is automatically replayed.
- Remote OAuth requests require HTTPS, reject private addresses and pin DNS checks
  to the outgoing connection. Explicitly configured loopback servers are allowed
  for local XAMPP development. Credential-bearing redirects are rejected.
- Servers must support OAuth discovery, PKCE and dynamic client registration.
  Pre-registered-only OAuth clients are not configured by this change.

## Verification

Unit tests cover the shared flow, token refresh, encrypted isolation, replay and
issuer rejection, Fit-only fallback and secret-free runtime config. Browser tests
use fixtures (no real account login); HTTP tests use a loopback fixture. Production
Fit discovery was checked read-only. Live user consent and real provider tool calls
still require verification after deployment.
