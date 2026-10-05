// v3.6.36 — keputusan Jev dalam bahasa biasa untuk Settings → Usage → Jev accuracy:
// pertanyaan apa yang diajukan, arti jawabannya, dan akibatnya ke balasan/data — supaya CS
// bisa menilai Benar/Salah. Tidak memanggil AI apa pun (tanpa token). Teks tampilan English
// (aplikasi English-only sejak v3.6.26).

type Row = { decision: string; answer: string; detail?: string | null; used?: unknown }
type Info = {
  /** Pertanyaan ke Jev; sub = isi `detail` untuk keputusan yang punya beberapa pertanyaan (topik, harga). */
  question: (sub: string) => string
  /** Label pilihan jawaban (kunci jawaban → kata biasa). */
  labels?: Record<string, string>
  /** Akibat bila jawaban dipakai. */
  effect: (answer: string, sub: string) => string
  /** Pesan siapa yang dinilai. */
  source?: 'pelanggan' | 'toko' | 'gambar' | 'percakapan' | 'komentar'
}

const yesNo = { ya: 'Yes', tidak: 'No' }
const TOPIC_TEXT: Record<string, string> = {
  ongkir: 'shipping cost, address/destination, courier, or delivery time',
  ukuran: 'size, body measurements, height/weight, or trouser size',
  bayar: 'payment, down payment, bank account, transfer proof, or a paid order',
  custom: 'a custom request (own measurements, collar, pockets, buttons, model details)',
  warna: 'color, fabric, or product photos',
}

const TOPIC_NAME: Record<string, string> = { ongkir: 'shipping', ukuran: 'sizing', bayar: 'payment', custom: 'custom work', warna: 'colors/fabric' }

