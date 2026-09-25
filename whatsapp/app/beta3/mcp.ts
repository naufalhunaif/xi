// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import db from '#services/workspace_database'
import { readLeanState, writeLeanState } from '#beta3/tables'
import { sharedMcpToken } from '#services/shared_mcp_oauth_service'
import { importLeanCatalog } from '#beta3/catalog_service'

/**
 * Klien MCP satu pintu untuk jalur ramping: dipanggil KODE pada event tertentu
 * (form masuk → ongkir, TB/BB → fit advisor, sinkron katalog), bukan oleh model.
 * Sumbernya koneksi MCP di Pengaturan → Data bisnis (slug disimpan di whatsapp_beta3_state).
 */
export type LeanMcpConfig = {
  url: string
  token: string
  /** Slug koneksi di Pengaturan → Data bisnis; kosong bila memakai URL+token lama. */
  slug?: string
  name?: string
  /** Terisi bila koneksi dipilih tapi belum bisa dipakai (belum dihubungkan / token kedaluwarsa). */
  error?: string
}

export type LeanMcpSource = { slug: string; name: string; url: string; connected: boolean }

/** Koneksi MCP yang tersedia di Pengaturan → Data bisnis (satu daftar untuk Beta 1 dan Beta 2). */
export async function listLeanMcpSources(): Promise<LeanMcpSource[]> {
  const rows = await db
    .from('whatsapp_mcp_connections')
    .where('enabled', true)
    .orderBy('id', 'asc')
    .select('slug', 'name', 'url', 'shared_authenticated')
  return rows.map((row) => ({
    slug: String(row.slug),
    name: String(row.name),
    url: String(row.url),
    connected: Boolean(row.shared_authenticated),
  }))
}

/**
 * Beta 2 memakai koneksi yang sama dengan Data bisnis: pilih slug-nya saja.
 * Bila belum dipilih dan hanya ada satu koneksi yang terhubung, itu yang dipakai.
 * URL+token lama (mcp_url/mcp_token) tetap dihormati bila slug kosong.
 */
export async function readLeanMcpConfig(): Promise<LeanMcpConfig> {
  const [slug, legacyUrl, legacyToken] = await Promise.all([
    readLeanState('mcp_slug'),
    readLeanState('mcp_url'),
    readLeanState('mcp_token'),
  ])
  const sources = await listLeanMcpSources()
  const chosen =
    (slug && sources.find((source) => source.slug === slug)) ||
    (!slug && !legacyUrl && sources.filter((source) => source.connected).length === 1
      ? sources.find((source) => source.connected)
      : undefined)
  if (!chosen) {
    if (slug) return { url: '', token: '', slug, error: 'Koneksi tidak ditemukan di Data bisnis.' }
    return { url: legacyUrl, token: legacyToken }
  }
  try {
    const token = await sharedMcpToken(chosen.slug, chosen.url)
    if (!token && !chosen.connected)
      return {
        url: chosen.url,
        token: '',
        slug: chosen.slug,
        name: chosen.name,
        error: 'Belum dihubungkan. Tekan Hubungkan di Pengaturan → Data bisnis.',
      }
    return { url: chosen.url, token, slug: chosen.slug, name: chosen.name }
  } catch (error) {
    return {
      url: chosen.url,
      token: '',
      slug: chosen.slug,
      name: chosen.name,
      error: error instanceof Error ? error.message : 'Koneksi MCP tidak tersedia.',
    }
  }
}

export async function writeLeanMcpConfig(config: { slug?: string; url?: string; token?: string }) {
  if (config.slug !== undefined) await writeLeanState('mcp_slug', config.slug.trim())
  if (config.url !== undefined) await writeLeanState('mcp_url', config.url.trim())
  if (config.token !== undefined) await writeLeanState('mcp_token', config.token.trim())
  return readLeanMcpConfig()
}

