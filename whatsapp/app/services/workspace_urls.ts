/** Account OAuth registers sibling bundle URLs, not arbitrary redirect origins. */
export function validateWorkspaceUrls(appUrl: string, accountUrl: string, basePath: string) {
  const app = new URL(appUrl)
  const path = app.pathname.replace(/\/$/, '')
  const base = basePath.replace(/\/$/, '')
  if (!accountUrl) {
    // Standalone: hanya APP_URL yang dicek; path boleh akar ('') atau sub-folder.
    if (app.protocol !== 'https:') throw new Error('Produksi memerlukan APP_URL dengan https://.')
    if (app.username || app.password || app.search || app.hash)
      throw new Error('APP_URL tidak boleh berisi kredensial, query, atau fragment.')
    if (path !== base) throw new Error('APP_BASE_PATH harus sama dengan path APP_URL (kosong bila di akar).')
    return
  }
  const account = new URL(accountUrl)
  if (app.protocol !== 'https:' || account.protocol !== 'https:')
    throw new Error('Produksi memerlukan APP_URL dan ACCOUNT_URL dengan https://.')
  if ([app, account].some((url) => url.username || url.password || url.search || url.hash))
    throw new Error('APP_URL dan ACCOUNT_URL tidak boleh berisi kredensial, query, atau fragment.')
  if (path !== basePath || !path.endsWith('/whatsapp'))
    throw new Error('APP_BASE_PATH harus sama dengan path APP_URL dan berakhir dengan /whatsapp.')
  if (
    app.origin !== account.origin ||
    account.pathname.replace(/\/$/, '') !== `${path.slice(0, -9)}/account`
  )
    throw new Error(
      'ACCOUNT_URL harus menunjuk /account di domain dan folder induk yang sama dengan APP_URL (termasuk www).'
    )
}
