// Beta 3.5 — warna dari piksel. Mata model sering menyamakan White dengan Broken White;
// sistem mengukur warna badan jas di foto (ruang warna Lab) dan membandingkannya dengan foto katalog.
import sharp from 'sharp'
import { readLeanState, writeLeanState } from '#beta3/tables'
import type { LeanCatalogRow } from '#beta3/catalog_service'
import { chooseImageColor } from '#beta3/jev_decisions'
import type { LeanHistoryRow } from '#beta3/prompt'

export type Lab = [number, number, number]

function toLinear(value: number) {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** sRGB → CIE Lab (D65). */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)].map((v) => Math.round(v * 10) / 10) as Lab
}

/** Selisih warna; kekuningan (b) diberi bobot lebih karena itu pembeda putih ↔ broken white ↔ krem. */
export function colorDistance(a: Lab, b: Lab) {
  return Math.round(Math.sqrt((a[0] - b[0]) ** 2 * 0.6 + (a[1] - b[1]) ** 2 + ((a[2] - b[2]) * 1.6) ** 2) * 10) / 10
}

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * Warna badan pakaian: dua jalur vertikal kiri & kanan tengah foto (bukan kemeja/kerah di tengah),
 * piksel paling terang & paling gelap (pantulan, bayangan) dibuang, lalu median Lab.
 */
export function garmentLab(pixels: Uint8Array | Buffer, width: number, height: number, channels = 3): Lab | null {
  const samples: Lab[] = []
  for (let y = Math.floor(height * 0.35); y < Math.floor(height * 0.8); y++) {
    for (let x = 0; x < width; x++) {
      const rel = x / width
      if (!((rel >= 0.22 && rel <= 0.38) || (rel >= 0.62 && rel <= 0.78))) continue
      const index = (y * width + x) * channels
      samples.push(rgbToLab(pixels[index], pixels[index + 1], pixels[index + 2]))
    }
  }
  if (samples.length < 20) return null
  const byLight = samples.sort((a, b) => a[0] - b[0])
  const kept = byLight.slice(Math.floor(byLight.length * 0.15), Math.ceil(byLight.length * 0.85))
  return [median(kept.map((s) => s[0])), median(kept.map((s) => s[1])), median(kept.map((s) => s[2]))]
}

export async function measureImage(input: string | Buffer): Promise<Lab | null> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize(48, 64, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return garmentLab(data, info.width, info.height, info.channels)
}

/** Sebutan warna terang yang sering tertukar, dari angka Lab (untuk catatan ke AI & Jev). */
export function describeLab(lab: Lab) {
  const [l, a, b] = lab
  if (l >= 80 && Math.abs(a) < 4) {
    if (b < 4) return 'putih bersih (netral, tidak kekuningan)'
    if (b < 10) return 'putih kekuningan tipis (broken white / off white / gading)'
    if (b < 18) return 'krem muda (kekuningan jelas)'
    return 'krem / beige'
  }
  if (l < 25) return 'sangat gelap (hitam / navy gelap)'
  return `L ${l}, a ${a}, b ${b}`
}

const STATE_KEY = 'catalog_colors'
type ColorMap = Record<string, Lab>

export async function readCatalogColors(): Promise<ColorMap> {
  try {
    return JSON.parse((await readLeanState(STATE_KEY)) || '{}') as ColorMap
  } catch {
    return {}
  }
}

/** Ukur foto katalog yang belum diukur (latar, setelah sinkron katalog). Foto gagal dicatat null. */
export async function measureCatalogColors(rows: LeanCatalogRow[], limit = 40) {
  const map = await readCatalogColors()
  const todo = rows.filter((row) => row.active && row.photoUrl && !(row.photoUrl in map)).slice(0, limit)
  let done = 0
  for (const row of todo) {
    const url = String(row.photoUrl)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(String(response.status))
      const lab = await measureImage(Buffer.from(await response.arrayBuffer()))
      if (lab) {
        map[url] = lab
        done++
      }
    } catch {
      // dicoba lagi di sinkron berikutnya
    }
  }
  if (done) await writeLeanState(STATE_KEY, JSON.stringify(map))
  return { done, remaining: rows.filter((row) => row.active && row.photoUrl && !(row.photoUrl in map)).length }
}

