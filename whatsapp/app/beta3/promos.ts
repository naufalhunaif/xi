// v3.6.120 — Promo website untuk chat. Hanya PROMO BIASA (bukan acak) yang berlaku untuk pesanan lewat
// WhatsApp/Instagram; promo acak dan voucher hanya lewat checkout website. Tidak ada promo biasa yang
// sedang berlaku = tidak ada promo lewat chat. Data dari catalog_digest website (`promos`), disimpan
// apa adanya; yang berlaku dihitung saat membalas (promo yang sudah lewat tidak pernah disebut).

export type ChatPromo = {
  name: string
  scope: 'all' | 'category' | 'products'
  category: string
  products: Array<{ product: string; color: string }>
  discountType: 'percentage' | 'fixed'
  discountValue: number
  minimumSpend: number
  startsAt: string
  endsAt: string
}

export type PromoState = { promos: ChatPromo[]; webOnly: { random: number; vouchers: number } }

const fold = (value: unknown) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Data `promos` dari website → disimpan sebagai JSON (state 'promos'). */
export function normalizePromos(raw: any): PromoState {
  const items = Array.isArray(raw?.items) ? raw.items : []
  const promos: ChatPromo[] = items
    .map((item: any) => ({
      name: String(item?.name || 'Promo').slice(0, 100),
      scope: item?.scope === 'category' ? 'category' : item?.scope === 'products' || item?.scope === 'collection' ? 'products' : 'all',
      category: String(item?.category || ''),
      products: (Array.isArray(item?.products) ? item.products : [])
        .map((row: any) => ({ product: String(row?.product || ''), color: String(row?.color || '') }))
        .filter((row: { product: string }) => row.product),
      discountType: item?.discount_type === 'fixed' ? 'fixed' : 'percentage',
      discountValue: Math.max(0, Number(item?.discount_value) || 0),
      minimumSpend: Math.max(0, Number(item?.minimum_spend) || 0),
      startsAt: String(item?.starts_at || ''),
      endsAt: String(item?.ends_at || ''),
    }))
    .filter((promo: ChatPromo) => promo.discountValue > 0 && promo.endsAt)
  return {
    promos,
    webOnly: { random: Number(raw?.web_only?.random) || 0, vouchers: Number(raw?.web_only?.vouchers) || 0 },
  }
}

export function parsePromoState(text: string | null | undefined): PromoState {
  try {
    const data = JSON.parse(String(text || ''))
    return { promos: Array.isArray(data?.promos) ? data.promos : [], webOnly: data?.webOnly || { random: 0, vouchers: 0 } }
  } catch {
    return { promos: [], webOnly: { random: 0, vouchers: 0 } }
  }
}

