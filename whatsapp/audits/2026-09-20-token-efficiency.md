# Audit penggunaan token WhatsApp — 20 September 2026

Laporan: satu jawaban menghabiskan 800 ribu–1 juta token. Audit memperbaiki sumber pemborosan yang ditemukan pada kode dengan prioritas kualitas jawaban dan akurasi konteks. Angka produksi tersebut **belum bisa dikonfirmasi**: MySQL lokal menerima koneksi, tetapi pembacaan metadata `whatsapp_ai_traces` gagal dengan error 1932, `doesn't exist in engine`. Database tidak diubah atau diperbaiki dalam pekerjaan ini.

## Perubahan akhir

- **Skema tool bisnis:** bridge dan kedua provider memakai daftar tool bisnis yang sama, yang sebelumnya sudah dipakai Codex. Skema operasi tulis yang tidak boleh dijalankan dalam chat tidak lagi dikirim ke Claude. Pemanggilan langsung tool tersembunyi ditolak bridge. Koneksi yang belum mempunyai daftar tetap kompatibel. Seluruh tool baca pada implementasi Store, Material dan Invoice lokal tetap tersedia.
- **Runtime Claude:** system prompt coding diganti instruksi tugas WhatsApp yang ringkas. Built-in hanya `Read` bila ada gambar; task teks tidak membawa built-in coding. Settings pengguna/project dan slash skills tidak dimuat. OAuth, model, reasoning, speed dan seluruh isi skill pilihan workspace dipertahankan. Flag diverifikasi melalui help CLI terpasang.
- **Skill:** isi penuh tetap dikirim lewat prompt. Salinan berkas runtime `.agents/skills` dan `.claude/skills` dihapus agar tidak ikut discovery atau dibaca lagi.
- **Riwayat:** tersedia pada analisis pelanggan, pemeriksaan bisnis ulang, perbandingan gambar dan pemeriksaan visual ulang. Tugas yang secara eksplisit bekerja dari snapshot, seperti receipt dan evaluasi, tidak diberi tool arsip tambahan. Jendela riwayat, memori, catatan pelanggan, cart/order dan kutipan tidak dipendekkan.
- **Katalog:** seluruh identitas tetap dikirim; tidak ada batas 60 produk/12.000 karakter. ID numerik dan metadata lanjutan `next_cursor`/`has_more` dipertahankan. Bukti produk, harga, stok, ongkir, Fit serta panduan tidak dipotong.
- **Pengaman loop:** tidak ada batas tetap 16 tool. Proses berhenti hanya setelah empat hasil MCP berturut-turut dengan sumber, nama tool, argumen dan hasil identik. Bukti baru memutus urutan, dan fase baru boleh memverifikasi ulang. Event start/completion duplikat tidak dihitung dua kali. Error `AI_TOOL_LOOP` tidak memicu failover atau pengiriman balasan parsial.

## Pengukuran overhead skema

Diukur dari definisi tool PHP lokal melalui reflection tanpa constructor, database atau jaringan; JSON sebelum/sesudah penyaringan dihitung dengan fungsi kebijakan runtime yang sama.

| Sumber | Jumlah tool sebelum → sesudah | Karakter JSON sebelum → sesudah | Pengurangan |
| --- | --- | --- | --- |
| Store | 6 → 5 | 2.804 → 1.667 | 41% |
| Material | 4 → 3 | 2.579 → 1.050 | 59% |
| Invoice | 11 → 5 | 11.130 → 3.076 | 72% |

Yang dikeluarkan adalah skema operasi tulis, bukan data atau tool baca. Angka ini untuk overhead skema pada bridge, terutama bermanfaat bagi Claude yang sebelumnya menerima semua tool. Codex sebelumnya sudah mempunyai filter tool, sehingga tidak tepat mengklaim persentase tersebut sebagai penghematan tambahan Codex. Besarnya penghematan total request bergantung pada sumber aktif, model, jumlah langkah, gambar, panjang skill dan cache provider.

## Verifikasi dan batas klaim

