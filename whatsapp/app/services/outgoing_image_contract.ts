export type ImageIntent = { url: string; caption: string }

export const OUTGOING_IMAGES_SCHEMA = {
  type: 'array',
  maxItems: 4,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: { url: { type: 'string' }, caption: { type: 'string' } },
    required: ['url', 'caption'],
  },
  description:
    'Foto yang perlu dikirim ke pelanggan, bukan URL pada message/initiative. URL harus sumber gambar persis dari produk MCP terverifikasi atau media/cart room ini. Caption opsional berupa teks kosong; jangan ulangi message. Kosong jika tidak perlu gambar. Aplikasi mengirim file gambar langsung.',
}

export function parseOutgoingImages(value: unknown): ImageIntent[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    value.some(
      (row) =>
        !row ||
        typeof row.url !== 'string' ||
        !row.url.trim() ||
        row.url.length > 2000 ||
        typeof row.caption !== 'string' ||
        row.caption.length > 1024
    )
  )
    throw new Error('Lampiran gambar AI tidak valid.')
  return value.map((row) => ({ url: row.url.trim(), caption: row.caption.trim() }))
}
