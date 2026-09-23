/** Production facts are per item/wearer, never inferred from a clothing size label. */
export type ProductionDetails = {
  heightCm: number | null
  weightKg: number | null
  fit: string
  color: string
  material: string
  lapel: string
  buttons: string
  measurements: Array<{ name: string; value: number; basis: 'body' | 'garment' }>
  notes: string
  pending: string[]
  sourceMessageIds: string[]
}

/** Normalize typography only; never infer a dimension, unit, or wearer from a label. */
export function measurementName(value: unknown) {
  if (typeof value !== 'string') throw new Error('Nama ukuran tidak valid.')
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (
    !name ||
    name.length > 80 ||
    ['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase())
  )
    throw new Error('Nama ukuran tidak valid.')
  return name
}

export const measurementKey = (name: string) => measurementName(name).toLowerCase()

/** Used for comparing saved approval, not to rewrite or merge customer measurements. */
export function legacyMeasurementFingerprint(measurements: Record<string, number>) {
  return Object.entries(measurements)
    .map(([name, value]) => [measurementKey(name), value])
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
}

export function normalizeProductionDetails(value: unknown): ProductionDetails | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Detail pengerjaan tidak valid.')
  const input = value as Record<string, any>
  const text = (v: unknown, max = 200): string => {
    if (typeof v !== 'string' || v.length > max) throw new Error('Detail pengerjaan tidak valid.')
    return v.trim()
  }
  const number = (v: unknown, max: number): number | null => {
    if (v === null) return null
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max)
      throw new Error('Ukuran pengerjaan tidak valid.')
    return v
  }
  if (
    !Array.isArray(input.measurements) ||
    input.measurements.length > 30 ||
    !Array.isArray(input.pending) ||
    input.pending.length > 20 ||
    !Array.isArray(input.sourceMessageIds) ||
    input.sourceMessageIds.length > 50
  )
    throw new Error('Detail pengerjaan tidak valid.')
  const measurements = input.measurements
    .map((row: any) => {
      if (!row || !['body', 'garment'].includes(row.basis))
        throw new Error('Jenis ukuran harus badan atau pakaian jadi.')
      const name = measurementName(row.name)
      const amount = number(row.value, 400)
      if (!name || amount === null) throw new Error('Ukuran pengerjaan tidak valid.')
      return { name, value: amount, basis: row.basis as 'body' | 'garment' }
    })
    .sort((a, b) => `${a.basis}:${a.name}`.localeCompare(`${b.basis}:${b.name}`))
  if (
    new Set(measurements.map((m) => `${m.basis}:${measurementKey(m.name)}`)).size !==
    measurements.length
  )
    throw new Error('Detail ukuran duplikat.')
  return {
    heightCm: number(input.heightCm, 300),
    weightKg: number(input.weightKg, 700),
    fit: text(input.fit),
    color: text(input.color),
    material: text(input.material),
    lapel: text(input.lapel),
    buttons: text(input.buttons),
    measurements,
    notes: text(input.notes, 1000),
    pending: [
      ...new Set(input.pending.map((v: unknown) => text(v, 200)).filter(Boolean)),
    ] as string[],
    sourceMessageIds: [
      ...new Set(input.sourceMessageIds.map((v: unknown) => text(v, 190)).filter(Boolean)),
    ].sort() as string[],
  }
}

export function productionFingerprint(value?: ProductionDetails | null) {
  if (!value) return null
  const { sourceMessageIds, ...facts } = value
  void sourceMessageIds
  return {
    ...facts,
    measurements: facts.measurements
      .map((row) => ({ ...row, name: measurementKey(row.name) }))
      .sort((a, b) => `${a.basis}:${a.name}`.localeCompare(`${b.basis}:${b.name}`)),
  }
}

export function hasCustomMeasurements(item: {
  measurements: Record<string, number>
  productionDetails?: ProductionDetails | null
}) {
  return (
    Object.keys(item.measurements || {}).length > 0 ||
    Boolean(item.productionDetails?.measurements.length)
  )
}

