# Harga paket dan persetujuan model dari chat CS

AI mengusulkan referensi bukti, bukan memberikan persetujuan sendiri. `cartIntent.bundlePrice`
memuat pesan kutipan manusia, pesan penerimaan pelanggan, dan total barang. Saat ini alokasi
otomatis mendukung paket jas/celana (opsional rompi), satu per jenis, tepat satu model custom,
dengan harga komponen katalog lain sudah terverifikasi. Sisa total menjadi harga custom.
Harga tidak dibagi rata dan tidak boleh mencakup ongkir, diskon, atau DP. Paket ambigu tetap
perlu klarifikasi. Kutipan berbeda room, AI, failed/queued, sebelum pembatalan/pembayaran order
lama, atau tidak terkait referensi foto ditolak.

`items[].modelConsent` menunjuk pertanyaan pelanggan dan jawaban persetujuan manusia yang
langsung terkait foto/model/warna. Jawaban bersyarat atau topik lain tidak sah. Ini tidak
menyetujui ukuran custom maupun dana. Setelah tercatat, antrean pemberitahuan persetujuan
dibatalkan bila tidak ada kebutuhan lain yang masih menunggu. Jika ukuran custom juga menunggu,
kebutuhan ukuran tetap terbuka.

Verifikasi dilakukan dalam transaksi cart sebelum total/diskon disimpan. Bukti dan fingerprint
tersimpan dalam JSON item serta audit cart; tidak perlu tabel baru/migration. Perubahan barang
membatalkan bukti paket; perubahan desain membatalkan persetujuan model. Perubahan ongkir/alamat
tidak membatalkan persetujuan barang yang sama. Input tidak dapat menyisipkan flag approved atau
bukti tersimpan palsu. Cart custom dengan harga kosong menghasilkan issue agar balasan total
yang belum terverifikasi ditahan.

Perubahan tidak mengubah pesanan produksi yang sudah dibayar, tidak memverifikasi pembayaran,
dan tidak menyunting cart server saat deploy. Cart lama diperiksa pada giliran AI berikutnya
atau melalui review AI; ID pesan asli harus masih tersedia dalam konteks. Gaya bahasa tetap
mengikuti skill.

Uji lokal terisolasi: `node scripts/test_cart_discount_database.mjs --human-cart`.