- Tes regresi mencakup seluruh isi skill, 10.000 identitas katalog tanpa kehilangan entri, ID numerik, HTTP bridge, bukti bisnis/ongkir, semantik, visual, runtime dan error provider.
- Pengaman diuji dengan lebih dari 16 tool yang menghasilkan bukti baru: tetap berjalan. Hasil berubah atau argumen/sumber berbeda tidak dianggap loop. Hanya pengulangan identik yang dihentikan.
- TypeScript dan ESLint pada berkas berubah lulus; lihat hasil runner pada sesi implementasi untuk jumlah tes terakhir.
- Tidak menjalankan model berbayar atau mengirim WhatsApp. Kualitas jawaban secara semantik belum dapat dijamin identik tanpa replay percakapan nyata pada model yang sama.

Satu pesan dapat memicu beberapa fase AI, masing-masing dengan beberapa langkah tool. Input provider bersifat kumulatif; cache input tetap termasuk hitungan token. Perhitungan usage tidak diubah. Cache MCP menghemat pengambilan data, tetapi hasilnya tetap masuk konteks model. Evaluasi background memakai hingga 100 pesan dan seluruh skill; frekuensinya dipertahankan karena hasil evaluasi dipakai alur produksi/pembelajaran.

Pengaman loop bukan batas keras token. Prompt besar, pencarian sah yang panjang atau hasil tool besar masih bisa mahal. Pemanggilan keempat mungkin sudah selesai ketika proses dihentikan. Setelah database/worker tersedia, bandingkan percakapan sejenis: token per fase, porsi cache, ukuran skill, `toolsBefore`/`tools`, ukuran hasil tool serta `toolCallsInTask`. Perbaikan ini belum dideploy atau diuji dengan provider produksi.

Referensi runtime: [OpenAI Docs — konfigurasi Codex](https://learn.chatgpt.com/docs/config-file/config-reference). Tidak menerapkan pemotongan output tool global yang berisiko menghilangkan bukti transaksi.

## Temuan lanjutan: analisis berulang saat waiting

Pengguna melaporkan analisis 200–400 ribu token atau lebih muncul lagi pada chat yang sudah menunggu. Ditemukan tiga celah pada jalur pemicu:

- Sapuan backlog hanya memeriksa arah pesan terakhir, sehingga keputusan `silent` yang sah tetap terlihat belum dibalas.
- `beginGoalTurn` sebelumnya selalu mengganti goal menjadi processing meski ID pesan itu sudah berhasil dianalisis.
- Recovery pesan tersimpan dapat menghapus status waiting sebelum meminta review; aktivasi AI juga dapat memasukkan chat yang sama ke antrean kembali.

Perbaikan menyimpan `analyzed_anchor_id` saat keputusan selesai, termasuk silent, dan mempertahankannya saat invalidasi goal. Sapuan SQL, pengantrean review dan recovery melewati anchor yang sudah dianalisis; klaim giliran memeriksa ulang di dalam transaksi dengan penguncian baris. Dengan demikian antrean lama pun tidak memanggil model ulang. `app:init` menambahkan kolom dan mengisi anchor goal waiting/completed yang sudah ada, tanpa menganalisis chat tersebut lagi.

Pesan baru tetap membuka giliran baru; keputusan manusia yang mengubah state boleh memicu review meski belum ada pesan baru. Susulan terjadwal yang sah menggunakan jalur klaim tersendiri dan tetap diuji. Riwayat, skill, memori, harga dan bukti tidak dikurangi. Evaluasi background tidak dimatikan: suite evaluasi memastikan snapshot yang tidak berubah tidak menjalankan evaluasi berulang.

Verifikasi: 36 tes database terisolasi lulus untuk recovery, goal, evaluasi dan deduplikasi waiting. Empat status menunggu diuji dengan pemicu yang sama tiga kali; penyusunan konteks dan pemanggilan AI dipasang sebagai kegagalan tes bila tersentuh. Klaim dua worker serentak menghasilkan tepat satu pemenang. Database sementara berhasil digunakan dan dihapus otomatis; database aplikasi tetap tidak berubah. Perbaikan belum diterapkan ke worker produksi.
