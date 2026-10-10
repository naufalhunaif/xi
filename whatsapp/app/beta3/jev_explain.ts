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
  /** v3.6.130: pilihan per sub-pertanyaan (cek_balasan, hati) — dulu semua pilihan tercampur. */
  labelsFor?: (sub: string) => Record<string, string> | null
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
    labelsFor: () => ({ 'tingkat 1': '1 · simple', 'tingkat 2': '2 · normal', 'tingkat 3': '3 · complex' }),
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
    labelsFor: () => ({ 'tingkat 1': '1 · normal', 'tingkat 2': '2', 'tingkat 3': '3', 'tingkat 4': '4 · important', 'tingkat 5': '5 · complaint / angry' }),
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
  hati: {
    question: (sub) =>
      sub === 'rasa'
        ? "How does the customer feel in this message (read literally)?"
        : sub === 'momen'
          ? 'Does the customer mention an important occasion (wedding, graduation, new job)?'
          : 'Is the customer asking, requesting, complaining, or just chatting?',
    labels: {
      bertanya: 'Asking', meminta: 'Requesting', mengeluh: 'Complaining', basa_basi: 'Small talk', lain: 'Other',
      netral: 'Neutral', senang: 'Happy', ragu: 'Unsure / worried', buru_buru: 'In a hurry', kesal: 'Annoyed / disappointed',
      keberatan_harga: 'Finds it expensive', pamit: 'Leaving / not now',
      tidak_ada: 'No occasion', nikah: 'Wedding', wisuda: 'Graduation', kerja: 'New job / interview', acara_lain: 'Other event',
    },
    labelsFor: (sub): Record<string, string> =>
      sub === 'rasa'
        ? { netral: 'Neutral', senang: 'Happy', ragu: 'Unsure / worried', buru_buru: 'In a hurry', kesal: 'Annoyed / disappointed', keberatan_harga: 'Finds it expensive', pamit: 'Leaving / not now' }
        : sub === 'momen'
          ? { tidak_ada: 'No occasion', nikah: 'Wedding', wisuda: 'Graduation', kerja: 'New job / interview', acara_lain: 'Other event' }
          : { bertanya: 'Asking', meminta: 'Requesting', mengeluh: 'Complaining', basa_basi: 'Small talk', lain: 'Other' },
    effect: () => 'The AI gets a short "HATI" note so it answers the feeling first (hint only, no data changes).',
  },
  cek_balasan: {
    question: (sub) =>
      sub === 'foto'
        ? 'Do the photos sent match what the AI reply says and what the customer asked?'
        : sub === 'jawab'
          ? "How well does the AI reply answer what the customer means? (1 missed · 2 partly · 3 fully)"
          : sub === 'fakta'
            ? 'Do the prices, colors and ready sizes in the AI reply match the catalog?'
            : sub === 'susulan'
              ? 'Should this follow-up be sent if the customer stays quiet?'
              : 'Does the AI reply repeat a question or something already said?',
    labels: {
      sesuai: 'Matches', kurang: 'Promised photos missing', lebih: 'Extra photos', beda: 'Different product/color',
      bertentangan: 'Contradicts the catalog', tidak_bisa_dinilai: 'Cannot be checked', ya: 'Yes', tidak: 'No',
      kirim: 'Send it', jangan: "Don't send", kaku: 'Needed but sounds robotic',
    },
    labelsFor: (sub): Record<string, string> =>
      sub === 'foto'
        ? { sesuai: 'Matches', kurang: 'Promised photos missing', lebih: 'Extra photos', beda: 'Different product/color' }
        : sub === 'fakta'
          ? { sesuai: 'Matches', bertentangan: 'Contradicts the catalog', tidak_bisa_dinilai: 'Cannot be checked' }
          : sub === 'susulan'
            ? { kirim: 'Send it', jangan: "Don't send", kaku: 'Needed but sounds robotic' }
            : sub === 'jawab'
              ? { 'tingkat 1': '1 · missed', 'tingkat 2': '2 · partly', 'tingkat 3': '3 · fully' }
              : yesNo,
    source: 'toko',
    effect: () => 'Checked before sending. A confident problem makes the AI rewrite the reply once with the checker note.',
  },
  minta_rekening: {
    question: () => 'Is the customer asking for the bank account number?',
    labels: yesNo,
    effect: (answer) => (answer === 'ya' ? 'The official payment details from Settings are added to the reply.' : 'Nothing changes.'),
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

/**
 * Jawaban Jev sebagai satu kalimat biasa (v3.6.37) — dibaca seperti balasan atas pesan di atasnya,
 * tanpa perlu membaca pertanyaan teknisnya dulu.
 */
const yn = (yes: string, no: string) => (answer: string) => (answer === 'ya' ? yes : no)
const SAY: Record<string, (answer: string, label: string, sub: string) => string> = {
  maksud: (answer, label) =>
    ({
      sapaan: "It's a greeting / thanks / ok.",
      produk: 'The customer asks about a product (model, color, stock, photo, fabric).',
      harga: 'The customer asks about price / discount / total.',
      ukuran: 'The customer asks about size.',
      ongkir: 'The customer asks about shipping.',
      data_pengiriman: 'The customer sends shipping details.',
      bayar: 'This is about payment.',
      status_pesanan: 'The customer asks about order progress / tracking.',
      komplain: 'The customer is complaining.',
      lain: 'Something else (no specific topic).',
    })[answer] || label,
  form: yn('These are shipping details for an order.', 'These are not shipping details.'),
  serah_cs: (answer, label) => (answer === 'tidak_perlu' ? 'The AI can handle this, no CS needed.' : `A CS person should handle this: ${label.toLowerCase()}.`),
  setuju: (answer, label) => (answer === 'setuju' ? 'The customer agrees to the total/offer.' : `The customer has not agreed: ${label.toLowerCase()}.`),
  layanan: (answer) => (answer === 'belum' ? 'The customer has not chosen a shipping service yet.' : `The customer chose ${answer.toUpperCase()} shipping.`),
  tanggapan: (answer, label) =>
    ({ terima: "It's just an ok / thanks, nothing to answer.", setuju: 'The customer agrees.', jawab: "The customer answers the store's question.", tanya: 'The customer asks something.', lain: 'Something else.' })[answer] || label,
  topik: (answer, _label, sub) => (answer === 'ya' ? `This is about ${TOPIC_NAME[sub] || sub}.` : `This is not about ${TOPIC_NAME[sub] || sub}.`),
  kesulitan: (answer) => `Difficulty to answer: ${answer === '3' ? 'complex' : answer === '1' ? 'simple' : 'normal'}.`,
  sudah_tf: yn('The customer says they have already paid.', 'The customer has not said they paid.'),
  lanjut: (answer) => (answer === 'batal' ? 'The customer is cancelling.' : answer === 'tunda' ? 'The customer is postponing.' : 'The customer is still going ahead.'),
  urgensi: (answer) => `Urgency ${answer} of 5${Number(answer) >= 4 ? ' — needs attention.' : '.'}`,
  harga_konteks: (_a, label, sub) => (sub === 'seri' ? `The fabric series discussed is ${label}.` : `The price question is about: ${label.toLowerCase()}.`),
  hati: (_answer, label, sub) =>
    sub === 'rasa' ? `Customer feeling: ${label.toLowerCase()}.` : sub === 'momen' ? `Occasion: ${label.toLowerCase()}.` : `Message type: ${label.toLowerCase()}.`,
  janji_total: yn('This AI reply promises to send the total/bank account.', 'This AI reply makes no promise about the total.'),
  total_toko: yn('The store sent the total to pay / bank account here.', 'The store did not send a total here.'),
  terjawab: (answer) => (answer.endsWith('3') ? "The store answered all the customer's questions." : answer.endsWith('2') ? 'The store answered only part of the questions.' : "The store hasn't answered the questions yet."),
  varian: (answer, label) => (answer === 'lain' ? 'The color is not in the catalog (custom).' : `The customer ordered color ${label}.`),
  komentar_ig: (_a, label) => `This comment is: ${label.toLowerCase()}.`,
  warna_gambar: (answer, label) => (answer === 'lain' ? 'No catalog color matches this image.' : `The clothing in the image is color ${label}.`),
  tujuan_baru: yn('The customer gave a new shipping destination.', 'Same destination as before.'),
  dana_masuk: yn("The store confirms the customer's payment has arrived.", 'The store has not confirmed payment.'),
  bukti_transfer: yn('This image is a payment proof.', 'This image is not a payment proof.'),
  kirim_sendiri: yn('The order is delivered by the team / picked up (no tracking number).', 'Not a team delivery.'),
  peran_kontak: (answer) => (answer === 'vendor' ? 'This contact is a vendor / supplier.' : answer === 'lainnya' ? 'This contact is not a customer (team, personal, spam).' : 'This contact is a customer.'),
}

const SOURCE_LABEL: Record<string, string> = {
  pelanggan: 'Customer',
  toko: 'Store',
  gambar: 'Customer (image)',
  percakapan: 'Chat',
  komentar: 'Instagram comment',
}

/** Pesan siapa yang dinilai keputusan ini (untuk mengambil pesan asli pada log lama). */
export function decisionSource(decision: string) {
  return INFO[decision]?.source || 'pelanggan'
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
  const sub = ['topik', 'harga_konteks', 'varian', 'hati', 'cek_balasan'].includes(row.decision) ? String(row.detail || '') : ''
  const answer = String(row.answer || '')
  const used = Boolean(Number(row.used))
  return {
    question: info ? info.question(sub) : row.decision,
    answer_label: answerLabel(row.decision, answer, sub),
    /** Jawaban Jev sebagai kalimat (dibaca langsung di bawah pesan). */
    says: SAY[row.decision]?.(answer, answerLabel(row.decision, answer, sub), sub) || answerLabel(row.decision, answer, sub),
    effect: !used
      ? 'Jev was unsure, so this answer was not used.'
      : info
        ? info.effect(answer, sub)
        : '',
    source_label: SOURCE_LABEL[info?.source || 'pelanggan'],
    /** Pilihan jawaban yang bisa dipilih CS saat menandai Salah (kunci → label). */
    options: info?.labelsFor?.(sub) || info?.labels || null,
    money: ['dana_masuk', 'bukti_transfer', 'total_toko', 'layanan'].includes(row.decision),
  }
}
