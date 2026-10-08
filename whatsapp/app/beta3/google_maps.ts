// v3.6.98 — Google Maps untuk mencari lokasi (seperti CS membuka Google Maps): Places API (Text Search) untuk
// nama usaha/tempat/alamat dan Geocoding API untuk koordinat dari link peta. Kunci API disimpan terenkripsi
// (Pengaturan → Google Maps). Tanpa kunci → tidak dipakai (peta terbuka & pencarian internet tetap jalan).
import encryption from '@adonisjs/core/services/encryption'
import { readLeanState, writeLeanState } from '#beta3/tables'

const PURPOSE = 'gmaps'
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
const realFetch: Fetcher = (url, init) => fetch(url, init)
let fetcher: Fetcher = realFetch
/** Untuk tes saja: jaringan tiruan. null = jaringan sungguhan. */
export function setMapsFetcher(next: Fetcher | null) {
  fetcher = next || realFetch
}

export type MapsPlace = { display: string; names: string[]; city: string; postcode: string; lat?: number; lon?: number }

let keyOverride: string | null = null
/** Untuk tes saja: kunci tiruan tanpa basis data. */
export function setMapsKeyForTest(key: string | null) {
  keyOverride = key
}

export async function readMapsKey() {
  if (keyOverride !== null) return keyOverride
  const stored = await readLeanState('gmaps_key').catch(() => null)
  if (!stored) return ''
  try {
    return String(encryption.decrypt<string>(String(stored), PURPOSE) || '')
  } catch {
    return ''
  }
}

export async function saveMapsKey(key: string) {
  const value = String(key || '').trim()
  await writeLeanState('gmaps_key', value ? encryption.encrypt(value, undefined, PURPOSE) : '')
  await writeLeanState('gmaps_error', '')
  return mapsStatus()
}

export async function mapsStatus() {
  const key = await readMapsKey()
  return { configured: Boolean(key), lastError: String((await readLeanState('gmaps_error').catch(() => '')) || '') }
}

const clean = (value: unknown) =>
  String(value || '')
    .replace(/^(kecamatan|kec\.?|kabupaten|kab\.?|kota|kelurahan|kel\.?|desa)\s+/i, '')
    .trim()

/** Komponen alamat Google → kecamatan (level 3), kota/kab (level 2), kode pos. */
export function placeFromComponents(
  display: string,
  components: Array<{ types?: string[]; longText?: string; long_name?: string }>,
  location?: { lat?: number; lon?: number }
): MapsPlace | null {
  const find = (type: string) => {
    const hit = components.find((item) => (item.types || []).includes(type))
    return hit ? String(hit.longText ?? hit.long_name ?? '') : ''
  }
  const kecamatan = clean(find('administrative_area_level_3'))
  const desa = clean(find('administrative_area_level_4'))
  const city = clean(find('administrative_area_level_2') || find('locality'))
  const postcode = find('postal_code').replace(/\D/g, '').slice(0, 5)
  if (!kecamatan && !postcode) return null
  return {
    display: String(display || '').slice(0, 300),
    names: [...new Set([kecamatan, desa].filter(Boolean))],
    city,
    postcode,
    ...(location?.lat !== undefined ? { lat: location.lat, lon: location.lon } : {}),
  }
}

async function fail(message: string) {
  await writeLeanState('gmaps_error', message.slice(0, 200)).catch(() => {})
  return null
}

/** Places API (New) Text Search: nama usaha, tempat, atau alamat → satu tempat terbaik. */
export async function googleSearch(query: string): Promise<MapsPlace | null> {
  const key = await readMapsKey()
  const q = String(query || '').trim().slice(0, 200)
  if (!key || q.length < 3) return null
  const response = await fetcher('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.formattedAddress,places.addressComponents,places.location,places.displayName',
    },
    body: JSON.stringify({ textQuery: q, languageCode: 'id', regionCode: 'ID', pageSize: 1 }),
    signal: AbortSignal.timeout(6000),
  }).catch(() => null)
  if (!response) return fail('Google Maps tidak bisa dihubungi')
  const data = (await response.json().catch(() => ({}))) as any
  if (!response.ok) return fail(String(data?.error?.message || `Google Maps menolak (${response.status})`))
  const place = data?.places?.[0]
  if (!place) return null
  const name = String(place.displayName?.text || '')
  const display = [name && !String(place.formattedAddress || '').startsWith(name) ? name : '', place.formattedAddress].filter(Boolean).join(', ')
  return placeFromComponents(display, place.addressComponents || [], {
    lat: place.location?.latitude,
    lon: place.location?.longitude,
  })
}

/** Geocoding API: koordinat dari link peta → alamat (kecamatan, kab/kota, kode pos). */
export async function googleReverse(lat: number, lon: number): Promise<MapsPlace | null> {
  const key = await readMapsKey()
  if (!key) return null
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&language=id&key=${encodeURIComponent(key)}`
  const response = await fetcher(url, { signal: AbortSignal.timeout(6000) }).catch(() => null)
  if (!response) return fail('Google Maps tidak bisa dihubungi')
  const data = (await response.json().catch(() => ({}))) as any
  if (data?.status && data.status !== 'OK') return data.status === 'ZERO_RESULTS' ? null : fail(String(data.error_message || data.status))
  const best = data?.results?.[0]
  return best ? placeFromComponents(best.formatted_address, best.address_components || [], { lat, lon }) : null
}