/** Waktu Jakarta "YYYY-MM-DD HH:mm:ss" (format kolom promo website). */
export function jakartaStamp(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}`
}

/** Promo biasa yang berlaku sekarang. */
export function activePromos(state: PromoState, now = new Date()) {
  const stamp = jakartaStamp(now)
  return state.promos.filter((promo) => (!promo.startsAt || promo.startsAt <= stamp) && promo.endsAt >= stamp)
}

/** Promo berlaku untuk varian katalog ini? */
export function promoApplies(promo: ChatPromo, row: { product: string; color?: string; category?: string }) {
  if (promo.scope === 'all') return true
  if (promo.scope === 'category') return Boolean(promo.category) && fold(promo.category) === fold(row.category)
  return promo.products.some(
    (item) => fold(item.product) === fold(row.product) && (!item.color || fold(item.color) === fold(row.color))
  )
}

/** Potongan per pcs (sama seperti website: persen dari harga, maksimal harga). */
export function promoCut(promo: ChatPromo, price: number) {
  const base = Math.max(0, Number(price) || 0)
  const cut = promo.discountType === 'fixed' ? promo.discountValue : (base * Math.min(100, promo.discountValue)) / 100
  return Math.round(Math.min(base, Math.max(0, cut)))
}

/** Promo terbaik untuk satu varian (seperti website: potongan terbesar). Min belanja dicek bila subtotal diberi. */
export function bestPromo(promos: ChatPromo[], row: { product: string; color?: string; category?: string }, price: number, subtotal?: number) {
  let best: { promo: ChatPromo; cut: number } | null = null
  for (const promo of promos) {
    if (!promoApplies(promo, row)) continue
    if (subtotal !== undefined && promo.minimumSpend > subtotal) continue
    const cut = promoCut(promo, price)
    if (cut > 0 && (!best || cut > best.cut)) best = { promo, cut }
  }
  return best
}

const rupiah = (value: number) => `Rp${Math.round(value).toLocaleString('id-ID')}`
const until = (stamp: string) => {
  const [date, time] = stamp.split(' ')
  const [, m, d] = date.split('-').map(Number)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'][(m || 1) - 1]
  return `${d} ${month} ${String(time || '').slice(0, 5)} WIB`.trim()
}

/**
 * v3.6.128 — Daftar "harga katalog → harga promo" yang sudah dihitung (AI pernah salah hitung 7%: 450.450).
 * Harga ukuran besar (XXL-3XL di catatan) ikut. Maks 16 harga terbanyak.
 */
export function promoPriceTable(
  promos: ChatPromo[],
  rows: Array<{ product: string; color: string; category?: string; price: number | null; note?: string }>
) {
  return promos
    .map((promo) => {
      const prices = new Map<number, number>()
      for (const row of rows) {
        if (!row.price || !promoApplies(promo, row)) continue
        const big = Number(String(row.note || '').match(/XXL(?:-\d?X*L)?\s+([\d.]{5,})/i)?.[1]?.replace(/\./g, '') || 0)
        for (const value of [Number(row.price), big]) if (value > 0) prices.set(value, (prices.get(value) || 0) + 1)
      }
      const list = [...prices.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([price]) => price)
        .sort((a, b) => a - b)
        .map((price) => `${price.toLocaleString('id-ID')} → ${(price - promoCut(promo, price)).toLocaleString('id-ID')}`)
      return list.length ? `Harga ${promo.name} (sudah dihitung, pakai angka ini, jangan menghitung sendiri): ${list.join('; ')}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Bagian PROMO untuk prompt. Selalu ada: tanpa promo biasa = tidak ada promo lewat chat. */
export function renderPromoRule(
  state: PromoState,
  now = new Date(),
  rows: Array<{ product: string; color: string; category?: string; price: number | null; note?: string }> = []
) {
  const active = activePromos(state, now)
  const webOnly = state.webOnly.random + state.webOnly.vouchers > 0
  if (!active.length)
    return `PROMO: tidak ada promo untuk pesanan lewat chat sekarang — jangan menawarkan/mengarang promo atau diskon.${webOnly ? ' Promo acak/voucher yang ada hanya berlaku saat checkout di website.' : ''}`
  const lines = active.slice(0, 6).map((promo) => {
    const cut = promo.discountType === 'fixed' ? `potongan ${rupiah(promo.discountValue)}/pcs` : `diskon ${promo.discountValue}%`
    const target =
      promo.scope === 'all'
        ? 'semua produk'
        : promo.scope === 'category'
          ? `kategori ${promo.category}`
          : promo.products.slice(0, 12).map((item) => [item.product, item.color].filter(Boolean).join(' - ')).join(', ')
    const min = promo.minimumSpend > 0 ? `, min belanja ${rupiah(promo.minimumSpend)}` : ''
    return `- ${promo.name}: ${cut} untuk ${target}${min}, sampai ${until(promo.endsAt)}`
  })
  return [
    'PROMO yang berlaku juga untuk pesanan lewat chat (harga promo = harga KATALOG dikurangi potongan; total otomatis sudah memotongnya). Selain ini tidak ada promo lewat chat:',
    ...lines,
    promoPriceTable(active, rows),
    webOnly ? 'Promo acak/voucher lain hanya saat checkout di website.' : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Baris katalog + salinan berharga promo (untuk pemeriksa harga): harga promo yang disebut AI sah. Varian tanpa
 * promo tidak bertambah. Harga size besar (catatan) ikut dipotong.
 */
export function withPromoPrices<T extends { product: string; color: string; category?: string; price: number | null; note: string }>(
  rows: T[],
  promos: ChatPromo[]
): T[] {
  if (!promos.length) return rows
  const extra: T[] = []
  for (const row of rows) {
    if (!row.price) continue
    const best = bestPromo(promos, row, Number(row.price))
    if (!best) continue
    const note = String(row.note || '').replace(/(XXL(?:-\d?X*L)?\s+)([\d.]{5,})/i, (_, label, value) => {
      const big = Number(String(value).replace(/\./g, ''))
      return `${label}${(big - promoCut(best.promo, big)).toLocaleString('id-ID')}`
    })
    extra.push({ ...row, price: Number(row.price) - best.cut, note })
  }
  return [...rows, ...extra]
}
