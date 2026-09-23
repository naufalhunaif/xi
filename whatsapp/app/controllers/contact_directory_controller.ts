import type { HttpContext } from '@adonisjs/core/http'
import { Readable } from 'node:stream'
import env from '#start/env'
import { contactDirectory, contactCsvRows, csvCell } from '#services/contact_directory_service'
import { inWorkspace, workspaceScope } from '#services/workspace_context'

export default class ContactDirectoryController {
  async page({ view, session }: HttpContext) {
    return view.render('pages/dashboard', {
      page: 'directory',
      account: session.get('account'),
      appUrl: env.get('APP_URL').replace(/\/$/, ''),
      bundle: (env.get('ACCOUNT_URL') || '')
        .replace(/\/$/, '')
        .replace(/\/account$/, ''),
    })
  }
  async index({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    return response.json(
      await contactDirectory({
        query: String(request.input('query', '')),
        page: Number(request.input('page', 1)),
      })
    )
  }
  async export({ request, response }: HttpContext) {
    const scope = { ...workspaceScope() }
    const query = String(request.input('query', '')).slice(0, 100)
    const headers =
      request.input('language') === 'id'
        ? ['Kontak', 'Nomor WhatsApp', 'Penerima', 'Nomor penerima', 'Alamat']
        : ['Contact', 'WhatsApp number', 'Recipient', 'Recipient number', 'Address']
    async function* csv() {
      yield '\uFEFF' + headers.map(csvCell).join(',') + '\r\n'
      let after = ''
      do {
        const data = await inWorkspace(scope, () => contactDirectory({ query, after, limit: 200 }))
        yield contactCsvRows(data.contacts)
        if (!data.next) break
        after = data.next
      } while (true)
    }
    response.header('Cache-Control', 'no-store')
    response.header('Content-Type', 'text/csv; charset=utf-8')
    response.header('Content-Disposition', 'attachment; filename="contacts-addresses.csv"')
    return response.stream(Readable.from(csv()))
  }
}
