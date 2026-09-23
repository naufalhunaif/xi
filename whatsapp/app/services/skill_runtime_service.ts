import {
  shippingEvidence,
  matchShippingQuote,
  requiresShippingQuote,
  type ShippingCartState,
} from '#services/shipping_evidence_service'
import { verifiedFitResult, type FitRequest } from '#services/fit_routing_service'
import { SEMANTIC_INTENT_INSTRUCTIONS } from '#services/semantic_intent_contract'

type BusinessConnection = { slug: string; enabled: boolean; authenticated: boolean }
type BusinessRun = {
  text: string
  toolCalls: Array<{ server: string; tool: string; arguments?: Record<string, any>; result?: any }>
}

function renderedSkills(skills: Array<{ name: string; content: string }>) {
  const originals = new Map<string, string>()
  return skills.map((skill) => {
    const original = originals.get(skill.content)
    const reference = `Isi skill ini identik persis dengan skill ${JSON.stringify(original)} di atas; seluruh isinya berlaku juga di posisi ini.`
    const body =
      original !== undefined && reference.length < skill.content.length ? reference : skill.content
    if (original === undefined) originals.set(skill.content, skill.name)
    return [
      `skill: ${skill.name}`,
      `=== SKILL: ${skill.name} ===\n${body}\n=== AKHIR SKILL: ${skill.name} ===`,
    ] as [string, string]
  })
}

/** All unique contents remain inline; only byte-identical copies reference their original. */
export function importedSkillInstructions(skills: Array<{ name: string; content: string }>) {
  return [
    SEMANTIC_INTENT_INSTRUCTIONS,
    'SKILL TERIMPOR: seluruh isi di bawah tersedia langsung, tidak perlu dibaca lewat shell. Cara membalas, penggunaan tool, keputusan, dan inisiatif mengikuti skill ini. Tidak ada persona atau panduan bisnis bawaan lain.',
    ...renderedSkills(skills).map(([, content]) => content),
  ].join('\n\n')
}

/** Same text importedSkillInstructions builds, attributed per skill for cost reporting. */
export function skillSections(skills: Array<{ name: string; content: string }>) {
  return [
    ['aturan-semantik', SEMANTIC_INTENT_INSTRUCTIONS.length] as [string, number],
    ...renderedSkills(skills).map(([key, content]) => [key, content.length] as [string, number]),
  ]
}

export function businessDataInstructions(connections: BusinessConnection[]) {
  const active = connections.filter((item) => item.enabled && item.authenticated)
  return `KONTEKS TEKNIS: MCP aktif: ${active.map((item) => `business_${item.slug}`).join(', ') || '(tidak ada koneksi terautentikasi)'}. Tool deferred tersedia melalui discovery/search; gunakan skema aktual. Isi skill terimpor menentukan cara memakai tool dan mengambil keputusan. Operasi MCP dibatasi baca; metadata handoff dan alasan audit tidak dikirim sebagai pesan pelanggan.`
}

export function needsBusinessVerification(
  run: BusinessRun,
  connections: BusinessConnection[],
  fitRequest?: FitRequest,
  productCombination = false,
  previousCart?: ShippingCartState
) {
  const evidenceCalls = run.toolCalls.filter(
    (call) =>
      !['business_conversation_history', 'business_skill_library'].includes(call.server) &&
      ![
        'list_business_resources',
        'list_tools',
        'tools/list',
        'list_mcp_resources',
        'list_mcp_resource_templates',
      ].includes(call.tool)
  )
  if (!connections.some((item) => item.enabled && item.authenticated)) return false
  let decision: Record<string, unknown> = {}
  try {
    decision = JSON.parse(run.text)
  } catch {}
  // Missing exact-color SKU is a shopping clarification, not human authorization.
  // Explicit custom/complaint/human requests are excluded by current-turn routing.
  if (productCombination && decision.decision !== 'reply') return true
  // A broad human_authorization flag cannot swallow an independently solvable size query.
  if (
    fitRequest &&
    connections.some((item) => item.slug === 'fit' && item.enabled && item.authenticated)
  ) {
    const fit = verifiedFitResult(run.toolCalls, fitRequest)
    if (!fit) return true
    const recommendation =
      fitRequest.type === 'pants' ? fit.recommended_pants_no : fit.recommended_size
    if (recommendation !== null && recommendation !== undefined && decision.decision !== 'reply')
      return true
    if (recommendation !== null && recommendation !== undefined) {
      const answer = `${decision.message || ''}\n${decision.initiative || ''}`
      const sizes = [
        recommendation,
        ...(fit.fit_percentages || []).map((row: any) =>
          fitRequest.type === 'pants' ? row.pants_no : row.size
        ),
      ]
      const mentionsSize = sizes.some(
        (size) =>
          size !== null &&
          size !== undefined &&
          answer
            .split(/[^\p{L}\p{N}]+/u)
            .some((word) => word.toLowerCase() === String(size).toLowerCase())
      )
      const asksPreference =
        Boolean(fit.preference_question) && /slim[\s\S]*regular|regular[\s\S]*slim/i.test(answer)
      if (!mentionsSize && !asksPreference) return true
    }
  }
  const cart = decision.cartIntent as (ShippingCartState & { action?: string }) | undefined
  if (
    cart?.action === 'sync' &&
    cart.shipping &&
    cart.shipping.cost !== null &&
    requiresShippingQuote(cart, previousCart)
  ) {
    // A model's "lookup not required" flag cannot substitute for a verified shipping quote.
    if (
      !matchShippingQuote(
        shippingEvidence(run.toolCalls),
        cart.shipping.service,
        cart.shipping.cost
      )
    )
      return true
  }
  if (evidenceCalls.length) return false
  if (
    decision.decision === 'handoff' &&
    ['human_authorization', 'human_complaint'].includes(String(decision.handoff_category))
  )
    return false
  return !(
    ['reply', 'silent'].includes(String(decision.decision)) &&
    decision.business_lookup_required === false
  )
}

