
const LIMIT = 8_000_000

export async function downloadOutgoingImage(url: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (
    !response.ok ||
    !/^image\/(jpeg|png|webp|gif|avif)(?:;|$)/i.test(response.headers.get('content-type') || '')
  )
    throw new Error('File gambar tidak tersedia.')
  if (Number(response.headers.get('content-length') || 0) > LIMIT) {
    await response.body?.cancel()
    throw new Error('Ukuran gambar terlalu besar.')
  }
  if (!response.body) throw new Error('File gambar kosong.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.length
      if (size > LIMIT) throw new Error('Ukuran gambar terlalu besar.')
      chunks.push(result.value)
    }
  } finally {
    await reader.cancel()
  }
  if (!size) throw new Error('File gambar kosong.')
  return Buffer.concat(chunks)
}
