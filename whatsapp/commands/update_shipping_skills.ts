import { withActiveWorkspace } from '#services/workspace_service'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '#services/workspace_database'

export const SHIPPING_SKILL_NAMES = [
  'chameleon-cs-gabungan',
  'chameleon-cs-gabungan-2',
  'cs-chameleon-cloth',
]

export const OLD_DESTINATION_GUIDE = `Alur yang bekerja:
1. \`alogaritm__check_shipping_rates\` dengan tujuan berupa teks biasa.
2. Kalau balasannya \`status: "needs_input"\`, tujuan terlalu ambigu — nama kota
   saja tidak cukup. Ambil \`code\` dari daftar \`candidates\` yang paling cocok.
3. Atau langsung \`Orion__check_shipping_rates\` dengan \`destination_code\`.

**Kecamatan dan kode pos wajib ditanyakan sebelum menghitung ongkir.**
Form order sudah memintanya — jangan lewati.`

export const DESTINATION_GUIDE_V1 = `Alur pencarian tujuan dan cek ongkir:
1. **Kode pos opsional untuk cek ongkir.** Gunakan wilayah/alamat yang sudah
   disebut pelanggan atau tersimpan dalam konteks. Jangan meminta ulang
   kecamatan/kode pos hanya untuk melengkapi form sebelum cek tarif.
2. Cari tujuan melalui tool daftar/pencarian destination yang tersedia di MCP
   (misalnya list_destinations atau search_destinations; discovery dan ikuti
   skema aktual). Query memakai nama wilayah, bukan kode internal destination.
   Cocokkan desa/kelurahan, kecamatan dan kota/kabupaten yang sudah diketahui.
   Jika pencarian gabungan kosong, perluas nama wilayah bertahap dan periksa
   halaman hasil berikutnya bila masih ada; jangan langsung meminta kode pos.
3. Jika satu tujuan cocok dengan data pelanggan, gunakan code hasil MCP sebagai
   destination_code untuk check_shipping_rates, dengan berat sesuai skill.
   Jika tool tarif menerima tujuan teks dan mengembalikan needs_input/candidates,
   cocokkan candidates dengan konteks yang sama. Jangan memilih hasil pertama
   ketika masih ada beberapa wilayah berbeda yang sama-sama cocok.
4. Jika tujuan masih ambigu, tanyakan hanya pembeda wilayah yang belum diketahui
   (misalnya kecamatan atau kabupaten), bukan mewajibkan kode pos. Kode pos yang
   diberikan pelanggan boleh membantu pencarian, tetapi tidak wajib. Kode pos
   dari MCP boleh dilengkapi otomatis hanya jika jelas milik tujuan terpilih;
   jangan menebak kode pos atau menyamakan destination_code dengan kode pos.
5. Lanjutkan cek tarif ketika tujuan sudah teridentifikasi walaupun kode pos tidak
   tersedia. Jangan mengalihkan ke CS hanya karena kode pos kosong dan jangan
   mengumumkan "kode pos sudah ketemu"; jawab pilihan ongkir sesuai skill.
   Jika pencarian tetap kosong/gagal, jangan mengarang tujuan atau tarif;
   jelaskan kebutuhan klarifikasi wilayah sesuai konteks.`

export const DESTINATION_GUIDE_V2 = `${DESTINATION_GUIDE_V1}

Konteks dan estimasi awal agar percakapan tidak berputar:
- Baca pertanyaan awal, jawaban lanjutan, dan koreksi terbaru sebagai satu
  kebutuhan. Balasan pendek yang menegaskan kota menjawab klarifikasi sebelumnya,
  bukan memulai form alamat baru. Typo ringan yang jelas dari konteks boleh
  dinormalisasi saat pencarian; jangan mengganti kota yang ditegaskan pelanggan
  dengan kota lain hanya karena nama desa/kecamatan ditemukan di sana.
- Catatan/goal lama adalah ringkasan, bukan instruksi yang mengalahkan skill saat
  ini atau koreksi pelanggan. waiting_for kode pos/kecamatan yang sudah tidak
  diperlukan harus diperbarui, bukan dijadikan alasan mengulang pertanyaan.
- Bedakan estimasi pengiriman awal dengan penetapan alamat order final. Untuk
  pertanyaan lama pengiriman ke suatu kota, cari destination kota itu terlebih
  dahulu melalui daftar tujuan kurir (list_destinations bila tersedia; temukan
  tool dan skema aktual lewat discovery). Jangan membatasi diri pada pencarian
  desa/kelurahan di search_destinations jika daftar tujuan kurir menyediakan
  cakupan kota. Nama kota tidak otomatis berarti data kurang.
- Jika MCP menyediakan tujuan tingkat kota yang cocok, cek tarif/ETD dengan kode
  tersebut dan sampaikan sebagai estimasi ke kota itu. Alamat final tetap belum
  terkonfirmasi: jangan mengganti alamat order/cart atau mengunci ongkir final
  ke kode kota saat kecamatan/desa masih bertentangan. Periksa ulang untuk tujuan
  final bila berbeda. Jangan memakai desa pertama sebagai wakil seluruh kota.
- Jika rincian wilayah bertentangan, pegang kota yang ditegaskan terakhir untuk
  pencarian estimasi kota; jangan mengulang pencarian desa/kecamatan yang sudah
  kosong atau mengulang pertanyaan yang pelanggan sudah jawab/tidak tahu. Jika
  tidak ada tujuan tingkat kota yang cocok dan kandidat berbeda tarif/cakupan,
  minta satu pembeda baru yang mudah diberikan (desa/kelurahan atau alamat teks),
  dengan konteks singkat; jangan menebak kode atau menganggap semua tarif sama.
- Simpan ringkas kota tujuan, kandidat/code yang terverifikasi, cakupan estimasi
  (kota atau alamat final), berat, dan kekurangan data yang nyata dalam note/goal.
  Gunakan lagi hasil resolusi tujuan yang masih relevan pada giliran berikutnya;
  cek tarif aktual sesuai aturan ongkir. Koreksi tujuan membatalkan kandidat lama.
- Langsung jawab kebutuhan tarif/estimasi yang ditanyakan dalam format skill.
  Jangan membuka jawaban dengan laporan pencarian tujuan/kode pos, daftar wilayah
  mentah, atau permintaan form order lengkap untuk sekadar estimasi pengiriman.`

