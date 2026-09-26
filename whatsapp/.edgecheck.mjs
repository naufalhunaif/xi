import { Edge } from 'edge.js'
const edge = Edge.create()
edge.mount(new URL('file://' + process.cwd() + '/resources/views/'))
for (const t of ['partials/settings/ai', 'pages/dashboard', 'components/layout']) {
  try { edge.asyncCompiler.compile(t); console.log('ok', t) } catch (e) { console.log('ERR', t, e.message) }
}