export async function verifyBusinessRun<T extends BusinessRun>(
  run: T,
  connections: BusinessConnection[],
  retry: () => Promise<T>,
  fitRequest?: FitRequest,
  productCombination = false,
  previousCart?: ShippingCartState
): Promise<T> {
  if (!needsBusinessVerification(run, connections, fitRequest, productCombination, previousCart))
    return run
  const checked = await retry()
  if (needsBusinessVerification(checked, connections, fitRequest, productCombination, previousCart))
    throw new Error(
      'Balasan ditahan: AI belum menjalankan pemeriksaan data bisnis yang diperlukan menurut skill. Periksa koneksi/discovery MCP; handoff otomatis tidak dilakukan.'
    )
  return checked
}

export const BUSINESS_RECHECK =
  'Validasi runtime: draf belum memiliki bukti MCP yang diperlukan. Untuk ongkir baru atau perubahan layanan, nominal, isi paket, atau alamat pada cartIntent sync, tarif harus cocok dengan hasil tool ongkir aktual pada proses ini; menyalin dari riwayat atau menandai business_lookup_required false tidak cukup. Ongkir yang sama persis dengan STATE CART tersimpan boleh dipertahankan bila isi paket dan alamat tidak berubah; pembaruan nama/nomor penerima saja tidak memerlukan kutipan baru. Periksa data yang masih memerlukan bukti melalui MCP mengikuti skill, lalu keluarkan keputusan/cart yang diperbarui. Jangan meminta ulang pilihan pelanggan yang sudah jelas atau mengaku telah memeriksa data tanpa tool. Jika bukti baru tetap tidak tersedia, pertahankan draft dengan ongkir null, tanpa mengarang tarif atau mengalihkan otomatis ke CS.'

export const SAVED_CART_SHIPPING_INSTRUCTIONS =
  'ONGKIR TERSIMPAN: pada sync yang hanya melengkapi nama/nomor penerima, pertahankan layanan/nominal dari STATE CART jika alamat dan isi paket tetap sama. Ini mempertahankan state, bukan verifikasi tarif baru; jangan memanggil MCP hanya untuk menyalin tarif yang tidak berubah atau mengaku baru memeriksanya. Tarif dari riwayat chat saja bukan state terverifikasi. Bila tujuan, barang/ukuran/jumlah/detail fisik, layanan atau biaya berubah, cari bukti tarif yang sesuai sebelum mengisi ongkir. business_lookup_required tetap true bila ada data bisnis lain yang harus diperiksa.'

export const CUSTOMER_MESSAGE_CONTRACT =
  'Teks pelanggan hanya untuk decision reply; isi dan gaya mengikuti skill terimpor. message berisi jawaban atas kebutuhan saat ini, bukan gabungan jawaban dan ajakan langkah berikutnya. Jika jawaban utama sudah tuntas dan langkah berikutnya menurut skill sudah relevan, tempatkan pertanyaan/tindakan lanjutan itu hanya di initiative agar terkirim sebagai chat terpisah. Pertanyaan klarifikasi yang diperlukan untuk menjawab kebutuhan saat ini tetap di message. Bila hanya pertanyaan berikutnya yang berguna, kirim satu pesan itu saja; jangan membuat pengantar kosong. Gunakan bahasa percakapan yang ramah secukupnya dan sesuai konteks; contoh kalimat skill adalah acuan maksud, bukan template wajib disalin kecuali skill menyatakan teks harus persis. Hindari pengulangan pembuka seperti "Siap bos", konfirmasi atas fakta yang sudah jelas, dan penutup generik. Jangan mengubah sapaan yang diwajibkan skill, fakta, angka, syarat, keputusan, atau waktu kirim demi memperhalus bahasa. Jika perlu penanganan CS, gunakan decision handoff dengan message kosong, bukan reply berisi pemberitahuan pengalihan. Handoff dan silent tidak mengirim pesan apa pun. Alasan dan catatan hanya pada reason/note.'
