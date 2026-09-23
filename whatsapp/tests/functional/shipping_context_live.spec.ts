import { test } from '@japa/runner'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'
import { mcpShippingData } from '#services/shipping_evidence_service'

test('Cirebon correction uses the confirmed city for an initial shipping estimate', async ({
  assert,
}) => {
  const calls: any[] = []
  const result = await createReply(
    await readSettings(true),
    'Corebon',
    undefined,
    undefined,
    `UJI SINTETIS TERISOLASI: nama wilayah publik, tanpa pelanggan/order nyata. Tidak mengirim WhatsApp atau mengubah cart. Berat paket contoh 1 kg.
RIWAYAT:
PELANGGAN: Kalau pengiriman ke cirebon berapa lama ya
CS AI: Kecamatan sama kode posnya apa?
PELANGGAN: Tawangsari
CS AI: Kode posnya berapa?
PELANGGAN: Gak tau
CS AI: Tawangsari masuk kecamatan mana?
PELANGGAN: Kecamatan tawangsari
CS AI: Tujuannya Sukoharjo atau Cirebon?
PELANGGAN TERBARU: Corebon
CATATAN/GOAL LAMA: Menunggu kecamatan yang benar di Cirebon sebelum cek tarif. Belum ada alamat final atau pilihan kurir. Pertanyaan awal hanya estimasi waktu kirim; jangan mencari/mengubah order nyata.`,
    [],
    (event) => {
      if (event.status === 'completed' && (event.detail as any)?.parameters) {
        calls.push(event)
        console.log(
          JSON.stringify({ progress: event.label, parameters: (event.detail as any).parameters })
        )
      }
    }
  )
  const answer = `${result.message}\n${result.initiative || ''}`
  console.log(
    JSON.stringify({
      answer,
      reason: result.reason,
      goal: result.goal,
      tools: calls.map((event) => ({
        label: event.label,
        parameters: event.detail.parameters,
        data: /destination/i.test(event.label)
          ? JSON.stringify(event.detail.result?.structured_content ?? {}).slice(0, 1800)
          : undefined,
      })),
    })
  )
  assert.equal(result.decision, 'reply')
  assert.isTrue(
    calls.some(
      (event) =>
        (/destination/i.test(event.label) || event.detail.parameters.resource === 'destinations') &&
        /cirebon/i.test(JSON.stringify(event.detail.parameters))
    )
  )
  assert.isTrue(calls.some((event) => /check_shipping_rates/i.test(event.label)))
  const verifiedCodes = new Set<string>()
  for (const event of calls) {
    if (!/destination/i.test(event.label) && event.detail.parameters.resource !== 'destinations')
      continue
    const data = mcpShippingData(event.detail.result) as any
    for (const row of data?.records || data?.candidates || []) {
      if (row.code) verifiedCodes.add(String(row.code))
    }
  }
  for (const event of calls.filter((item) => /check_shipping_rates/i.test(item.label)))
    assert.isTrue(
      verifiedCodes.has(event.detail.parameters.destination_code),
      'Tarif memakai kode tujuan dari hasil MCP, bukan pola angka'
    )
  assert.notMatch(answer, /(?:kecamatan|kode\s*pos)[^.!?\n]*\?/i)
  assert.notMatch(answer, /(?:Sukoharjo|Tawangsari)/i)
  assert.match(answer, /hari/i)
  assert.isNull(result.cartIntent ?? null)
})
  .skip(process.env.AI_SHIPPING_CONTEXT_LIVE_TEST !== '1')
  .timeout(360_000)

test('inspects city-level destination metadata without quoting or sending anything', async () => {
  const settings = await readSettings(true)
  await createReply(
    {
      ...settings,
      skills: [],
      paymentMethods: [],
      mcpConnections: settings.mcpConnections.filter((item) => item.slug === 'orion'),
    },
    'Diagnostik baca-saja untuk pengembang. Panggil list_orion_data resource destinations query Cirebon limit 500 offset 0 satu kali memakai skema aktual. Tidak perlu search_destinations atau check_shipping_rates. Jangan mengirim pesan atau mengubah data apa pun. Setelah hasil didapat kembalikan decision reply dengan message Diagnostik selesai, cartIntent null.',
    undefined,
    undefined,
    undefined,
    [],
    (event) => {
      const detail = event.detail as any
      if (event.status === 'completed' && detail?.parameters) {
        let data = detail.result?.structured_content
        if (!data) {
          const text = detail.result?.content?.find((item: any) => item.type === 'text')?.text
          const json = typeof text === 'string' ? text.slice(text.indexOf('{')) : ''
          try {
            data = JSON.parse(json)
          } catch {}
        }
        const rows = data?.records || []
        console.log(
          JSON.stringify({
            label: event.label,
            parameters: detail.parameters,
            metadata: data
              ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'records'))
              : null,
            count: rows.length,
            cityLevel: rows.filter(
              (row: any) =>
                !row.district_name ||
                !row.subdistrict_name ||
                /^CIREBON(?:,|$)/i.test(row.full_address || '')
            ),
            districts: [
              ...new Map(rows.map((row: any) => [row.code, row.district_name])).entries(),
            ],
          })
        )
      }
    }
  )
})
  .skip(process.env.AI_SHIPPING_CATALOG_DIAGNOSTIC !== '1')
  .timeout(180_000)