export async function callLeanTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
  config?: LeanMcpConfig,
  timeoutMs = 20_000
): Promise<T | null> {
  const resolved = config || (await readLeanMcpConfig())
  if (resolved.error) throw new Error(resolved.error)
  const { url, token } = resolved
  if (!url) return null
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = (await response.json()) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean }
    error?: { message?: string }
  }
  const text = payload.result?.content?.[0]?.text
  if (!response.ok || payload.error || payload.result?.isError || !text)
    throw new Error(payload.error?.message || text || `MCP menjawab ${response.status}.`)
  return JSON.parse(text) as T
}

export type CatalogSyncResult = {
  configured: boolean
  unchanged: boolean
  count: number
  version: string
}

/**
 * Tarik katalog dari MCP (tool catalog_digest) ke tabel lokal. Dengan
 * if_version, server hanya menjawab "unchanged" bila belum ada perubahan —
 * murah untuk dipanggil dari tombol Sync maupun dari perintah ace.
 */
export async function syncLeanCatalog(
  options: { force?: boolean } = {}
): Promise<CatalogSyncResult> {
  const config = await readLeanMcpConfig()
  if (!config.url) return { configured: false, unchanged: false, count: 0, version: '' }
  const stored = await readLeanState('catalog_version')
  const digest = await callLeanTool<{ items?: unknown[]; version?: string; unchanged?: boolean }>(
    'catalog_digest',
    { format: 'json', ...(options.force || !stored ? {} : { if_version: stored }) },
    config,
    30_000
  )
  if (!digest) return { configured: false, unchanged: false, count: 0, version: '' }
  if (digest.unchanged) return { configured: true, unchanged: true, count: 0, version: stored }
  const count = await importLeanCatalog(digest.items || [], true)
  const extra = digest as {
    store?: { text?: string }
    fabrics?: { text?: string }
    size_charts?: { text?: string }
  }
  await writeLeanState(
    'store_profile',
    extra.store?.text ? String(extra.store.text).slice(0, 1500) : ''
  )
  await writeLeanState(
    'fabrics',
    extra.fabrics?.text ? String(extra.fabrics.text).slice(0, 3000) : ''
  )
  await writeLeanState(
    'size_charts',
    extra.size_charts?.text ? String(extra.size_charts.text).slice(0, 4000) : ''
  )
  const version = digest.version ? String(digest.version) : ''
  if (version) await writeLeanState('catalog_version', version)
  return { configured: true, unchanged: false, count, version }
}

/** Tinggi/berat dari teks pelanggan: "161 cm 43 kg", "tinggi 161 berat 43", "tb 161 bb 43". */
export function extractBodyMeasure(text: string): { height: number; weight: number } | null {
  const source = text.toLowerCase()
  let height = 0
  let weight = 0
  const h = source.match(/(?:tinggi|tb)\D{0,6}(\d{2,3})/) || source.match(/(\d{3})\s*cm/)
  const w = source.match(/(?:berat|bb)\D{0,6}(\d{2,3})/) || source.match(/(\d{2,3})\s*kg/)
  if (h) height = Number(h[1])
  if (w) weight = Number(w[1])
  if (!height || !weight) {
    // "161/43" atau "161 43"
    const pair = source.match(/\b(1\d{2})\s*[\/,\s]\s*(\d{2,3})\b/)
    if (pair) {
      height = height || Number(pair[1])
      weight = weight || Number(pair[2])
    }
  }
  if (height < 120 || height > 230 || weight < 30 || weight > 200) return null
  return { height, weight }
}

/**
 * Nama tujuan dari pertanyaan ongkir bebas: "ongkir ke cinyawang berapa",
 * "kirim ke kebon jeruk ongkirnya?", "ongkir cilacap". Null bila bukan tanya ongkir.
 */
