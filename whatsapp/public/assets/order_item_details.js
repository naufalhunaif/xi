;(() => {
  // Shared, text-only renderer for draft cart, paid order and production page.
  window.waOrderItemDetails = (parent, item) => {
    const catalogAdjustment = item.modelType === 'catalog' &&
      Boolean(item.modelConsentEvidence?.requestMessageId && item.modelConsentEvidence?.approvalMessageId)
    const value = item.productionDetails || {}
    const t = (key) => window.waI18n?.t(key) || key
    const rows = [
      ['Tinggi badan', value.heightCm ? `${value.heightCm} cm` : '', 'measurement'],
      ['Berat badan', value.weightKg ? `${value.weightKg} kg` : '', 'measurement'],
      ['Preferensi fit', value.fit], ['Warna', value.color], ['Bahan', value.material],
      ['Lapel', value.lapel], ['Kancing', value.buttons], ['Catatan pengerjaan', value.notes, 'notes'],
      ...(value.measurements || []).map((m) => [
        `${t(m.basis === 'body' ? 'Ukuran badan' : 'Ukuran pakaian jadi')} · ${m.name}`,
        `${m.value} cm`,
        'measurement',
      ]),
      ...(value.pending || []).map((p) => ['Perlu dilengkapi', p, 'pending']),
    ].filter(([, text]) => text)
    if (!rows.length && !catalogAdjustment) return
    const heading = catalogAdjustment ? 'Penyesuaian desain katalog' : 'Detail pengerjaan'
    const section = document.createElement('section')
    section.className = 'wa-item-production-details'
    section.setAttribute('aria-label', t(heading))
    const title = document.createElement('h4')
    title.className = 'wa-item-production-title'
    title.textContent = t(heading)
    const fields = document.createElement('dl')
    fields.className = 'wa-item-production-grid'
    section.append(title, fields)
    if (catalogAdjustment) {
      const status = document.createElement('small')
      const hasDesign = ['color', 'material', 'lapel', 'buttons', 'notes'].some((key) => value[key])
      status.textContent = t(!hasDesign ? 'Detail penyesuaian belum tersedia.' : {
        approved: 'Desain · disetujui CS',
        rejected: 'Desain · ditolak CS',
      }[item.modelApproval] || 'Desain · perlu diperiksa')
      section.insertBefore(status, fields)
    }
    for (const [label, text, kind = 'specification'] of rows) {
      const line = document.createElement('div')
      line.className = `wa-item-production-field wa-item-production-field--${kind}`
      const term = document.createElement('dt')
      term.textContent = t(label)
      const description = document.createElement('dd')
      description.textContent = text
      line.append(term, description)
      fields.append(line)
    }
    parent.append(section)
  }
})()
