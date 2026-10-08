// v3.6.60 — Diskon grosir: mulai 6 jas (setelan = jas + celana, dihitung jas). Bila syarat terpenuhi,
// jas, setelan, celana, dan rompi di pesanan mendapat potongan per pcs dari website (Admin → Invoice →
// Diskon grosir), dan total otomatis memuat baris potongannya. Celana/rompi tanpa jas: tanpa potongan.

/** v3.6.60 — grosir berlaku mulai 6 jas; setelan (jas + celana) dihitung jas. */
export const WHOLESALE_MIN_JAS = 6
const WHOLESALE_KEYS: Record<string, string> = { jas: 'jas', suits: 'jas', setelan: 'setelan', celana: 'celana', pants: 'celana', rompi: 'rompi', vest: 'rompi' }

/** Potongan per pcs dari teks DISKON GROSIR ("Celana 10.000, Setelan 25.000, Jas 15.000, Rompi 5.000"). */
export function wholesaleDiscounts(text: string) {
  const out: Record<string, number> = {}
  const pattern = /\b(jas|suits|setelan|celana|pants|rompi|vest)\s*:?\s*(?:rp\.?\s*)?(\d{1,3}(?:\.\d{3})+|\d{4,6})(?!\d)/gi
  for (const match of String(text || '').matchAll(pattern)) {
    const key = WHOLESALE_KEYS[match[1].toLowerCase()]
    const value = Number(match[2].replace(/\./g, ''))
    if (key && value > 0 && !(key in out)) out[key] = value
  }
  return out
}

/** Kategori katalog → kelompok grosir (jas / setelan / celana / rompi), selain itu kosong. */
export function wholesaleGroup(category: string, product = '') {
  const text = `${category} ${product}`.toLowerCase()
  if (/\bsetelan\b/.test(category.toLowerCase()) || /^setelan\b/i.test(product)) return 'setelan'
  if (/\b(suits?|jas)\b/.test(category.toLowerCase())) return 'jas'
  if (/\b(pants|celana)\b/.test(category.toLowerCase())) return 'celana'
  if (/\b(vest|rompi)\b/.test(category.toLowerCase())) return 'rompi'
  return /\b(tuxedo|beskap|blazer)\b/.test(text) ? 'jas' : ''
}

/** Jas (termasuk setelan) ≥ 6 → potongan per pcs untuk jas, setelan, celana, rompi. */
export function wholesaleDiscount(lines: Array<{ group: string; qty: number }>, discounts: Record<string, number>) {
  const jas = lines.filter((line) => line.group === 'jas' || line.group === 'setelan').reduce((total, line) => total + line.qty, 0)
  if (jas < WHOLESALE_MIN_JAS) return { jas, discount: 0 }
  const discount = lines.reduce((total, line) => total + (discounts[line.group] || 0) * line.qty, 0)
  return { jas, discount }
}

const RULE_ORDER: Array<[string, string]> = [['jas', 'Jas'], ['setelan', 'Setelan'], ['celana', 'Celana'], ['rompi', 'Rompi']]

/** Kalimat DISKON GROSIR untuk bagian TOKO di prompt. Tidak ada potongan jas/setelan/celana/rompi → ''. */
export function renderWholesaleRule(discounts: Record<string, number>) {
  const list = RULE_ORDER.filter(([key]) => discounts[key] > 0)
    .map(([key, word]) => `${word} ${discounts[key].toLocaleString('id-ID')}`)
    .join(', ')
  if (!list) return ''
  return `DISKON GROSIR mulai ${WHOLESALE_MIN_JAS} jas (setelan dihitung jas; celana & rompi ikut dipotong bila jasnya sudah ${WHOLESALE_MIN_JAS}): potongan per pcs dari harga KATALOG — ${list}. Kurang dari ${WHOLESALE_MIN_JAS} jas tanpa potongan. Ditanya potongan → sebut besarnya per pcs. Total dengan potongan dihitung & dikirim sistem.`
}