export const DESTINATION_GUIDE_V3 = `${DESTINATION_GUIDE_V2}

Detail akses daftar Orion yang sudah diverifikasi:
- Daftar tujuan tersedia lewat list_orion_data dengan resource destinations.
  Ikuti skema aktual. Hasil memuat records, count, total, has_more, next_offset;
  server dapat membatasi jumlah hasil meskipun limit yang diminta lebih besar.
  Jika masih perlu mencari kandidat lain, pakai next_offset, bukan mengulang
  offset 0 dengan limit lebih besar. Hasil kosong pencarian desa bukan alasan
  melewatkan daftar tujuan kota yang sudah diketahui.
- Deduplicasikan kode tujuan: beberapa desa dapat memakai code yang sama,
  sehingga tidak perlu mengecek tarif berulang untuk code dan berat yang sama.
  Jangan membentuk kode kecamatan/kota lain dari pola angka kode yang terlihat.
  Setiap destination_code harus benar-benar ada di hasil MCP atau resolusi
  terverifikasi yang masih relevan dalam konteks, bukan dugaan dari nama wilayah.
- Untuk pertanyaan hanya lama pengiriman, dahulukan ETD yang terverifikasi;
  tidak perlu menawarkan semua harga/layanan atau meminta data order. Estimasi
  area yang sudah dicek harus jelas cakupannya, bukan klaim tarif/ETD pasti sama
  untuk seluruh kota/kabupaten ketika belum ada bukti. Jangan mengunci tarif
  final pada cart dari estimasi area tersebut.`

export const DESTINATION_GUIDE_V4 = `${DESTINATION_GUIDE_V3}

Batas pencarian untuk estimasi awal (bukan penetapan ongkir order):
- Pertanyaan "ke kota ini berapa lama" tidak memerlukan audit semua desa atau
  pengecekan tarif semua kecamatan. Berhenti membaca halaman jika acuan relevan
  sudah ditemukan; jangan mengejar kelengkapan seluruh daftar hanya untuk ETD.
- Bila tidak ada kode tingkat kota tetapi ada tujuan dalam area kota yang
  terverifikasi, boleh beri gambaran ETD dari satu acuan area yang jelas di MCP.
  Sebut cakupannya sebagai contoh/estimasi area, bukan memastikan alamat pelanggan
  ada di area itu atau semua kota/kabupaten sama. Cukup cek satu kode acuan yang
  relevan; kode kedua hanya bila perlu membandingkan cakupan. Jangan menyapu
  seluruh kecamatan, mengarang kode, atau mengganti tarif final/cart.
- Jawab pertanyaan waktu secara singkat dengan ETD yang benar-benar keluar.
  Tidak perlu menanyakan lagi kecamatan yang sudah ditanyakan dan tidak diketahui
  pelanggan. Klarifikasi alamat diperlukan untuk tarif final/alamat pengiriman,
  bukan sebagai syarat menyampaikan gambaran area yang diberi batasan jelas.`

