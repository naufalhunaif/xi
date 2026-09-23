export type FitRequest = { type: string; height: number; weight: number }

/** Inspect only the current customer request, not old order notes or model reasoning. */
export function currentFitRequest(text: string): FitRequest | undefined {
  if (/(?:mau|ingin|minta|hubungkan|bicara).{0,25}\b(?:cs|admin|owner|manusia)\b/i.test(text))
    return
  const type = /\b(celana|pants)\b/i.test(text)
    ? 'pants'
    : /\b(kaos|t-?shirt)\b/i.test(text)
      ? 'tshirt'
      : /\b(kemeja|shirt)\b/i.test(text)
        ? 'shirt'
        : /\b(jaket|jacket)\b/i.test(text)
          ? 'jacket'
          : /\b(jas|suit)\b/i.test(text)
            ? 'suit'
            : undefined
  if (!type || !/\b(no(?:mor)?|size|ukuran|pake|pakai|bagus\w*|cocok|rekomendasi)\b/i.test(text))
    return
  if (!/\?|\b(berapa|apa|cocok|rekomendasi|bagus\w*|saran)\b/i.test(text)) return
  const height = Number(
    text.match(/\b(?:tinggi(?:\s+badan)?|tb)\s*[:=]?\s*(\d{2,3})\b/i)?.[1] ||
      text.match(/\b(\d{2,3})\s*cm\b/i)?.[1]
  )
  const weight = Number(
    (
      text.match(/\b(?:berat(?:\s+badan)?|bb)\s*[:=]?\s*(\d{2,3}(?:[.,]\d+)?)\b/i)?.[1] ||
      text.match(/\b(\d{2,3}(?:[.,]\d+)?)\s*kg\b/i)?.[1] ||
      ''
    ).replace(',', '.')
  )
  if (height >= 1 && height <= 300 && weight >= 40 && weight <= 117) return { type, height, weight }
}

type Call = { server: string; tool: string; arguments?: Record<string, any>; result?: any }
export function verifiedFitResult(calls: Call[], request: FitRequest) {
  for (const call of calls) {
    if (call.server !== 'business_fit' || call.tool !== 'fit_advisor' || call.result?.isError)
      continue
    const args = call.arguments
    if (
      args?.type !== request.type ||
      Number(args?.height) !== request.height ||
      Number(args?.weight) !== request.weight
    )
      continue
    const candidates = [
      call.result?.structured_content,
      call.result?.structuredContent,
      ...(call.result?.content || []).map((item: any) => item.text),
    ]
    for (let candidate of candidates) {
      try {
        if (typeof candidate === 'string') candidate = JSON.parse(candidate)
      } catch {
        continue
      }
      if (
        candidate?.ok === true &&
        candidate.data &&
        Object.hasOwn(
          candidate.data,
          request.type === 'pants' ? 'recommended_pants_no' : 'recommended_size'
        )
      )
        return candidate.data as Record<string, any>
    }
  }
}

export function fitRoutingInstructions(request?: FitRequest) {
  if (!request) return ''
  return `VALIDASI KEBUTUHAN SAAT INI: pelanggan meminta estimasi ukuran ${JSON.stringify(request)}.
Panggil business_fit.fit_advisor memakai data pelanggan tersebut sebelum mengambil keputusan. Usia dan style opsional: jangan mengarang usia, dan boleh hilangkan style bila belum diketahui agar tool memakai estimasi regular. Tidak perlu menahan estimasi hanya karena nama model atau nomor celana lama belum diketahui. Bila hasil menyarankan klarifikasi preferensi, pertanyaan slim fit atau regular bersifat opsional, mengikuti kebutuhan dan skill.
Pisahkan kebutuhan ini dari masalah order lama. Bila Fit menghasilkan rekomendasi, sampaikan sebagai rekomendasi sesuai hasil tool, tanpa tambahan "bukan jaminan pas". Keterbatasan yang memengaruhi pilihan dijelaskan spesifik hanya bila ada; jangan menjanjikan pasti pas. Kebutuhan produksi/otorisasi manusia yang belum selesai tetap disimpan pada note dan goal (waiting_approval bila masih relevan), tanpa mengalihkan seluruh room hanya karena kebutuhan lama itu. Jangan mengumumkan pengalihan ke CS dan jangan mengarang status produksi. Permintaan eksplisit pelanggan untuk manusia tetap dihormati.`
}
