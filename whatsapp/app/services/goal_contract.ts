import { DateTime } from 'luxon'
import { SEMANTIC_GOAL_INSTRUCTIONS } from '#services/semantic_intent_contract'

export type FollowUpPolicy = {
  skill_name: string
  reason: string
  first_delay_hours: number
  repeat_delay_hours: number
  max_attempts: number
  send_start_hour: number
  send_end_hour: number
  time_zone: string
}

export type GoalPlan = {
  /** Turn-level lifecycle assessment; optional for older stored/internal plans. */
  stage?: 'discovery' | 'selection' | 'checkout' | 'fulfillment' | 'service' | 'closed'
  current_task?: string
  objective: string
  status:
    'active' | 'waiting' | 'waiting_answer' | 'waiting_payment' | 'waiting_approval' | 'completed'
  waiting_for: string
  next_action: string
  follow_up: FollowUpPolicy | null
}

export const GOAL_SCHEMA = {
  description: SEMANTIC_GOAL_INSTRUCTIONS,
  type: 'object',
  additionalProperties: false,
  properties: {
    objective: {
      type: 'string',
      description: 'Tujuan menyeluruh percakapan pelanggan. Untuk calon pembeli: aktif membantu memilih, mengatasi keraguan, melengkapi data dan menyiapkan konfirmasi pemesanan sesuai kebutuhan; bukan hanya mengirim foto/menjawab harga. Pengumpulan data tidak menunggu izin checkout; transaksi tetap memerlukan persetujuan yang sah. Hormati penundaan/penolakan.',
    },
    stage: {
      type: 'string',
      enum: ['discovery', 'selection', 'checkout', 'fulfillment', 'service', 'closed'],
      description: 'discovery: melihat model/foto; selection: memilih warna/ukuran; checkout: melengkapi/menyetujui pesanan atau pembayaran; fulfillment: order nyata masih diproses; service: kebutuhan layanan belum tuntas; closed: tujuan benar-benar tuntas atau pelanggan memutuskan tidak lanjut. Mengirim foto bukan closed. Order lama tidak menutup minat pembelian baru.',
    },
    current_task: {
      type: 'string',
      description: 'Permintaan kecil pada giliran ini, misalnya mengirim foto beskap Brown; terpisah dari objective. Selesainya tugas ini tidak otomatis menutup goal.',
    },
    status: {
      type: 'string',
      enum: [
        'active',
        'waiting',
        'waiting_answer',
        'waiting_payment',
        'waiting_approval',
        'completed',
      ],
    },
    waiting_for: {
      type: 'string',
      description: 'Kebutuhan nyata yang sudah dikomunikasikan dan masih menunggu jawaban/hasil; jangan menciptakan kebutuhan konfirmasi lanjut sebelum meminta data yang kurang. Kosong jika tidak ada.',
    },
    next_action: {
      type: 'string',
      description: 'Langkah berikutnya sesuai skill dan keadaan nyata, internal saja.',
    },
    follow_up: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            skill_name: { type: 'string' },
            reason: {
              type: 'string',
              description:
                'Sebut aturan skill dan bukti chat yang mengizinkan susulan tanpa pesan baru.',
            },
            first_delay_hours: { type: 'number', minimum: 1 },
            repeat_delay_hours: { type: 'number', minimum: 1 },
            max_attempts: { type: 'integer', minimum: 1, maximum: 10 },
            send_start_hour: { type: 'integer', minimum: 0, maximum: 23 },
            send_end_hour: { type: 'integer', minimum: 1, maximum: 24 },
            time_zone: {
              type: 'string',
              description: 'Zona IANA untuk jam kirim pada skill, misalnya Asia/Jakarta untuk WIB.',
            },
          },
          required: [
            'skill_name',
            'reason',
            'first_delay_hours',
            'repeat_delay_hours',
            'max_attempts',
            'send_start_hour',
            'send_end_hour',
            'time_zone',
          ],
        },
      ],
    },
  },
  required: ['objective', 'stage', 'current_task', 'status', 'waiting_for', 'next_action', 'follow_up'],
} as const

