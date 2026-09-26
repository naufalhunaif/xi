/**
 * Multi nomor: setiap proses listener melayani satu "line" (nomor WhatsApp).
 * Line 1 = nomor utama (tabel whatsapp_connection); line ≥ 2 = nomor tambahan
 * (tabel whatsapp_lines). Semua line berbagi satu workspace: inbox, AI, dan
 * pengaturan yang sama. Pesan/kontak line utama disimpan dengan line_id NULL.
 */
let line = 1
export const currentLine = () => line
export function setCurrentLine(value: number) {
  line = Number.isSafeInteger(value) && value > 1 ? value : 1
}
/** Kolom tambahan untuk baris pesan yang dibuat proses ini. */
export const lineColumns = () => (line > 1 ? { line_id: line } : {})
/** Nomor pemilik room (NULL/0 = utama). */
export const lineOf = (value: unknown) => {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 1 ? id : 1
}
