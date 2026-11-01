# NOTES — Mulqi Websearch

Catatan fakta kerja. Ditulis sekali setelah riset awal; semua langkah
berikutnya merujuk ke sini, bukan mengulang `sed -n` pada sumber yang sama.

## Kontrak seam `ctx.web`

```
registerSearchProvider({ id, available(), search(request, signal) }) -> dispose
registerFetchProvider({ id, available(), fetch(request, signal) })   -> dispose
```

- `available()` wajib murah, tanpa jaringan.
- Id duplikat ditolak (`WEB_DUPLICATE_PROVIDER`).
- Seleksi: id terkonfigurasi menang; tanpa id, tepat satu provider usable
  dipilih; lebih dari satu -> `WEB_PROVIDER_AMBIGUOUS`.
- Config seam hanya punya dua kunci: `searchProvider`, `fetchProvider`.
  Bisa dioverride env `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER`.
  `searchTimeoutMs` milik `tool-web`, bukan seam ini.

### Bentuk hasil

```
WebSearchResult { content?, sources: [{ url, title?, snippet?, publishedAt? }], truncated }
WebFetchResult  { url, statusCode, body: { kind: 'html'|'text', content }, truncated }
```

## Semantik patch cordis

- Satu baris patch pada sebuah id **mengganti seluruh config** baris itu.
  Bukan merge per kunci.
- Urutan lapisan: patch bundle dulu, patch profil terakhir. Karena itu baris
  `- id: web` di profil selalu menang dan menghapus `searchProvider` yang
  dipasang bundle.

## Lokasi penting

| Apa | Path |
|---|---|
| plugin | `/home/administrator/agent-workspace/dsh-custom/plugins/mulqi-websearch` |
| profil | `/home/administrator/agent-workspace/.dsh/profiles/web` |
| paket engine (library) | `dsh-custom/plugins/dsh-free-search-chain` (alias paket `dsh-free-search`) |
| modsearch CLI | `profiles/web/node_modules/@liustack/modsearch/dist/main.js` |
| paket monid | `project/dsh-monid-search/dsh-web-monid` |
| backup profil | `profiles/web/*.bak-mulqi-websearch` |

## Ekspor `dsh-free-search` yang dipakai

Tersedia: `searchBing`, `searchDdgHtml`, `searchDdgLite`, `searchSearxng`,
`searchAnysearch`, `searchExa`, `searchExaMCP`, `searchTavily`,
`searchKeenable`, `searchPerplexity`, `searchDeepSeekOfficial`,
`searchPlatform`, `parseTimeRange`, `PLATFORMS`, `ALL_ENGINES`.

**Tidak** diekspor (diimplementasikan lokal di `lib/backends.js`):
`searchTinyFish`, `searchFirecrawl`, `searchMonid`.

`PLATFORMS` adalah **objek peta** id -> `{ name }`, bukan array.
Gunakan `Object.keys(PLATFORMS)`.

## Aturan operasional

- Node menyelesaikan modul dari **realpath**, jadi direktori plugin butuh
  `node_modules` sendiri berisi symlink ke `dsh-free-search`, `dsh-web-monid`,
  dan paket `@deepseek-ai/*` yang dipakai.
- Perubahan `dsh.profile.bundles` / `cordis.patch.yml` baru berlaku setelah
  `dsh web` di-restart.
- Jangan menguji tool plugin yang sedang dibangun sebelum proses host memuat
  kode baru; hasilnya berasal dari plugin lama.

## Perintah uji

```
node --check lib/backends.js lib/scheduler.js lib/index.js
node --test test/regression.test.mjs
```
