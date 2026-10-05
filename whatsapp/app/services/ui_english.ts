import { englishCatalog } from '#services/english_messages'

/**
 * v3.6.26: tampilan selalu Inggris sejak HTML pertama dikirim server, bukan baru setelah
 * i18n.js jalan di browser (yang membuat teks tampak berganti-ganti saat halaman besar dimuat).
 * Memakai katalog yang sama dengan browser (public/lang/en.js); hanya elemen bertanda
 * data-i18n / data-i18n-title / -placeholder / -aria-label / -alt yang disentuh — bukan isi chat.
 */
const loadCatalog = englishCatalog

const unescapeHtml = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')

export function englishHtml(html: string) {
  const en = loadCatalog()
  if (!Object.keys(en).length) return html
  // Atribut: data-i18n-title="Kunci" → title="English" (ditambah bila belum ada).
  let out = html.replace(/<([a-zA-Z][^\s/>]*)(\s[^>]*?data-i18n-[^>]*)>/g, (tag, name: string, attrs: string) => {
    let next = attrs
    for (const attribute of ['title', 'placeholder', 'aria-label', 'alt']) {
      const match = new RegExp(`\\sdata-i18n-${attribute}="([^"]*)"`).exec(next)
      if (!match) continue
      const value = escapeHtml(en[unescapeHtml(match[1])] ?? unescapeHtml(match[1]))
      const own = new RegExp(`(\\s${attribute}=")([^"]*)(")`)
      next = own.test(next) ? next.replace(own, `$1${value}$3`) : `${next} ${attribute}="${value}"`
    }
    return next === attrs ? tag : `<${name}${next}>`
  })
  // Teks: <span data-i18n="Kunci">Kunci</span> → English (hanya bila teksnya memang kunci itu).
  out = out.replace(/(<[a-zA-Z][^>]*\sdata-i18n="([^"]*)"[^>]*>)(\s*)([^<]*?)(\s*)(?=<)/g, (all, tag: string, key: string, lead: string, text: string, trail: string) => {
    if (!text) return all
    const source = unescapeHtml(key)
    if (unescapeHtml(text).replace(/\s+/g, ' ').trim() !== source.replace(/\s+/g, ' ').trim()) return all
    const translated = en[source]
    if (!translated) return all
    return `${tag}${lead}${escapeHtml(translated)}${trail}`
  })
  // Teks otomatis: <button data-i18n-auto> Semua <span…> → English bila teks pertamanya ada di katalog.
  out = out.replace(/(<[a-zA-Z][^>]*\sdata-i18n-auto(?:\s[^>]*)?>)(\s*)([^<]*?)(\s*)(?=<)/g, (all, tag: string, lead: string, text: string, trail: string) => {
    const source = unescapeHtml(text).replace(/\s+/g, ' ').trim()
    const translated = source ? en[source] : undefined
    return translated ? `${tag}${lead}${escapeHtml(translated)}${trail}` : all
  })
  return out
}
