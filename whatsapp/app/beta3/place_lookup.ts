// v3.6.92 — Cari lokasi di peta, seperti CS membuka Google Maps: link peta dari pelanggan dan nama tempat
// yang tidak ada di data ekspedisi (mis. "ICE BSD", "jln pelelangan pangkep") dicari di OpenStreetMap
// (Nominatim), lalu dicocokkan ke tujuan ekspedisi lewat nama kecamatan, kota/kabupaten, dan kode pos.
// Hasil disimpan 30 hari supaya tidak mencari ulang (batas Nominatim 1 permintaan/detik).
import { readLeanState, writeLeanState } from '#beta3/tables'
import type { DestinationRow } from '#beta3/mcp'
import { googleReverse, googleSearch, readMapsKey } from '#beta3/google_maps'

export type GeoPlace = {
  display: string
  /** Nama wilayah dari yang paling kecil yang biasanya = kecamatan (municipality/city_district) dulu. */
  names: string[]
  city: string
  postcode: string
  lat?: number
  lon?: number
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
const realFetch: Fetcher = (url, init) => fetch(url, init)
let fetcher: Fetcher = realFetch
/** Untuk tes saja: jaringan tiruan. null = jaringan sungguhan. */
export function setGeoFetcher(next: Fetcher | null) {
  fetcher = next || realFetch
}

const UA = 'ChameleonClothCS/1.0 (+https://chameleoncloth.com)'
const NOMINATIM = 'https://nominatim.openstreetmap.org'
const CACHE_MS = 30 * 86_400_000
const MAP_LINK =
  /https?:\/\/(?:share\.google|maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|maps\.google\.[a-z.]+|(?:www\.)?google\.[a-z.]+\/maps)[^\s]*/i

/** Link peta di pesan pelanggan (Google Maps / share.google). */
export function mapLink(text: string) {
  return String(text || '').match(MAP_LINK)?.[0] || ''
}

/** Koordinat / nama tempat dari URL Google Maps (sesudah redirect). */
export function parseMapUrl(url: string): { lat?: number; lon?: number; name?: string } {
  let decoded = String(url || '')
  try {
    decoded = decodeURIComponent(decoded.replace(/\+/g, ' '))
  } catch {}
  const at =
    decoded.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/) ||
    decoded.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/) ||
    decoded.match(/[?&](?:q|ll|query|center|destination)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/)
  const name = (decoded.match(/\/place\/([^/@?]+)/)?.[1] || decoded.match(/[?&]q=([^&]+)/)?.[1] || '').trim()
  return {
    ...(at ? { lat: Number(at[1]), lon: Number(at[2]) } : {}),
    ...(name && !/^-?\d/.test(name) ? { name } : {}),
  }
}

async function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const raw = await readLeanState(key).catch(() => '')
  if (raw) {
    try {
      const hit = JSON.parse(String(raw)) as { at: number; value: T | null }
      if (Date.now() - hit.at < CACHE_MS) return hit.value
    } catch {}
  }
  const value = await load()
  await writeLeanState(key, JSON.stringify({ at: Date.now(), value })).catch(() => {})
  return value
}

const clean = (value: unknown) =>
  String(value || '')
    .replace(/^(kecamatan|kec\.?|kabupaten|kab\.?|kota|kelurahan|kel\.?|desa)\s+/i, '')
    .trim()

/** Satu hasil Nominatim → nama wilayah, kota/kab, kode pos. */
export function placeFrom(item: any): GeoPlace | null {
  if (!item) return null
  const a = item.address || {}
  const names = [a.municipality, a.city_district, a.district, a.subdistrict, a.suburb, a.village, a.town, a.quarter]
    .map(clean)
    .filter(Boolean)
  return {
    display: String(item.display_name || '').slice(0, 300),
    names: [...new Set(names)],
    city: clean(a.county || a.regency || a.city || a.state_district || a.town || ''),
    postcode: String(a.postcode || '').trim(),
    ...(item.lat ? { lat: Number(item.lat), lon: Number(item.lon) } : {}),
  }
}

async function nominatim(path: string) {
  const response = await fetcher(`${NOMINATIM}${path}`, {
    headers: { 'user-agent': UA, 'accept-language': 'id' },
    signal: AbortSignal.timeout(6000),
  })
  if (!response.ok) return null
  return response.json()
}