export type ColorCandidate = { color: string; products: string[]; distance: number; lab: Lab }

/**
 * Warna katalog terdekat, per NAMA warna (model ditentukan AI dari ciri foto): 3 teratas,
 * tiap warna dengan contoh produknya.
 */
export function nearestCatalogColors(measured: Lab, rows: LeanCatalogRow[], colors: ColorMap, top = 3): ColorCandidate[] {
  const byColor = new Map<string, ColorCandidate>()
  for (const row of rows) {
    if (!row.active || !row.photoUrl || !colors[row.photoUrl] || !row.color) continue
    const lab = colors[row.photoUrl]
    const distance = colorDistance(measured, lab)
    const key = row.color.trim().toLowerCase()
    const current = byColor.get(key)
    if (!current || distance < current.distance)
      byColor.set(key, {
        color: row.color.trim(),
        products: [...new Set([row.product, ...(current?.products || [])])].slice(0, 3),
        distance,
        lab,
      })
    else if (!current.products.includes(row.product) && current.products.length < 3) current.products.push(row.product)
  }
  return [...byColor.values()].sort((a, b) => a.distance - b.distance).slice(0, top)
}

/**
 * Catatan untuk AI: warna tiap gambar pelanggan dari piksel + pilihan Jev. Kosong bila tidak terukur.
 * Hanya gambar pakaian yang relevan; AI tetap menilai jenis gambarnya sendiri.
 */
export async function imageColorNote(input: {
  jid: string
  paths: string[]
  rows: LeanCatalogRow[]
  text: string
  history: LeanHistoryRow[]
}) {
  const colors = await readCatalogColors()
  const lines: string[] = []
  const detail: Array<Record<string, unknown>> = []
  for (const [index, path] of input.paths.slice(0, 3).entries()) {
    const lab = await measureImage(path).catch(() => null)
    if (!lab) continue
    const shade = describeLab(lab)
    const candidates = nearestCatalogColors(lab, input.rows, colors)
    const clear = candidates.length > 1 && candidates[0].distance <= 8 && candidates[1].distance - candidates[0].distance >= 4
    const chosen = await chooseImageColor({
      jid: input.jid,
      image: index + 1,
      measured: shade,
      candidates,
      text: input.text,
      history: input.history.map((row) => ({ direction: row.direction, body: row.body, mediaType: row.mediaType })),
    }).catch(() => undefined)
    const pick = chosen ?? (clear ? candidates[0].color : undefined)
    const others = candidates
      .filter((candidate) => candidate.color !== pick)
      .map((candidate) => `${candidate.color} (selisih ${candidate.distance})`)
      .join(', ')
    const products = candidates.find((candidate) => candidate.color === pick)?.products || []
    lines.push(
      `- Gambar ${index + 1}: ${shade}.` +
        (pick
          ? ` Warna katalog: ${pick}${chosen ? ' (dipastikan)' : ''}${products.length ? `, ada di ${products.join(', ')}` : ''}.${others ? ` Bukan: ${others}.` : ''}`
          : chosen === null
            ? ' Tidak cocok dengan warna katalog mana pun.'
            : candidates.length
              ? ` Kandidat warna katalog: ${candidates.map((c) => `${c.color} (selisih ${c.distance})`).join(', ')}.`
              : '')
    )
    detail.push({ image: index + 1, lab, shade, candidates: candidates.map(({ lab: _lab, ...rest }) => rest), chosen, pick })
  }
  if (!lines.length) return { note: '', detail }
  return {
    note: `WARNA DI GAMBAR (diukur sistem dari piksel, lebih teliti dari mata untuk putih/broken white/krem; abaikan bila gambar bukan pakaian):\n${lines.join('\n')}\nPakai nama warna ini di balasan & spesifikasi; putih bersih ≠ broken white ≠ krem. Harga mengikuti produk yang punya warna itu di KATALOG.`,
    detail,
  }
}