export const DESTINATION_GUIDE = `Alur tujuan dan estimasi ongkir:
1. **Kode pos opsional untuk cek ongkir.** Baca tujuan dari riwayat, jawaban lanjutan,
   dan koreksi terbaru. Penegasan kota (termasuk typo ringan yang jelas dari konteks)
   bukan awal form baru. Jangan meminta ulang data yang sudah diberikan atau tidak
   diketahui pelanggan. Catatan/goal lama tidak mengalahkan koreksi atau skill kini.
2. Cari nama wilayah lewat MCP dengan skema aktual. Pada Orion, daftar tujuan ada
   di list_orion_data, resource destinations; search_destinations juga tersedia.
   Query memakai nama wilayah, bukan kode internal. Jika pencarian gabungan kosong,
   kembali ke kota yang ditegaskan pelanggan; jangan memaksakan kecamatan bernama
   sama di kota lain atau mengulang query kosong. Nama kota tidak otomatis kurang.
3. Hasil daftar Orion dipaginasi: records, count, total, has_more, next_offset.
   Server dapat membatasi hasil walaupun limit lebih besar. Jika kandidat relevan
   belum ditemukan, ikuti next_offset; jangan membaca offset 0 berulang. Berhenti
   ketika acuan cukup, tidak perlu membaca seluruh desa untuk estimasi awal.
4. Pisahkan pertanyaan estimasi awal dari tarif/alamat final order. Untuk sekadar
   lama kirim ke kota, gunakan tujuan tingkat kota yang cocok jika tersedia. Bila
   hanya ada tujuan per kecamatan, boleh beri gambaran ETD dari SATU acuan area
   dalam kota yang terverifikasi. Sebut cakupannya sebagai estimasi/contoh area,
   bukan memastikan alamat pelanggan di sana atau seluruh kabupaten bertarif sama.
   Tidak perlu cek semua kecamatan; kode kedua hanya untuk perbandingan relevan.
5. destination_code harus berasal dari hasil MCP atau resolusi terverifikasi yang
   masih sesuai konteks; jangan membentuk kode dari pola angka. Deduplicasikan kode
   karena beberapa desa dapat memakai kode sama. Panggil check_shipping_rates
   dengan berat sesuai skill. Kode pos bukan destination_code; jika kode pos untuk
   tujuan final tersedia dari MCP, boleh dilengkapi tanpa meminta pelanggan lagi.
6. Langsung jawab kebutuhan pelanggan: ETD jika bertanya lama kirim, pilihan tarif
   bila bertanya biaya. Gunakan hasil aktual dan gaya/format skill, bukan laporan
   "tujuan/kode pos ditemukan", daftar wilayah mentah, atau form order lengkap.
   Jika hasil kosong/gagal, jangan mengarang tarif/ETD atau otomatis handoff hanya
   karena kode pos tidak ada. Klarifikasi seperlunya bila tidak ada acuan relevan.
7. Untuk tarif final/order, cocokkan seluruh wilayah yang diketahui. Jika masih
   bertentangan/ambigu, minta SATU pembeda baru yang mudah diberikan, misalnya
   desa/kelurahan atau alamat teks, bukan mengulang kecamatan/kode pos yang sudah
   ditanyakan. Jangan memilih desa pertama atau mengunci cart dari estimasi area.
   Periksa ulang tarif bila alamat final/berat berbeda; jangan memakai tarif lama.
8. Simpan ringkas tujuan/code terverifikasi, cakupan estimasi atau alamat final,
   berat, serta kekurangan data nyata dalam note/goal. Koreksi tujuan membatalkan
   kandidat lama. Hapus kebutuhan menunggu kode pos/kecamatan yang tidak diperlukan
   dari waiting_for; gunakan kembali resolusi yang masih relevan pada giliran berikut.`

/** Exact, repeatable replacement: unrelated guidance and formatting stay intact. */
export function updateDestinationGuide(content: string) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const oldTexts = [
    OLD_DESTINATION_GUIDE,
    DESTINATION_GUIDE_V4,
    DESTINATION_GUIDE_V3,
    DESTINATION_GUIDE_V2,
    DESTINATION_GUIDE_V1,
  ].map((text) => text.replaceAll('\n', newline))
  const newText = DESTINATION_GUIDE.replaceAll('\n', newline)
  if (content.includes(newText) && !content.includes(oldTexts[0])) return content
  const oldText = oldTexts.find((text) => content.includes(text))
  if (!oldText)
    throw new Error('Bagian ongkir berbeda dari versi yang diperiksa; perubahan dibatalkan.')
  if (content.split(oldText).length !== 2)
    throw new Error('Bagian ongkir berbeda dari versi yang diperiksa; perubahan dibatalkan.')
  return content.replace(oldText, newText)
}

export default class UpdateShippingSkills extends BaseCommand {
  static commandName = 'skills:optional-postcode'
  static description = 'Koreksi terbatas panduan tujuan ongkir pada tiga skill terimpor'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Simpan perubahan; tanpa flag hanya pratinjau' })
  declare apply: boolean

  async run() {
    return withActiveWorkspace(() => this.runInWorkspace())
  }

  private async runInWorkspace() {
    await db.transaction(async (trx) => {
      const rows = await trx
        .from('whatsapp_skills')
        .whereIn('name', SHIPPING_SKILL_NAMES)
        .forUpdate()
      if (rows.length !== SHIPPING_SKILL_NAMES.length)
        throw new Error('Skill target tidak lengkap; tidak ada perubahan disimpan.')
      const patches = rows.map((row) => ({
        ...row,
        nextContent: updateDestinationGuide(row.content),
      }))
      for (const row of patches) {
        if (row.nextContent === row.content) {
          this.logger.info(`${row.name}: sudah sesuai`)
          continue
        }
        if (this.apply)
          await trx.from('whatsapp_skills').where('id', row.id).update({
            content: row.nextContent,
            updated_at: new Date(),
          })
        this.logger.info(`${row.name}: ${this.apply ? 'diperbarui' : 'siap diperbarui'}`)
      }
    })
  }
}
