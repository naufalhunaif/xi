import { test } from '@japa/runner'
import encryption from '@adonisjs/core/services/encryption'
import { inWorkspace } from '#services/workspace_context'
import { readSharedMcpState, sharedPending } from '#services/shared_mcp_oauth_service'

test('encrypted MCP state is bound to workspace, slug and URL; never stores plaintext', ({
  assert,
}) => {
  const url = 'https://business.example/mcp'
  const secret = 'fixture-sensitive-token'
  const data = {
    url,
    redirect: 'https://workspace.example/callback',
    tokens: { access_token: secret, token_type: 'Bearer' },
  }
  const ciphertext = encryption.encrypt(data, undefined, `mcp:2:business:${url}`)
  assert.notInclude(ciphertext, secret)
  const row = { url, slug: 'business', shared_oauth: ciphertext }
  const scope = { id: 2, prefix: 'w2_', phone: null, version: 'fixture' }
  inWorkspace(scope, () => {
    assert.equal(readSharedMcpState(row)?.tokens?.access_token, secret)
    assert.isUndefined(readSharedMcpState({ ...row, slug: 'other' }))
    assert.isUndefined(readSharedMcpState({ ...row, url: 'https://other.example/mcp' }))
    assert.isUndefined(sharedPending(row))
  })
  inWorkspace({ ...scope, id: 3, prefix: 'w3_' }, () => assert.isUndefined(readSharedMcpState(row)))
})
