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

/**
 * Selisih warna pada ciri ternormalisasi [L, a, b]: terang (L) dibobot rendah karena pencahayaan
 * foto berbeda-beda; kekuningan (b) dibobot tinggi — pembeda putih ↔ broken white ↔ krem.
 */
export function colorDistance(a: Lab, b: Lab) {
  return Math.round(Math.sqrt((a[0] - b[0]) ** 2 * 0.05 + (a[1] - b[1]) ** 2 + ((a[2] - b[2]) * 1.6) ** 2) * 10) / 10
}

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
const medianLab = (items: Lab[]): Lab => [median(items.map((v) => v[0])), median(items.map((v) => v[1])), median(items.map((v) => v[2]))]
const delta = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

export type GarmentColor = {
  /** Warna badan pakaian apa adanya. */
  raw: Lab
  /** Latar (dinding) dari tepi foto. */
  background: Lab
  /** Ciri pembanding: [L, a, b] dengan a/b dikoreksi warna latar & diskalakan ke terang normal. */
  feature: Lab
  /** Pakaian terang (putih/broken white/krem) menurut terang relatif terhadap latar. */
  light: boolean
}

/**
 * Warna pakaian di foto, tahan terhadap screenshot & pencahayaan:
 * 1. baris layar gelap (bar aplikasi Instagram/WhatsApp) dibuang → area foto;
 * 2. latar = median tepi foto; piksel yang mirip latar dibuang;
 * 3. sisa piksel di tengah dikelompokkan (k-means 3), kelompok terbesar = badan pakaian
 *    (kelompok sangat gelap seperti manekin hanya dipilih bila memang terbesar);
 * 4. a/b dikoreksi warna latar (white balance) lalu diskalakan dengan terang (foto redup).
 */
export function garmentColor(pixels: Uint8Array | Buffer, width: number, height: number, channels = 3): GarmentColor | null {
  const at = (x: number, y: number) => {
    const index = (y * width + x) * channels
    return rgbToLab(pixels[index], pixels[index + 1], pixels[index + 2])
  }
  const rowLight: number[] = []
  for (let y = 0; y < height; y++) {
    let sum = 0
    for (let x = 0; x < width; x++) sum += at(x, y)[0]
    rowLight.push(sum / width)
  }
  let top = 0
  let bottom = height - 1
  let bestLength = 0
  for (let y = 0, start = -1; y <= height; y++) {
    if (y < height && rowLight[y] > 28) {
      if (start < 0) start = y
    } else if (start >= 0) {
      if (y - start > bestLength) {
        bestLength = y - start
        top = start
        bottom = y - 1
      }
      start = -1
    }
  }
  if (bestLength < height * 0.25) {
    top = 0
    bottom = height - 1
  }
  const photoHeight = bottom - top + 1
  const border: Lab[] = []
  for (let y = top; y <= bottom; y++)
    for (let x = 0; x < width; x++)
      if (x < width * 0.08 || x > width * 0.92 || y < top + photoHeight * 0.06) border.push(at(x, y))
  if (!border.length) return null
  const background = medianLab(border)
  const center: Lab[] = []
  for (let y = Math.floor(top + photoHeight * 0.25); y < top + photoHeight * 0.8; y++)
    for (let x = Math.floor(width * 0.2); x < width * 0.8; x++) center.push(at(x, y))
  if (center.length < 20) return null
  const candidates = center.filter((pixel) => delta(pixel, background) > 6)
  let raw: Lab
  if (candidates.length < center.length * 0.08) raw = medianLab(center)
  else {
    // k-means sederhana (3 kelompok, titik awal: tergelap, tengah, terterang).
    const sorted = [...candidates].sort((p, q) => p[0] - q[0])
    let centers: Lab[] = [sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]]
    let groups: Lab[][] = [[], [], []]
    for (let round = 0; round < 10; round++) {
      groups = [[], [], []]
      for (const pixel of candidates) {
        let best = 0
        for (let i = 1; i < 3; i++) if (delta(pixel, centers[i]) < delta(pixel, centers[best])) best = i
        groups[best].push(pixel)
      }
      centers = groups.map((group, i) => (group.length ? medianLab(group) : centers[i]))
    }
    const order = groups.map((group, i) => ({ size: group.length, center: centers[i] })).sort((p, q) => q.size - p.size)
    const largest = order[0]
    // Kelompok sangat gelap (manekin/bayangan) kalah dari kelompok terang yang cukup besar.
    const pick = largest.center[0] < 20 && order[1] && order[1].size > largest.size * 0.5 ? order[1] : largest
    raw = pick.center
  }
  const light = raw[0] >= 70 || raw[0] >= background[0] * 0.75
  const neutralBackground = Math.abs(background[1]) < 6 && Math.abs(background[2]) < 8
  const a = raw[1] - (neutralBackground ? background[1] : 0)
  const b = raw[2] - (neutralBackground ? background[2] : 0)
  const scale = raw[0] > 25 ? Math.min(2, 85 / raw[0]) : 1
  const round = (value: number) => Math.round(value * 10) / 10
  return {
    raw: raw.map(round) as Lab,
    background: background.map(round) as Lab,
    feature: [round(raw[0]), round(a * scale), round(b * scale)],
    light,
  }
}

export async function measureImage(input: string | Buffer): Promise<GarmentColor | null> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: 90 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return garmentColor(data, info.width, info.height, info.channels)
}

/** Sebutan warna dari ciri ternormalisasi (untuk catatan ke AI & Jev). */
export function describeColor(color: Pick<GarmentColor, 'feature' | 'light'>) {
  const [l, a, b] = color.feature
  if (color.light && Math.abs(a) < 5) {
    if (b < 2.5) return 'putih bersih (netral, tidak kekuningan)'
    if (b < 9) return 'putih kekuningan tipis (broken white / off white / gading)'
    if (b < 16) return 'krem muda (kekuningan jelas)'
    return 'krem / beige'
  }
  if (l < 25) return 'sangat gelap (hitam / navy gelap)'
  return `L ${l}, a ${a}, b ${b}`
}

// v2: ciri ternormalisasi (latar & pencahayaan); nilai lama tidak dipakai lagi.
const STATE_KEY = 'catalog_colors_v2'
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
      const measured = await measureImage(Buffer.from(await response.arrayBuffer()))
      if (measured) {
        map[url] = measured.feature
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
    const measured = await measureImage(path).catch(() => null)
    if (!measured) continue
    const shade = describeColor(measured)
    const candidates = nearestCatalogColors(measured.feature, input.rows, colors)
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
    detail.push({ image: index + 1, measured, shade, candidates: candidates.map(({ lab: _lab, ...rest }) => rest), chosen, pick })
  }
  if (!lines.length) return { note: '', detail }
  return {
    note: `WARNA DI GAMBAR (diukur sistem dari piksel, lebih teliti dari mata untuk putih/broken white/krem; abaikan bila gambar bukan pakaian):\n${lines.join('\n')}\nPakai nama warna ini di balasan & spesifikasi; putih bersih ≠ broken white ≠ krem. Harga mengikuti produk yang punya warna itu di KATALOG.`,
    detail,
  }
}