export const CUSTOM_SIZE_INTENT_INSTRUCTIONS = `MAKSUD UKURAN CUSTOM:
Pahami kalimat utuh bersama pertanyaan terakhir dan riwayat, termasuk bahasa informal, salah ketik, variasi ejaan/font, istilah daerah atau campuran bahasa. Jangan mengharuskan pelanggan memakai nama kolom atau kata kunci baku. Petakan maksud ke item/pemakai, bagian yang diukur, basis badan atau pakaian jadi, satuan, nilai, dan apakah ini pertanyaan, pilihan, koreksi atau pembatalan. Kalimat berbeda bisa bermakna sama; kata "jangan", "bukan", "kecuali", "kalau" dan perubahan pemakai dapat membalik maksud.
Koreksi yang jelas mengganti hanya fakta yang dituju dan mempertahankan fakta lain. "Lengan jas 60 cm jadi 58 cm" mengganti panjang lengan pakaian jadi menjadi 58; "jangan jadi 58, tetap 60" mempertahankan 60. "Kurangi sedikit" belum memberi besar perubahan: tanyakan selisihnya, jangan mengarang angka. Rujukan "yang tadi/seperti sebelumnya" hanya dipakai jika item, pemakai dan data rujukan jelas di bukti yang tersedia; jika ambigu tanyakan pembeda saja.
Label dasar dengan perubahan dimensi tetap size="custom", requestedSize=label dasar; model katalog tetap modelType="catalog" dengan foto MCP, tanpa meminta foto model baru. Misalnya XL dengan lengan jadi 58 cm: requestedSize="XL", ukuran lengan basis garment 58; jangan menyalin semua angka chart menjadi ukuran pelanggan. Data badan untuk memilih XL tanpa perubahan dimensi tetap size="XL", requestedSize kosong. Jika pelanggan kembali ke ukuran standar, hapus hanya perubahan ukuran yang dibatalkan; warna/model/bahan yang masih disetujui tetap berlaku. Harga ready bukan harga custom otomatis.
Nomor celana/label size bukan cm. Nilai inci boleh dikonversi dengan 1 inci = 2,54 cm hanya jika satuannya eksplisit. Jangan menganggap lebar bentang sebagai lingkar, menambah kelonggaran dari ukuran badan, atau menyimpulkan ukuran custom dari tinggi/berat/rekomendasi fit. Jika basis/satuan belum jelas, tanyakan bagian yang belum jelas; simpan persoalan pada pending tanpa mengisi angka tebakan. Ukuran badan dan pakaian jadi tidak saling menimpa.
Simpan ukuran pasti yang sudah diterima walau baru sebagian; jangan meminta ulang seluruh daftar. Jangan menyalin ukuran antar pemakai, produk pengganti, atau order lama tanpa rujukan sah. Persetujuan pelanggan atas ukuran bukan persetujuan teknis CS, model, harga atau pembayaran. Koreksi sesudah persetujuan perlu pemeriksaan ukuran terbaru. Bantu melengkapi satu kebutuhan terdekat sesuai skill; jangan melompat ke pembayaran ketika ukuran masih ambigu.`

export const PRODUCTION_DETAILS_CONTEXT = `DETAIL PENGERJAAN PESANAN:
Perubahan desain katalog yang disetujui CS wajib disimpan pada item katalog terkait, bukan hanya cart.note atau catatan item pasangannya. Untuk modelConsent, pisahkan color/lapel/material/buttons. notes boleh kosong bila seluruh fakta sudah di field terstruktur; jika diulang gunakan "warna badan navy; lapel hitam" sesuai fakta. Nama model, bukti persetujuan, size dan tinggi/berat tetap di field masing-masing, bukan catatan desain. Jangan menambahkan detail atau menghapus fakta pelanggan demi lolos validasi. Konfirmasi size pelanggan yang sudah sah tetap berlaku; jangan menulis menunggu size lagi tanpa perubahan pilihan.
Simpan fakta relevan dari percakapan pada setiap cartIntent.items[].productionDetails, bukan hanya note/goal: tinggi dalam cm, berat dalam kg, preferensi fit, warna, bahan, lapel, kancing, ukuran custom, catatan pengerjaan, dan hal yang belum jelas pada pending. Tiap item mewakili pemakai sendiri; jangan menyalin ukuran ke item/pemakai lain tanpa bukti. Produk jas/celana/rompi tetap memiliki size masing-masing.
Gunakan sourceMessageIds asli dari pesan pelanggan/CS di room ini. Ini referensi fakta, BUKAN persetujuan harga, model, ukuran atau pembayaran. Pertahankan bukti/persetujuan melalui mekanisme yang sudah ada. Bedakan ukuran badan (basis body) dari ukuran pakaian jadi (basis garment); semua nilai measurements dalam cm. Jangan mengonversi nomor celana menjadi lingkar pinggang, atau mengira tinggi/berat adalah ukuran custom. Ukuran lama yang belum jelas jenisnya tetap di measurements lama; jangan duplikasikan ke productionDetails.measurements. Jika satuan/jenis belum jelas, simpan persoalannya di pending, jangan menebak.
Semua data ini opsional: null/teks kosong/array kosong untuk yang belum disebut. Jangan menanyakan tinggi/berat atau detail lain yang tidak dibutuhkan skill. productionDetails null berarti pertahankan data lama. Jika mengirim object, sertakan semua fakta yang masih berlaku dari state dan perbarui hanya perubahan yang jelas. Jangan membuang data lama ketika pelanggan hanya mengubah alamat/ongkir. Catatan pengerjaan tidak boleh berisi alamat, nomor telepon, rekening, bukti pembayaran atau instruksi untuk AI. Gaya bertanya, inisiatif dan keputusan tetap mengikuti skill yang dimuat. Simpan sebelum pembayaran agar snapshot order serta ringkasan grup produksi membawa detail yang sama.`