const NOT_A_PLACE = new Set(
  (
    'iya oke ok okey sip siap belum tau tahu gak ga tidak engga nggak halo hai hallo makasih terima kasih thanks ' +
    'mau jadi ready ada size ukuran warna harga foto total transfer tf bayar rekening bukti ' +
    'jas celana setelan tuxedo suit beskap vest kemeja navy black hitam putih white army abu grey ' +
    's m l xl xxl xxxl pcs order pesan kirim resi nomor no bos kak gan min ya dong berapa brp ini itu nya ' +
    'saya aku kamu kita dia mereka tinggi berat cm kg custom'
  ).split(' ')
)

export function extractShippingQuery(text: string, followUp = false): string | null {
  const source = text
    .toLowerCase()
    .replace(/[?!.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const isShipping =
    /ongkir|ongkos kirim|biaya kirim/.test(source) ||
    (/(?:kirim|dikirim|pengiriman)\s+ke\s/.test(source) && /berapa|brp|kena/.test(source))
  if (!isShipping && !followUp) return null
  const patterns = [
    /(?:kirim|dikirim|pengiriman)\s+ke\s+([a-z][a-z' -]{2,40}?)(?:\s+(?:berapa|brp|kena|ongkir|ongkirnya|ya|bos|kak|gan|dong)\b.*)?$/,
    /(?:ongkir(?:nya)?|ongkos kirim|biaya kirim)\s*(?:ke|untuk|buat|dari sini ke)?\s+([a-z][a-z' -]{2,40}?)(?:\s+(?:berapa|brp|kena|itu|nya|ya|bos|kak|gan|dong|min|sih)\b.*)?$/,
  ]
  if (followUp) {
    // Lanjutan obrolan ongkir: "kalo ke jakarta?", "ke mampang", atau nama tempat saja.
    patterns.push(
      /^(?:kalo|kalau|klo|kl|trus|terus|lalu)?\s*(?:ke|untuk|buat)\s+([a-z][a-z' -]{2,40}?)(?:\s+(?:berapa|brp|kena|aja|saja|ya|bos|kak|gan|dong)\b.*)?$/,
      /^([a-z][a-z' -]{2,40}?)(?:\s+(?:aja|saja|ya|bos|kak|gan|dong))?$/
    )
  }
  for (const pattern of patterns) {
    const match = source.match(pattern)
    if (!match) continue
    const place = match[1]
      .replace(/\b(kec|kecamatan|kab|kabupaten|kota|desa|kel|kelurahan|daerah)\b/g, ' ')
      .replace(/\b(berapa|brp|ya|bos|kak|gan|dong|min|sih|itu|nya|kena|aja|saja)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const words = place.split(' ')
    if (place.length < 3 || words.length > 4) continue
    // Lanjutan tanpa kata "ongkir": tolak bila ada kata obrolan biasa, supaya "size M ada?" tidak dicari.
    if (followUp && !isShipping && words.some((word) => NOT_A_PLACE.has(word))) continue
    return place
  }
  return null
}

export type DestinationRow = {
  code?: string
  subdistrict?: string
  district?: string
  city?: string
  province?: string
  zip_code?: string
}

const CITY_ALIASES: Record<string, string> = {
  jaksel: 'jakarta selatan',
  jakbar: 'jakarta barat',
  jaktim: 'jakarta timur',
  jakut: 'jakarta utara',
  jakpus: 'jakarta pusat',
  tangsel: 'tangerang selatan',
  jogja: 'yogyakarta',
  yogya: 'yogyakarta',
  sby: 'surabaya',
  bdg: 'bandung',
  smg: 'semarang',
  mks: 'makassar',
  bjm: 'banjarmasin',
  plg: 'palembang',
}

/** "jaksel" → "jakarta selatan"; nama lain dikembalikan apa adanya (huruf kecil). */
export function normalizeCity(name: string) {
  const key = name
    .toLowerCase()
    .replace(/\b(kab|kabupaten|kota)\.?\s*/g, '')
    .trim()
  return CITY_ALIASES[key] || key
}

export type DestinationArea = {
  code: string
  district: string
  city: string
  label: string
  /** Nama kelurahan di kecamatan ini, untuk mencocokkan jawaban pelanggan. */
  terms: string
}

/**
 * Ongkir dihitung per KECAMATAN: baris kelurahan dari ekspedisi dikelompokkan
 * per kecamatan+kota, kode baris pertama dipakai untuk tarif. Kelurahan tidak
 * pernah ditanyakan di chat — itu urusan alamat lengkap saat CS membuat resi.
 */
export function groupDestinations(rows: DestinationRow[]): DestinationArea[] {
  const areas = new Map<string, DestinationArea>()
  for (const row of rows) {
    const district = (row.district || '').trim()
    const city = (row.city || '').trim()
    const key = `${district}|${city}`.toLowerCase()
    if (!district || !row.code) continue
    const term = (row.subdistrict || '').toLowerCase()
    const existing = areas.get(key)
    if (existing) {
      if (term && !existing.terms.includes(term)) existing.terms += ` ${term}`
      continue
    }
    areas.set(key, {
      code: row.code,
      district,
      city,
      label: [district, city].filter(Boolean).join(', '),
      terms: term,
    })
  }
  return [...areas.values()]
}

/** Pilihan kecamatan yang cocok dengan jawaban pelanggan ("jakarta selatan", "yang depok"). */
export function pickArea(reply: string, areas: DestinationArea[]): DestinationArea | null {
  const words = normalizeCity(reply)
    .replace(/\b(yang|bos|kak|gan|ya|aja|saja|dong)\b/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3)
  if (!words.length) return null
  const hits = areas.filter((area) => {
    const hay = `${area.district} ${area.city} ${area.terms}`.toLowerCase()
    return words.every((word) => hay.includes(word))
  })
  return hits.length === 1 ? hits[0] : null
}

/** Ringkas kandidat tujuan yang ambigu untuk ditanyakan ke pelanggan. */
export function renderDestinationChoices(place: string, areas: DestinationArea[]) {
  const choices = areas.slice(0, 4).map((area) => area.label)
  return `TUJUAN "${place}" ada di beberapa daerah: ${choices.join(' / ')}. Tanyakan yang mana (satu pertanyaan), jangan sebut ongkir dulu.`
}

export type FitResult = {
  recommended_size: string
  alternatives?: Array<{ label: string; percentage: number; recommended?: boolean }>
  preference_question?: string | null
}

export function renderFitResult(
  fit: FitResult,
  measure: { height: number; weight: number },
  type: string
) {
  const alternatives = (fit.alternatives || [])
    .filter((item) => item.percentage > 0)
    .map((item) => `${item.label} ${item.percentage}%`)
    .join(', ')
  return `REKOMENDASI SIZE (Fit Advisor, TB ${measure.height} / BB ${measure.weight}, ${type === 'pants' ? 'celana' : 'jas'}): ${fit.recommended_size}${alternatives ? ` (${alternatives})` : ''}. Sampaikan sebagai rekomendasi, tetap konfirmasi ke pelanggan.`
}

export type ShippingRates = {
  destination?: { code?: string; district?: string; city?: string; province?: string; zip_code?: string }
  prices?: Array<{ service: string; name?: string; price: number; etd?: string }>
}

export function renderShippingRates(rates: ShippingRates) {
  const prices = (rates.prices || []).filter((row) => row.price > 0)
  if (!prices.length) return ''
  const where = [rates.destination?.district, rates.destination?.city].filter(Boolean).join(', ')
  return `ONGKIR ke ${where || 'tujuan'} (1 kg): ${prices.map((row) => `${row.service.replace(/\d+$/, '')} ${row.price.toLocaleString('id-ID')}${row.etd ? ` (${row.etd.replace('day', 'hari')})` : ''}`).join(', ')}. Tanyakan mau pakai yang mana; total = harga barang + ongkir yang dipilih.`
}
