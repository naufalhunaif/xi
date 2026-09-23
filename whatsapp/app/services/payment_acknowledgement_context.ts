type PaymentEvent = {
  id: number
  jid: string
  action: string
  created_at: Date | string
  summary_json: string
}

type PaymentOrder = {
  id: number
  jid: string
  number: string
  total: number
  paid: number
  balance: number
  status: string
  operations?: {
    stage: string
    source: string
    estimate: unknown
    eligibleAt: string | null
    expectedReadyOn: string | null
  } | null
}

/** Link committed receipts to current order state, including orders outside the five-item preview. */
export function paymentAcknowledgementContext(
  jid: string,
  events: PaymentEvent[],
  orders: PaymentOrder[]
) {
  const receipts = events.flatMap((event) => {
    if (event.jid !== jid || event.action !== 'payment_confirmed') return []
    let summary: any
    try {
      summary = JSON.parse(event.summary_json)
    } catch {
      return []
    }
    if (
      !summary ||
      typeof summary.orderNumber !== 'string' ||
      !summary.orderNumber.trim() ||
      !Number.isSafeInteger(summary.amount) ||
      summary.amount < 0 ||
      (summary.balanceApplied !== undefined &&
        (!Number.isSafeInteger(summary.balanceApplied) || summary.balanceApplied < 0)) ||
      (summary.amount === 0 && !(summary.balanceApplied > 0))
    )
      return []
    const order = orders.find(
      (row) =>
        row.jid === jid &&
        row.number === summary.orderNumber &&
        (summary.orderId === undefined || row.id === summary.orderId)
    )
    const operations = order?.operations
    return [
      {
        eventId: event.id,
        confirmedAt: event.created_at,
        orderNumber: summary.orderNumber,
        received: summary.amount,
        balanceApplied: summary.balanceApplied ?? 0,
        orderCreated: summary.cartCleared === true,
        order: order
          ? {
              total: order.total,
              paid: order.paid,
              balance: order.balance,
              status: order.status,
              operations: operations
                ? {
                    stage: operations.stage,
                    source: operations.source,
                    estimate: operations.estimate,
                    eligibleAt: operations.eligibleAt,
                    expectedReadyOn: operations.expectedReadyOn,
                  }
                : null,
            }
          : null,
      },
    ]
  })
  if (!receipts.length) return ''
  return `BUKTI PEMBAYARAN TERCATAT DAN PESANAN TERKAIT (data internal):
${JSON.stringify(receipts)}
Untuk pembayaran baru yang belum diberitahukan, sampaikan terima kasih, nomor pesanan persis, nominal terverifikasi, total/sisa atau lunas, lalu status dan langkah berikut sesuai order.operations. Nomor ini order lokal, bukan ID MCP; bukti yang sama tidak perlu dicari ulang. Boleh satu pesan berbaris; jangan hanya nominal atau membuat bubble tanda terima terpisah. Dalam pembahasan pembayaran/order terkait, lengkapi nomor/status penting yang belum diberitahukan tanpa menyalin seluruh balasan. Jangan membuka pembayaran lama saat topik lain atau mengirim ulang saat review; pertanyaan pelanggan tetap dijawab.
received adalah transfer pada event, paid akumulasi termasuk alokasi; balance sisa aktual. Jangan menjumlahkan ulang atau menyebut transfer baru untuk alokasi tanpa transfer. Pelunasan memakai nomor order yang sama, bukan membuat order baru. orderCreated bukan bukti sedang dikerjakan/dikirim; stage queued belum production, null/unverified belum konfirmasi progres. Langkah berikut mengikuti state dan syarat estimasi, bukan janji tanggal/produksi dari foto receipt. order null berarti state belum tersedia/cocok: jangan mengambil status order lain atau mengarang. Ini bukan izin mengirim ulang, melakukan pembayaran, atau mengubah order. Foto/hasil baca bukti saja bukan event pembayaran terverifikasi.`
}
