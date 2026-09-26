import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Akun AI yang sedang dipakai (banyak akun ChatGPT/Claude/Gemini). Tanpa konteks =
 * akun bawaan lama (folder login per workspace), jadi kode lama tetap berjalan.
 */
export type AiAccountRef = { id: number; provider: 'chatgpt' | 'claude' | 'gemini' }
const accounts = new AsyncLocalStorage<AiAccountRef>()
export const currentAiAccount = () => accounts.getStore()
export function withAiAccount<T>(account: AiAccountRef | null | undefined, action: () => T): T {
  return account ? accounts.run(account, action) : action()
}
/** Kunci login yang sedang berjalan: per workspace + per akun. */
export const aiAccountKey = (prefix: string) => {
  const account = currentAiAccount()
  return account ? `${prefix}#${account.id}` : prefix
}
