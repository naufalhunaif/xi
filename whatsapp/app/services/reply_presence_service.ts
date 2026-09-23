import type { WASocket, WAMessageKey } from '@whiskeysockets/baileys'

type PresenceSocket = Pick<WASocket, 'readMessages' | 'sendPresenceUpdate'>
const onlineStates = new WeakMap<PresenceSocket, { active: number; queue: Promise<void> }>()

/** Called only after a reply is ready, never during AI/tool processing or handoff. */
export async function sendPreparedReply<T>(
  socket: PresenceSocket,
  jid: string,
  keys: WAMessageKey[],
  send: () => Promise<T>,
  hooks: {
    canSend: () => Promise<boolean>
    read?: () => Promise<void>
    onRead?: () => Promise<void>
    onTyping?: () => Promise<void>
    onDone?: () => Promise<void>
    wait?: (ms: number) => Promise<void>
  }
): Promise<T | null> {
  if (!(await hooks.canSend())) return null
  const unread = keys.filter((key) => key.id && key.remoteJid === jid && !key.fromMe)
  if (hooks.read) await hooks.read()
  else if (unread.length) await socket.readMessages(unread)
  await hooks.onRead?.()

  let state = onlineStates.get(socket)
  if (!state) {
    state = { active: 0, queue: Promise.resolve() }
    onlineStates.set(socket, state)
  }
  const current = state
  const syncOnline = () => {
    current.queue = current.queue
      .catch(() => {})
      .then(() => socket.sendPresenceUpdate(current.active > 0 ? 'available' : 'unavailable'))
    return current.queue
  }
  current.active++
  try {
    await syncOnline()
    await socket.sendPresenceUpdate('composing', jid)
    await hooks.onTyping?.()
    // Brief delivery preparation so the typing state precedes the message on the wire.
    await (hooks.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(800)
    if (!(await hooks.canSend())) return null
    return await send()
  } finally {
    await socket.sendPresenceUpdate('paused', jid).catch(() => {})
    await hooks.onDone?.().catch(() => {})
    current.active--
    if (current.active === 0) await syncOnline().catch(() => {})
  }
}