export const GOAL_RUNTIME_INSTRUCTIONS = `KONTRAK APLIKASI — GOAL PER PELANGGAN:
Setiap giliran perbarui goal berdasarkan konteks dan seluruh skill terimpor. Goal, waiting_for, next_action, reason, dan note adalah metadata internal, bukan pesan pelanggan.
Pisahkan tujuan menyeluruh (objective), tahap perjalanan (stage), dan tugas giliran ini (current_task). Permintaan melihat model/foto, harga, stok, warna, ukuran atau ongkir merupakan langkah dalam memilih produk; selesai menjawabnya bukan bukti bahwa tujuan percakapan selesai. Pertahankan tujuan membantu pelanggan menemukan produk yang sesuai hingga keputusan pemesanan, tanpa menganggap minat sebagai persetujuan membeli. Goal lama yang completed hanya karena foto/harga sudah diberikan boleh dikoreksi pada giliran relevan berikutnya; jangan menjadikan status lama alasan menghentikan bantuan.
Selama discovery/selection gunakan waiting_answer setelah jawaban dan inisiatif terkirim: menunggu tanggapan/pilihan pelanggan, bukan completed. Catat yang benar-benar belum diketahui pada waiting_for dan langkah kontekstual pada next_action. completed hanya untuk stage closed dengan bukti tujuan tuntas atau pelanggan tidak lanjut; bukan karena balasan terakhir sukses, pelanggan diam, atau berkata terima kasih yang hanya menutup subpertanyaan. Jika pelanggan memang hanya ingin informasi dan jelas menutup percakapan, hormati penutupnya. Jangan membuka ulang order lama atau menutup minat baru berdasarkan order terdahulu. Tahap checkout/fulfillment tetap mengikuti hasil cart/order/pembayaran nyata, bukan ucapan AI.
Status waiting_answer untuk jawaban pelanggan, waiting_payment untuk pembayaran, waiting_approval untuk keputusan internal manusia; completed jika selesai. waiting tetap diterima untuk kompatibilitas. waiting_approval tidak mengirim susulan otomatis. Status menunggu bukan instruksi handoff.
message adalah balasan utama. Sebagai CS aktif, bantu kemajuan pembelian yang sesuai kebutuhan: memilih produk, mengatasi keraguan, melengkapi data, menyiapkan rekap dan langkah pembayaran yang sah. Pilih satu inisiatif relevan menurut konteks dan skill, lalu taruh teksnya pada initiative: aplikasi mengirimkannya sebagai CHAT TERPISAH setelah balasan utama. Jangan menempelkan atau mengulang inisiatif di message. Pertanyaan yang memang diperlukan untuk menjawab/memilih opsi tetap bagian balasan utama. Tidak ada inisiatif yang cocok: initiative kosong, jangan memaksakan pertanyaan penutup. Jangan memakai "kalau jadi pesan" atau menunggu "konfirmasi lanjut" sebagai syarat melengkapi data setelah pilihan disepakati; otorisasi transaksi diperiksa saat tindakan transaksi, bukan untuk menghalangi pertanyaan data.
Sebelum menyelesaikan keluaran, periksa kebutuhan pelanggan yang baru selesai dan langkah berikutnya dari skill. Jangan sekadar menyimpan tindakan yang sudah bisa dilakukan sekarang di goal.next_action lalu menunggu pelanggan meminta lagi. Jika prasyarat sudah terpenuhi dan langkah itu memang perlu dikomunikasikan, isi initiative dengan satu langkah konkret, bukan ajakan generik seperti "Mau lanjut?". Jika ada jawaban utama dan pertanyaan untuk langkah berikutnya, pisahkan ke message dan initiative; newline dalam message tidak membuat chat terpisah. Jangan meminta data yang sudah ada, mengulang pertanyaan yang masih menunggu jawaban, atau melanjutkan langkah yang bergantung pada jawaban belum diterima. Review internal tanpa perubahan tidak membenarkan pengiriman ulang; aturan sekali kirim, persetujuan manusia, dan larangan susulan tetap berlaku.
Khusus permintaan foto produk yang tersedia: jawab dengan gambar terverifikasi di images dan caption seperlunya, lalu pilih paling banyak SATU pertanyaan lanjutan yang berguna menurut skill pada initiative. Balasan utama berupa gambar saja tetap boleh diikuti initiative terpisah. Contoh konteks (bukan template wajib): pelanggan meminta foto beskap Brown dan ukuran belum diketahui → kirim foto Brown dahulu, lalu tanyakan ukuran yang biasa dipakai dengan bahasa skill; stage selection, status waiting_answer. Jika ukuran sudah diketahui, jangan tanyakan lagi: gunakan kebutuhan berikutnya yang memang relevan. Jika sebelumnya sudah ada pertanyaan belum dijawab, pelanggan meminta hanya foto/tidak ingin ditanya, menunda/menolak, atau tidak ada langkah berguna, initiative kosong. Jangan menyisipkan daftar pertanyaan, promosi generik, mendorong transfer sebelum pilihan pasti, atau mengirim foto alternatif yang tidak diminta. Goal tetap menunggu walau initiative kosong; menunggu bukan izin mengirim lagi.
Jadwal susulan berbeda dari inisiatif langsung. follow_up hanya diisi jika skill secara eksplisit mengizinkan mengirim tanpa pesan pelanggan baru, dan syarat nyata pada chat terpenuhi. Salin jeda, batas, dan jam kirim dari skill yang disebut skill_name; jelaskan buktinya pada reason. Tanpa izin/syarat tersebut: follow_up null. active atau completed tidak menjadwalkan apa pun; waiting, waiting_answer, atau waiting_payment dengan waiting_for dan follow_up valid dapat dijadwalkan.
Gunakan jumlah percobaan susulan dari state aplikasi; jangan mereset jumlah itu karena topik, goal, atau giliran berganti. Pesan pelanggan baru membatalkan jadwal lama: evaluasi kebutuhan baru dari awal. Jika menunda, menolak, selesai, atau membutuhkan manusia, hentikan jadwal sesuai skill.
Pada PEMICU SUSULAN TERJADWAL tidak ada pesan pelanggan baru. Evaluasi ulang skill dan data bisnis sebelum mengirim; paling banyak SATU pesan melalui message, initiative harus kosong. Jika sudah tidak relevan, silent dan follow_up null. Jangan membuat percakapan otomatis yang terus mengirim tanpa batas.`