const INFO: Record<string, Info> = {
  maksud: {
    question: () => 'What is the main intent of this message?',
    labels: {
      sapaan: 'Greeting / thanks / ok',
      produk: 'Asks about model, color, stock, photo, fabric',
      harga: 'Asks about price / discount / total',
      ukuran: 'Size question',
      ongkir: 'Asks about shipping',
      data_pengiriman: 'Sends shipping details',
      bayar: 'About payment',
      status_pesanan: 'Asks about progress / tracking number',
      komplain: 'Complaint',
      lain: 'Other',
    },
    effect: (answer) =>
      answer === 'status_pesanan'
        ? 'The system looks up the tracking/order status for the AI reply.'
        : answer === 'komplain'
          ? 'Used to pick a more careful AI model.'
          : 'Used to pick the AI model and the data prepared for it.',
  },
  form: {
    question: () => 'Does this message contain shipping details (name, address, district/city, phone)?',
    labels: yesNo,
    effect: (answer) => (answer === 'ya' ? 'Saved as an order form; shipping cost is calculated.' : 'Not treated as an order form.'),
  },
  serah_cs: {
    question: () => 'Does this message need a human CS, and why?',
    labels: {
      komplain: 'Complaint about a paid order',
      ganti_alamat: 'Address change after payment',
      ekspedisi_lain: 'Wants a courier other than JNE',
      nego: 'Bargaining / asks for a discount',
      tidak_perlu: 'No CS needed',
    },
    effect: (answer) => (answer === 'tidak_perlu' ? 'The AI keeps replying.' : 'Chat handed to CS; the AI stops.'),
  },
  setuju: {
    question: () => "How did the customer respond to the store's last total/offer?",
    labels: { setuju: 'Agreed', menolak: 'Refused', bertanya: 'Still asking / unsure', lain: 'No response to it' },
    effect: (answer) => (answer === 'setuju' ? 'Counted as agreed; the AI moves to the next step.' : 'Not counted as agreed.'),
  },
  layanan: {
    question: () => 'Which shipping service did the customer choose?',
    labels: { belum: 'Not chosen yet' },
    effect: (answer) =>
      answer === 'belum' ? 'The AI asks for the service (REG/YES) before the total.' : `Total calculated with ${answer.toUpperCase()}.`,
  },
  tanggapan: {
    question: () => "What does this short message do in reply to the store's last message?",
    labels: { terima: 'Just an acknowledgement / ok', setuju: 'Agrees', jawab: "Answers the store's question", tanya: 'Asks something', lain: 'Other' },
    effect: (answer) => (answer === 'terima' ? 'The AI replies briefly (or stays quiet), no new questions.' : 'The AI replies as usual.'),
  },
  topik: {
    question: (sub) => `Is this message about ${TOPIC_TEXT[sub] || sub}?`,
    labels: yesNo,
    effect: (answer, sub) =>
      answer === 'ya'
        ? `Rules and data about ${TOPIC_NAME[sub] || sub} are given to the AI.`
        : `Rules about ${TOPIC_NAME[sub] || sub} are left out (saves tokens).`,
  },
  kesulitan: {
    question: () => 'How hard is it to answer this message correctly? (1 simple · 2 normal · 3 complex)',
    effect: () => 'Used to pick the AI model: harder means more careful.',
  },
  sudah_tf: {
    question: () => 'Does the customer say they have ALREADY paid/transferred?',
    labels: yesNo,
    effect: (answer) => (answer === 'ya' ? 'Chat goes into the Payment filter for CS to check.' : 'Not added to the Payment filter.'),
  },
  lanjut: {
    question: () => 'Is the customer postponing or cancelling the purchase?',
    labels: { lanjut: 'Still going ahead', tunda: 'Postponing', batal: 'Cancelling' },
    effect: (answer) =>
      answer === 'batal' ? 'Follow-ups stop; the unpaid order is closed.' : answer === 'tunda' ? 'Follow-ups stop.' : 'No change.',
  },
  urgensi: {
    question: () => 'How urgent is this message? (1 normal … 5 complaint/angry)',
    effect: () => 'A score of 4–5 marks the chat "Important" in the inbox.',
  },
  harga_konteks: {
    question: (sub) =>
      sub === 'seri' ? 'Which fabric series is being discussed (regular / signature / premium)?' : 'Which item is the price question about?',
    labels: {
      reguler: 'Regular', signature: 'Signature', premium: 'Premium', belum: 'Not clear yet',
      jas: 'Jacket only', celana: 'Trousers only', setelan: 'Suit (jacket + trousers)', rompi: 'Vest',
    },
    effect: () => 'Prices quoted by the AI are checked against this series/item.',
  },
  janji_total: {
    question: () => 'Does the AI reply promise to send the total/bank account?',
    labels: yesNo,
    source: 'toko',
    effect: (answer) => (answer === 'ya' ? 'The promise is removed when the system cannot send the total yet.' : 'Reply sent as is.'),
  },
  total_toko: {
    question: () => 'Does this store message state the amount to pay or the bank account?',
    labels: yesNo,
    source: 'toko',
    effect: (answer) => (answer === 'ya' ? 'Store counted as having sent the total; order set to awaiting payment.' : 'No total counted yet.'),
  },
  terjawab: {
    question: () => "How fully did the store answer the customer's questions? (1 not yet · 2 partly · 3 fully)",
    source: 'percakapan',
    effect: (answer) => (answer.endsWith('3') ? 'Chat no longer counted as "unanswered".' : 'Chat still counted as "unanswered".'),
  },
  varian: {
    question: (sub) => `Which color of ${sub || 'the product'} did the customer order?`,
    labels: { lain: 'Not in the catalog / unclear' },
    source: 'percakapan',
    effect: (answer) => (answer === 'lain' ? 'Color kept as written (custom).' : `Specs use catalog color ${answer}.`),
  },
  komentar_ig: {
    question: () => 'What kind of Instagram comment is this?',
    labels: { calon_pembeli: 'Potential buyer', pertanyaan: 'Other question', pujian: 'Praise / emoji', spam: 'Spam' },
    source: 'komentar',
    effect: (answer) => (['calon_pembeli', 'pertanyaan'].includes(answer) ? 'Comment gets a reply.' : 'Comment is not replied to.'),
  },
  warna_gambar: {
    question: () => "Which catalog color best matches the clothing in the customer's image?",
    labels: { lain: 'Not clothing / no match' },
    source: 'gambar',
    effect: (answer) => (answer === 'lain' ? 'Color not matched to the catalog.' : `The AI names color ${answer} and its price.`),
  },
  tujuan_baru: {
    question: () => 'Does this message give a NEW shipping destination (not the previous one)?',
    labels: yesNo,
    effect: (answer) => (answer === 'ya' ? 'Shipping cost recalculated to the new destination.' : 'Previous destination kept.'),
  },
  dana_masuk: {
    question: () => "Does the store message say the customer's payment HAS arrived?",
    labels: yesNo,
    source: 'toko',
    effect: (answer) => (answer === 'ya' ? 'Order marked paid.' : 'Order not marked paid.'),
  },
  bukti_transfer: {
    question: () => "Is the customer's image a PAYMENT PROOF (not a photo of a suit/model/size)?",
    labels: yesNo,
    source: 'gambar',
    effect: (answer) => (answer === 'ya' ? 'Chat gets the Payment mark for CS to check.' : 'Image not treated as payment proof.'),
  },
  kirim_sendiri: {
    question: () => 'Does the store message say the order is delivered by the team / picked up (no tracking number)?',
    labels: yesNo,
    source: 'toko',
    effect: (answer) => (answer === 'ya' ? 'Order marked Done (delivered by team, no tracking number).' : 'Not marked as delivered.'),
  },
  peran_kontak: {
    question: () => 'Who is this contact to the store?',
    labels: { pelanggan: 'Customer', vendor: 'Vendor / fabric supplier', lainnya: 'Other (team, personal, spam)' },
    source: 'percakapan',
    effect: (answer) =>
      answer === 'pelanggan' ? 'Kept as a customer.' : 'Marked vendor/other: the AI does not reply, orders go to the Vendor tab.',
  },
}

const SOURCE_LABEL: Record<string, string> = {
  pelanggan: 'Customer message',
  toko: 'Store message',
  gambar: 'Customer image',
  percakapan: 'Conversation',
  komentar: 'Instagram comment',
}

/** Kunci jawaban sebagai teks biasa ("ya" → "Yes", "status_pesanan" → "Asks about progress…"). */
export function answerLabel(decision: string, answer: string, sub = '') {
  const info = INFO[decision]
  void sub
  return info?.labels?.[answer] || answer.replace(/_/g, ' ')
}

/** Penjelasan satu baris log keputusan Jev untuk ditampilkan ke CS. */
export function explainDecision(row: Row) {
  const info = INFO[row.decision]
  const sub = ['topik', 'harga_konteks', 'varian'].includes(row.decision) ? String(row.detail || '') : ''
  const answer = String(row.answer || '')
  const used = Boolean(Number(row.used))
  return {
    question: info ? info.question(sub) : row.decision,
    answer_label: answerLabel(row.decision, answer, sub),
    effect: !used
      ? 'Jev was unsure — the system used the old word rules; this answer was not used.'
      : info
        ? info.effect(answer, sub)
        : '',
    source_label: SOURCE_LABEL[info?.source || 'pelanggan'],
    /** Pilihan jawaban yang bisa dipilih CS saat menandai Salah (kunci → label). */
    options: info?.labels ? info.labels : null,
    money: ['dana_masuk', 'bukti_transfer', 'total_toko', 'layanan'].includes(row.decision),
  }
}
