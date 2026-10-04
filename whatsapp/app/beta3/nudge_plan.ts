// Beta 3.5 — susulan menuju pembelian. Goal chat = order: selama pelanggan belum order/bayar,
// setiap giliran yang berhenti di pelanggan punya susulan. AI menulisnya sendiri; bila kosong,
// sistem memakai kalimat bawaan per tahap (tanpa token). Tidak mengulang pertanyaan balasan terakhir.

type Step = { main: string; ask: RegExp; alt: string }

const STEPS: Record<string, Step> = {
  browse: {
    main: 'Kalau sudah ada yang cocok, kirim tinggi & berat badannya ya {a}, nanti saya bantu pilihkan size-nya',
    ask: /tinggi|berat|size|ukuran/i,
    alt: 'Kalau sudah cocok, langsung saya bantu proses pesanannya ya {a}',
  },
  tanya_size: {
    main: 'Kalau size-nya sudah pas, kirim nama & alamat lengkapnya ya {a}, nanti saya hitungkan totalnya sekalian ongkir',
    ask: /alamat|nama|ongkir/i,
    alt: 'Ditunggu ya {a}, begitu alamatnya masuk totalnya langsung saya kirim',
  },
  tawar_celana: {
    main: 'Celananya mau sekalian {a}? Biar bahan dan warnanya sama dengan jasnya',
    ask: /celana/i,
    alt: 'Kalau jasnya saja juga bisa {a}, tinggal kirim nama & alamat lengkapnya untuk cek ongkir',
  },
  form: {
    main: 'Ditunggu nama & alamat lengkapnya ya {a}, nanti totalnya saya kirim sekalian ongkir',
    ask: /alamat|form|data|nama/i,
    alt: 'Kalau datanya sudah siap, kirim saja ya {a}, totalnya langsung saya hitungkan',
  },
  tunggu_bayar: {
    main: 'Kalau sudah transfer, kirim buktinya ya {a} biar pesanan langsung kami proses',
    ask: /bukti|transfer|tf\b/i,
    alt: 'Pesanannya kami tahan dulu ya {a}, begitu transfer masuk langsung kami proses',
  },
}

const STAGE_STEP: Record<string, keyof typeof STEPS> = {
  tanya_model: 'browse',
  tanya_size: 'tanya_size',
  tawar_celana: 'tawar_celana',
  minta_alamat: 'form',
  kirim_form: 'form',
  tunggu_form: 'form',
  tunggu_bayar: 'tunggu_bayar',
}

/** Obrolan belanja (produk/harga/size) — tahap "lain" tetap disusul bila ini benar. */
export const SHOPPING_TALK = /\b(jas|celana|setelan|stelan|set|suit|tuxedo|beskap|bescap|rompi|vest|harga|size|ukuran|premium|signature|order|pesan)\b|\d{1,3}\.\d{3}/i

/**
 * Susulan bawaan untuk tahap ini, atau kosong bila tahap tidak perlu disusul (selesai, menunggu CS,
 * bukti sudah dikirim). `lastBubble` = pesan toko terakhir; pertanyaan yang sama tidak diulang.
 */
export function purchaseNudge(stage: string, lastBubble: string, shopping: boolean, address = 'bos') {
  const key = STAGE_STEP[stage] || (stage === 'lain' && shopping ? 'browse' : null)
  if (!key) return ''
  const step = STEPS[key]
  const text = step.ask.test(lastBubble) ? step.alt : step.main
  return text.replace('{a}', address)
}