export function parseGoal(value: unknown): GoalPlan | undefined {
  if (value === undefined || value === null) return undefined
  const goal = value as GoalPlan
  if (
    !goal ||
    ![
      'active',
      'waiting',
      'waiting_answer',
      'waiting_payment',
      'waiting_approval',
      'completed',
    ].includes(goal.status)
  )
    throw new Error('Status tujuan percakapan tidak valid.')
  for (const field of ['objective', 'waiting_for', 'next_action'] as const)
    if (typeof goal[field] !== 'string') throw new Error('Tujuan percakapan tidak valid.')
  if (goal.stage !== undefined && !['discovery', 'selection', 'checkout', 'fulfillment', 'service', 'closed'].includes(goal.stage))
    throw new Error('Tahap tujuan percakapan tidak valid.')
  if (goal.current_task !== undefined && typeof goal.current_task !== 'string')
    throw new Error('Tugas tujuan percakapan tidak valid.')
  const plan: GoalPlan = {
    ...(goal.stage ? { stage: goal.stage } : {}),
    ...(goal.current_task !== undefined ? { current_task: goal.current_task.trim().slice(0, 1000) } : {}),
    objective: goal.objective.trim().slice(0, 2000),
    status: goal.status,
    waiting_for: goal.waiting_for.trim().slice(0, 1000),
    next_action: goal.next_action.trim().slice(0, 2000),
    follow_up: validPolicy(goal.follow_up) ? goal.follow_up : null,
  }
  // A completed media/tool task is not a closed customer journey. This guard changes
  // internal state only: no invented customer question, send, checkout or timer.
  if (plan.status === 'completed' && plan.stage && plan.stage !== 'closed') {
    const choosing = ['discovery', 'selection'].includes(plan.stage)
    plan.status = choosing ? 'waiting_answer' : 'waiting'
    plan.waiting_for ||= choosing
      ? 'Tanggapan pelanggan terhadap produk yang ditampilkan'
      : 'Penyelesaian kebutuhan percakapan yang masih terbuka'
    plan.next_action ||= choosing
      ? 'Lanjutkan pilihan produk sesuai tanggapan pelanggan dan skill; jangan ulangi pertanyaan yang sudah dijawab atau masih menunggu.'
      : 'Periksa konteks dan state terverifikasi sebelum melanjutkan sesuai skill.'
    plan.follow_up = null
  }
  return plan
}

export function validPolicy(policy: FollowUpPolicy | null | undefined): policy is FollowUpPolicy {
  if (!policy || typeof policy !== 'object') return false
  return Boolean(
    typeof policy.skill_name === 'string' &&
    policy.skill_name.trim() &&
    typeof policy.reason === 'string' &&
    policy.reason.trim() &&
    Number.isFinite(policy.first_delay_hours) &&
    policy.first_delay_hours >= 1 &&
    Number.isFinite(policy.repeat_delay_hours) &&
    policy.repeat_delay_hours >= 1 &&
    Number.isInteger(policy.max_attempts) &&
    policy.max_attempts >= 1 &&
    policy.max_attempts <= 10 &&
    Number.isInteger(policy.send_start_hour) &&
    policy.send_start_hour >= 0 &&
    Number.isInteger(policy.send_end_hour) &&
    policy.send_end_hour <= 24 &&
    policy.send_start_hour < policy.send_end_hour &&
    typeof policy.time_zone === 'string' &&
    DateTime.now().setZone(policy.time_zone).isValid
  )
}

export function nextFollowUpAt(
  policy: FollowUpPolicy,
  attempts: number,
  lastMessage: Date,
  lastAttempt: Date | null,
  now = new Date()
) {
  if (!validPolicy(policy) || attempts >= policy.max_attempts) return null
  const base = attempts && lastAttempt ? lastAttempt : lastMessage
  const hours = attempts ? policy.repeat_delay_hours : policy.first_delay_hours
  let due = DateTime.fromJSDate(
    new Date(Math.max(base.getTime() + hours * 3_600_000, now.getTime()))
  ).setZone(policy.time_zone)
  if (due.hour >= policy.send_end_hour)
    due = due.plus({ days: 1 }).startOf('day').set({ hour: policy.send_start_hour })
  else if (due.hour < policy.send_start_hour)
    due = due.startOf('day').set({ hour: policy.send_start_hour })
  return due.isValid ? due.toJSDate() : null
}

export function withinSendingHours(policy: FollowUpPolicy, now = new Date()) {
  if (!validPolicy(policy)) return false
  const hour = DateTime.fromJSDate(now).setZone(policy.time_zone).hour
  return hour >= policy.send_start_hour && hour < policy.send_end_hour
}
