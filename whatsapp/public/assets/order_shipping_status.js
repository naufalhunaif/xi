;(() => {
  const errors = {
    SHIPPING_AI_FAILED: 'Pemeriksaan AI belum selesai',
    SHIPPING_AGENT_STEP_LIMIT: 'Pemeriksaan AI akan dilanjutkan',
    SHIPPING_CONTEXT_CHANGED: 'Percakapan berubah · memeriksa ulang',
    USAGE_LIMIT: 'Batas pemakaian AI tercapai',
    AI_AUTH_REQUIRED: 'Hubungkan ulang akun AI',
    ORION_CONNECTION_REQUIRED: 'Hubungkan Orion',
    ORION_AUTH_REQUIRED: 'Hubungkan ulang Orion',
    ORION_UNAVAILABLE: 'Orion belum tersedia · mencoba lagi',
    ORION_WEIGHT_REJECTED: 'Berat ditolak Orion · periksa build worker',
    ORION_RESPONSE_INVALID: 'Respons Orion belum valid · periksa detail proses',
    ORION_LOOKUP_INCOMPLETE: 'Pencarian resi belum selesai',
    SHIPPING_PREFLIGHT_REQUIRED: 'Data pengiriman perlu diverifikasi dahulu',
    SHIPPING_AWB_REQUIRED: 'Nomor resi belum tersedia',
    AWB_REFERENCE_INCOMPLETE: 'Data resi Orion belum lengkap',
    TRACKING_DETAILS_REQUIRED: 'Detail tracking belum tersedia',
    SHIPPING_LEASE_LOST: 'Menunggu pemulihan proses',
    SHIPPING_UNAVAILABLE: 'Pengiriman belum tersedia · mencoba lagi',
    SHIPPING_RECIPIENT_REQUIRED: 'Periksa penerima dan alamat',
    SHIPPING_WEIGHT_REQUIRED: 'Berat pengiriman belum tersedia',
    SHIPPING_DESTINATION_REQUIRED: 'Tujuan pengiriman perlu diperiksa',
    SHIPPING_RATE_CHANGED: 'Ongkir berubah · perlu diperiksa',
    SHIPPING_DETAILS_REQUIRED: 'Detail pengiriman perlu diperiksa',
    SHIPPING_ORDER_CHANGED: 'Order berubah · memeriksa ulang',
    AWB_RECONCILIATION_REQUIRED: 'Memeriksa hasil pembuatan resi',
    MULTIPLE_AWBS: 'Ditemukan beberapa resi · perlu diperiksa',
    TRACKING_ID_MISMATCH: 'Resi tidak cocok · perlu diperiksa',
  }
  const phases = {
    analysis: 'AI memeriksa percakapan dan order',
    connecting: 'Menghubungkan Orion',
    lookup: 'Mencari resi yang sudah ada',
    destination: 'Memeriksa tujuan pengiriman',
    rates: 'Memeriksa ongkir',
    creating: 'Membuat AWB Orion',
    tracking: 'Memeriksa perjalanan paket',
    checking: 'Memproses pengiriman',
  }
  window.waShippingStatus = (order) => {
    if (order.status === 'cancelled') return ''
    if (order.operations?.stage === 'completed' || order.shipment?.status === 'completed') return ''
    const shipment = order.shipment
    if (shipment?.status === 'processing') {
      if (
        shipment.workerActive === false ||
        (shipment.leaseUntil && new Date(shipment.leaseUntil).getTime() <= Date.now())
      )
        return 'Menunggu pemulihan proses'
      return phases[shipment.phase] || 'Memproses pengiriman'
    }
    if (shipment?.errorCode) return errors[shipment.errorCode] || 'Data Orion perlu diperiksa'
    if (shipment?.noticeStatus === 'uncertain') return 'Pemberitahuan pengiriman perlu diperiksa'
    return (
      {
        queued: 'Menunggu AWB Orion',
        retry: 'Menunggu AWB Orion',
        processing: 'Memproses pengiriman',
        reconciling: 'Memeriksa hasil pembuatan resi',
        waiting_pickup: 'Menunggu pembaruan pengiriman',
      }[shipment?.status] ||
      (order.operations?.stage === 'ready'
        ? order.operations.trackingNumber
          ? 'Menunggu pembaruan pengiriman'
          : 'Menunggu AWB Orion'
        : '')
    )
  }
  window.waShippingProgress = (order) => {
    const label = window.waShippingStatus(order)
    if (!label) return null
    const t = (key, ...args) =>
      window.waI18n?.t(key, ...args) ?? key.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    const box = document.createElement('div')
    box.className = 'wa-shipping-progress'
    box.title = [order.shipment?.errorCode, order.shipment?.assessment?.reason]
      .filter(Boolean)
      .join(' · ')
    box.setAttribute('role', 'status')
    const shipment = order.shipment
    const active =
      shipment?.status === 'processing' &&
      shipment.workerActive !== false &&
      new Date(shipment.leaseUntil).getTime() > Date.now()
    box.dataset.active = String(Boolean(active))
    const line = document.createElement('span')
    line.className = 'wa-shipping-progress-label'
    if (active) {
      const spinner = document.createElement('span')
      spinner.className = 'wa-shipping-spinner'
      spinner.setAttribute('aria-hidden', 'true')
      line.append(spinner)
    }
    line.append(document.createTextNode(t(label)))
    box.append(line)
    const details = []
    // A normal wait is not a retry failure; do not accumulate alarming check counts.
    if (shipment?.attempts > 0 && !(shipment.status === 'waiting_pickup' && !shipment.errorCode))
      details.push(t('Pemeriksaan {0}', shipment.attempts))
    const seconds = Math.ceil((new Date(shipment?.nextAttemptAt).getTime() - Date.now()) / 1000)
    if (
      seconds > 0 &&
      (['retry', 'reconciling'].includes(shipment?.status) || shipment?.errorCode) &&
      !active
    )
      details.push(t('Coba lagi dalam {0} dtk', seconds))
    if (details.length) {
      const meta = document.createElement('small')
      meta.className = 'wa-shipping-progress-meta'
      meta.textContent = details.join(' · ')
      box.append(meta)
    }
    return box
  }
})()
