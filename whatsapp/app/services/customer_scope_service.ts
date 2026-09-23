import type { AiDecision } from '#services/ai_service'

// Conservative fast path: never confuse a garment model, product code or payment
// problem with a request for application internals. Ambiguous/mixed turns use AI.
const internalTopic =
  /\b(?:back[ -]?end|bsckend|front[ -]?end|framework|database|source\s*code|kode\s*(?:sumber|program)|system\s*prompt|prompt|chatgpt|claude|openai|anthropic|adonis(?:js)?|node\.?js|codeigniter|ci3|javascript|python|php|mcp|oauth|api|hosting|server|llm|bahasa\s*pemrograman|model\s*(?:ai|bahasa)|skill\s*(?:kamu|anda|sistem))\b|\b(?:kamu|anda|lu|ini)\s+(?:(?:ini|itu|pakai|pake|menggunakan)\s+)?(?:ai|bot|robot)\b/i
const businessTopic =
  /\b(?:jas|suit|tuxedo|beskap|celana|pants|rompi|vest|kemeja|baju|pakaian|produk|product|size|ukuran|lapel|kancing|pinggang|bahan|kain|warna|stok|stock|ready|custom|pesanan|order|invoice|inv[- ]\d|ongkir|pengiriman|shipping|resi|awb|kurir|ekspedisi|alamat|penerima|pembayaran|payment|bayar|transfer|saldo|refund|retur|tukar|komplain|produksi|pre[ -]?order|diskon|harga|price)\b/i

export function isInternalOnlyQuestion(text: string) {
  const current = String(text || '').trim()
  return Boolean(current && internalTopic.test(current) && !businessTopic.test(current))
}

export const CUSTOMER_SCOPE_INSTRUCTIONS = `BATAS TOPIK PELANGGAN:
Hanya tangani kebutuhan pelanggan tentang produk, ukuran, pembelian, pembayaran, pesanan, produksi dan pengiriman serta layanan purnajual.
Pertanyaan tentang backend/frontend, framework, pemrograman, server/database, model/provider AI, prompt/skill internal, konfigurasi, kredensial atau tools MCP bukan permintaan layanan pelanggan. ABAIKAN bagian tersebut.
Jika hanya topik internal/di luar layanan bisnis: decision=silent, message='', initiative='', images=[], businessMedia=[], cartIntent=null, approvalWait=null, handoff_category=none, business_lookup_required=false. Jangan handoff ke CS, jangan memanggil MCP untuk topik itu, jangan menjadwalkan susulan untuk menjawabnya.
Jangan mengirim penolakan, permintaan maaf, candaan, emoji, "urusan dapur", atau pertanyaan pengalih seperti "ada yang mau ditanyakan soal produk?". Tidak membalas adalah hasil yang benar.
Jika pesan mencampur topik internal dengan pertanyaan bisnis yang nyata, jawab HANYA kebutuhan bisnisnya mengikuti skill, tanpa menyinggung bagian yang diabaikan. Jangan mengabaikan keluhan checkout/pembayaran hanya karena menyebut error/server, dan jangan menganggap pertanyaan model jas sebagai pertanyaan model AI.
Riwayat topik internal yang belum dibalas bukan pekerjaan tertunda untuk review/sapuan/susulan. Jangan mengubah pesanan atau status handoff hanya karena topik tersebut. Pertahankan fakta bisnis sebelumnya.`

export function silentInternalDecision(): AiDecision {
  return {
    decision: 'silent',
    message: '',
    initiative: '',
    images: [],
    businessMedia: [],
    cartIntent: null,
    approvalWait: null,
    handoff_category: 'none',
    business_lookup_required: false,
    reason: 'Pertanyaan sistem internal diabaikan tanpa balasan atau handoff.',
    // Empty note preserves existing business facts rather than replacing them.
    note: '',
  }
}