export async function geocode(query: string): Promise<GeoPlace | null> {
  const q = String(query || '').trim().slice(0, 160)
  if (q.length < 3) return null
  return cached(`geo:q:${q.toLowerCase()}`, async () => {
    const rows = await nominatim(`/search?format=jsonv2&addressdetails=1&countrycodes=id&limit=1&q=${encodeURIComponent(q)}`).catch(() => null)
    return Array.isArray(rows) ? placeFrom(rows[0]) : null
  })
}

export async function reverseGeocode(lat: number, lon: number): Promise<GeoPlace | null> {
  return cached(`geo:r:${lat.toFixed(4)},${lon.toFixed(4)}`, async () => {
    const item = await nominatim(`/reverse?format=jsonv2&addressdetails=1&zoom=16&lat=${lat}&lon=${lon}`).catch(() => null)
    return placeFrom(item)
  })
}

/**
 * Alamat Indonesia bertulis ("…, Jagong, Kec. Pangkajene, Kabupaten Pangkajene Dan Kepulauan, Sulawesi Selatan 90612")
 * → kecamatan, kota/kab, kode pos. null bila tidak ada "Kec." dan kode pos.
 */
export function parseAddress(text: string): GeoPlace | null {
  const value = String(text || '').replace(/\s+/g, ' ')
  const kec = value.match(/\bKec(?:amatan|\.)?\s+([A-Za-z][A-Za-z .'-]{2,40}?)(?=,|\s+Kab|\s+Kota|$)/i)?.[1]
  const city = value.match(/\b(?:Kabupaten|Kab\.|Kota)\s+([A-Za-z][A-Za-z .'-]{2,50}?)(?=,|\s+\d{5}|\s+(?:Jawa|Sumatera|Sulawesi|Kalimantan|Banten|Bali|Nusa|Papua|Maluku|Aceh|Riau|Jambi|Bengkulu|Lampung|Gorontalo|DKI|DI )|$)/i)?.[1]
  const postcode = value.match(/\b(\d{5})\b/)?.[1] || ''
  if (!kec && !postcode) return null
  return { display: value.slice(0, 300), names: kec ? [kec.trim()] : [], city: (city || '').trim(), postcode }
}

/** Ikuti link peta (share.google / maps.app.goo.gl) sampai URL Google Maps; ambil koordinat / nama tempat. */
export async function resolveMapLink(url: string): Promise<{ lat?: number; lon?: number; name?: string; address?: string }> {
  const hit = await cached(`geo:l:${url}`, async () => {
    try {
      const response = await fetcher(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'accept-language': 'id' },
        signal: AbortSignal.timeout(6000),
      })
      const parsed = parseMapUrl(response.url || url)
      if (parsed.lat) return parsed
      const html = (await response.text().catch(() => '')).slice(0, 300_000)
      const fromHtml = parseMapUrl(html.match(/https?:\/\/(?:www\.)?google\.[a-z.]+\/maps[^"'\s<>]+/)?.[0] || '')
      const title =
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] ||
        html.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/\s+-\s+(?:Penelusuran Google|Google Search|Google Maps)\s*$/i, '') ||
        ''
      // Panel Google (share.google → google.com/search?q=…): "Alamat: …, Kec. X, Kabupaten Y, … 90612".
      const address = html.replace(/<[^>]+>/g, ' ').match(/Alamat\s*:?\s*([^|]{10,220}?\b\d{5}\b)/)?.[1] || ''
      // Judul halaman sering memuat lokasi ("CV. X Kabupaten Y"); nama dari q= tidak.
      const name = /\b(kabupaten|kota|kab\.|kec\.)/i.test(title) ? title : parsed.name || fromHtml.name || title
      return { ...fromHtml, ...(name ? { name } : {}), ...(address ? { address: address.trim() } : {}) }
    } catch {
      return null
    }
  })
  return hit || {}
}

/** Singkatan wilayah yang tidak dikenal peta ("pangkep", "jaksel", "jln"). */
const PLACE_ALIASES: Record<string, string> = {
  pangkep: 'pangkajene',
  jaksel: 'jakarta selatan',
  jakbar: 'jakarta barat',
  jaktim: 'jakarta timur',
  jakut: 'jakarta utara',
  jakpus: 'jakarta pusat',
  jkt: 'jakarta',
  tangsel: 'tangerang selatan',
  tgr: 'tangerang',
  jogja: 'yogyakarta',
  jogjakarta: 'yogyakarta',
  sby: 'surabaya',
  bdg: 'bandung',
  smg: 'semarang',
  mks: 'makassar',
  plg: 'palembang',
  bpp: 'balikpapan',
  jln: 'jalan',
  jl: 'jalan',
  kab: '',
  kec: '',
}
/** Variasi kata pencarian: singkatan diganti; maks 2 (batas Nominatim). */
export function placeQueries(place: string) {
  const words = String(place || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const expanded = words.map((word) => (word.replace(/\.$/, '') in PLACE_ALIASES ? PLACE_ALIASES[word.replace(/\.$/, '')] : word)).filter(Boolean).join(' ')
  return [...new Set([expanded, words.join(' ')].filter((query) => query.length >= 3))].slice(0, 2)
}

const norm = (value: unknown) =>
  String(value || '')
    .toLowerCase()
    .replace(/^(kabupaten|kab\.?|kota)\s+/, '')
    .replace(/\s+(regency|city)$/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Cocokkan hasil peta ke tujuan ekspedisi: kode pos dulu, lalu kota/kabupaten yang sama. */
export async function matchDestination(place: GeoPlace, find: (q: string) => Promise<DestinationRow[]>): Promise<DestinationRow[]> {
  const city = norm(place.city)
  const tokens = (value: string) => value.split(' ').filter((word) => word.length > 3 && !['dan', 'kepulauan', 'utara', 'selatan', 'barat', 'timur', 'tengah'].includes(word))
  const sameCity = (row: DestinationRow) => {
    const other = norm(row.city)
    if (!city || !other) return false
    if (other.includes(city) || city.includes(other)) return true
    const mine = tokens(city)
    return tokens(other).some((word) => mine.includes(word))
  }
  for (const name of place.names.slice(0, 4)) {
    const rows = await find(name).catch(() => [] as DestinationRow[])
    if (!rows.length) continue
    const byZip = place.postcode ? rows.filter((row) => String(row.zip_code || '') === place.postcode) : []
    if (byZip.length) return byZip
    const byCity = rows.filter(sameCity)
    // Nama = kecamatan (bukan desa bernama mirip di kecamatan lain, mis. "Pagedangan Ilir" di Kronjo).
    const district = byCity.filter((row) => norm(row.district) === norm(name))
    if (district.length) return district
    if (byCity.length) return byCity
  }
  return []
}

export type PlaceLookup = { rows: DestinationRow[]; display: string; source: 'link' | 'peta'; city?: string }
/** Jejak pencarian terakhir (untuk trace): apa yang dicoba & ditemukan. */
export type LookupTrail = string[]

/**
 * Cari tujuan dari link peta di pesan, atau dari nama tempat yang tidak dikenal ekspedisi.
 * null bila tidak ketemu (AI lalu menanyakan kecamatan seperti biasa).
 */
/** Google Maps (bila kunci diisi), hasil disimpan 30 hari supaya hemat biaya API. */
async function viaGoogle(key: string, load: () => Promise<GeoPlace | null>, trail: LookupTrail) {
  if (!(await readMapsKey())) return null
  // Hanya hasil yang ketemu disimpan (kunci salah / gangguan sesaat tidak membuat "tidak ketemu" 30 hari).
  const name = `geo:g:${key.slice(0, 180)}`
  let place: GeoPlace | null = null
  try {
    const hit = JSON.parse(String((await readLeanState(name).catch(() => '')) || 'null')) as { at: number; value: GeoPlace } | null
    if (hit && Date.now() - hit.at < CACHE_MS) place = hit.value
  } catch {}
  if (!place) {
    place = await load().catch(() => null)
    if (place) await writeLeanState(name, JSON.stringify({ at: Date.now(), value: place })).catch(() => {})
  }
  trail.push(`google maps → ${place ? `${place.display.slice(0, 120)} | ${place.names.join('/')} | ${place.city} | ${place.postcode}` : 'tidak ketemu'}`)
  return place
}

/** Pencarian internet oleh AI (WebSearch) untuk nama usaha/tempat yang tidak ada di peta terbuka. */
export type WebPlaceSearch = (query: string) => Promise<{ alamat?: string; kecamatan?: string; kabupaten?: string; kode_pos?: string } | null>

export async function lookupPlace(
  input: { text: string; place?: string | null },
  find: (q: string) => Promise<DestinationRow[]>,
  trail: LookupTrail = [],
  web?: WebPlaceSearch
): Promise<PlaceLookup | null> {
  const link = mapLink(input.text)
  let place: GeoPlace | null = null
  let source: PlaceLookup['source'] = 'peta'
  let cityHint = ''
  if (link) {
    source = 'link'
    const target = await resolveMapLink(link)
    trail.push(`link → ${JSON.stringify(target).slice(0, 240)}`)
    if (target.address) place = parseAddress(target.address)
    // v3.6.98: Google Maps dulu (bila kuncinya diisi), seperti CS membuka Google Maps.
    if (!place && target.lat !== undefined && target.lon !== undefined) place = await viaGoogle(`r:${target.lat.toFixed(5)},${target.lon.toFixed(5)}`, () => googleReverse(target.lat!, target.lon!), trail)
    if (!place && target.name) place = await viaGoogle(`q:${target.name.toLowerCase()}`, () => googleSearch(target.name!), trail)
    if (!place && target.lat !== undefined && target.lon !== undefined) place = await reverseGeocode(target.lat, target.lon)
    if (!place && target.name) {
      place = await geocode(target.name)
      // "CV. X Kabupaten Pangkajene Dan Kepulauan" → minimal kota/kabupatennya (nama usaha jarang ada di peta).
      cityHint = target.name.match(/\b(?:Kabupaten|Kota|Kab\.)\s+(.+)$/i)?.[1]?.trim() || ''
      if (!place && cityHint) place = await geocode(`Kabupaten ${cityHint}`)
    }
  }
  // Alamat lengkap yang ditempel pelanggan ("…, Kec. Pagedangan, Kabupaten Tangerang, Banten 15339").
  if (!place) place = parseAddress(input.text)
  if (!place && input.place) place = await viaGoogle(`q:${input.place.toLowerCase()}`, () => googleSearch(placeQueries(input.place!)[0] || input.place!), trail)
  if (!place && input.place) {
    for (const query of placeQueries(input.place)) {
      place = await geocode(query)
      if (place) break
    }
  }
  // v3.6.97: tidak ada di peta terbuka → cari di internet (Google Maps/website) seperti CS, hasil disimpan 30 hari.
  if (!place && web) {
    const target = link ? (await resolveMapLink(link)).name || '' : ''
    const query = [target, link || input.place || ''].filter(Boolean).join(' ').trim()
    if (query) {
      const found = await cached(`geo:w:${query.toLowerCase().slice(0, 180)}`, async () => {
        const hit = await web(query).catch(() => null)
        if (!hit || (!hit.kecamatan && !hit.kode_pos)) return null
        return {
          display: String(hit.alamat || [hit.kecamatan, hit.kabupaten].filter(Boolean).join(', ')).slice(0, 300),
          names: hit.kecamatan ? [clean(hit.kecamatan)] : [],
          city: clean(hit.kabupaten || ''),
          postcode: String(hit.kode_pos || '').replace(/\D/g, '').slice(0, 5),
        } satisfies GeoPlace
      })
      trail.push(`internet → ${found ? `${found.display.slice(0, 120)} | ${found.names.join('/')} | ${found.city} | ${found.postcode}` : 'tidak ketemu'}`)
      if (found) {
        place = found
        if (link) source = 'link'
      }
    }
  }
  if (!place) {
    trail.push('peta: tidak ketemu')
    return null
  }
  trail.push(`peta → ${place.display.slice(0, 120)} | ${place.names.join('/')} | ${place.city} | ${place.postcode}`)
  const rows = await matchDestination(place, find)
  trail.push(`tujuan → ${rows.length} baris`)
  return rows.length ? { rows, display: place.display, source, city: place.city } : null
}
