import express from 'express'
import fs from 'node:fs'
import {
  listProjects, listSessions, sessionMeta, getMessages, getBlock, exportMarkdown, listSubagents,
  staleSessions, sweepSessions,
  trashSession, listTrash, restoreTrash, purgeTrash, sessionFile, stats,
} from './store.js'
import { searchResults } from './search.js'
import { continueSession } from './continue.js'

const app = express()
app.use(express.json())

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e)
    res.status(500).json({ error: String(e.message || e) })
  })
}

const safeId = (s) => typeof s === 'string' && s.length && !s.includes('/') && !s.includes('..')

app.get('/api/stats', wrap(async (_req, res) => res.json(await stats())))

app.get('/api/projects', wrap(async (_req, res) => res.json(await listProjects())))

app.get('/api/projects/:pid/sessions', wrap(async (req, res) => {
  if (!safeId(req.params.pid)) return res.status(400).json({ error: 'bad project id' })
  res.json(await listSessions(req.params.pid))
}))

app.get('/api/sessions/:pid/:sid/subagents', wrap(async (req, res) => {
  const { pid, sid } = req.params
  if (!safeId(pid) || !safeId(sid)) return res.status(400).json({ error: 'bad id' })
  res.json(await listSubagents(pid, sid))
}))

app.get('/api/sessions/:pid/:sid', wrap(async (req, res) => {
  const { pid, sid } = req.params
  if (!safeId(pid) || !safeId(sid)) return res.status(400).json({ error: 'bad id' })
  const sub = String(req.query.sub || '')
  const meta = await sessionMeta(pid, sid, sub)
  const data = await getMessages(pid, sid, {
    offset: Number(req.query.offset) || 0, // negative = last page
    limit: Math.min(Number(req.query.limit) || 60, 400),
    filter: req.query.filter === 'chat' ? 'chat' : 'all',
    sub,
  })
  res.json({ meta, ...data })
}))

app.get('/api/sessions/:pid/:sid/block', wrap(async (req, res) => {
  const { pid, sid } = req.params
  if (!safeId(pid) || !safeId(sid)) return res.status(400).json({ error: 'bad id' })
  res.json(await getBlock(pid, sid, String(req.query.uuid || ''), Number(req.query.i) || 0, String(req.query.sub || '')))
}))

app.get('/api/sessions/:pid/:sid/export', wrap(async (req, res) => {
  const { pid, sid } = req.params
  if (!safeId(pid) || !safeId(sid)) return res.status(400).json({ error: 'bad id' })
  const md = await exportMarkdown(pid, sid, String(req.query.sub || ''))
  res.type('text/markdown; charset=utf-8')
  res.setHeader('content-disposition', `attachment; filename="${sid}.md"`)
  res.send(md)
}))

app.get('/api/sessions/:pid/:sid/raw', wrap(async (req, res) => {
  const { pid, sid } = req.params
  if (!safeId(pid) || !safeId(sid)) return res.status(400).json({ error: 'bad id' })
  res.setHeader('content-disposition', `attachment; filename="${sid}.jsonl"`)
  fs.createReadStream(sessionFile(pid, sid, String(req.query.sub || ''))).pipe(res)
}))

app.delete('/api/sessions/:pid/:sid', wrap(async (req, res) => {
  const { pid, sid } = req.params
  if (!safeId(pid) || !safeId(sid)) return res.status(400).json({ error: 'bad id' })
  res.json(await trashSession(pid, sid))
}))

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.json([])
  const ctrl = new AbortController()
  req.on('close', () => ctrl.abort())
  res.json(await searchResults(q, ctrl.signal))
}))

app.post('/api/sessions/:pid/:sid/continue', wrap(async (req, res) => {
  const { pid, sid } = req.params
  if (!safeId(pid) || !safeId(sid)) return res.status(400).json({ error: 'bad id' })
  await continueSession(req, res)
}))

app.get('/api/cleanup/preview', wrap(async (req, res) => {
  const days = Math.max(0, Number(req.query.days) || 30)
  const projectId = String(req.query.project || '')
  if (projectId && !safeId(projectId)) return res.status(400).json({ error: 'bad project id' })
  res.json(await staleSessions({ days, projectId }))
}))

app.post('/api/cleanup', wrap(async (req, res) => {
  const list = Array.isArray(req.body?.sessions) ? req.body.sessions : []
  if (!list.length) return res.status(400).json({ error: 'nothing selected' })
  res.json(await sweepSessions(list))
}))

app.get('/api/trash', wrap(async (_req, res) => res.json(await listTrash())))
app.post('/api/trash/restore', wrap(async (req, res) => res.json(await restoreTrash(String(req.body?.entry || '')))))
app.delete('/api/trash', wrap(async (req, res) => res.json(await purgeTrash(req.query.entry ? String(req.query.entry) : null))))

// serve the built frontend when it exists (npm run build && npm run preview / node server)
app.use(express.static('dist'))

const PORT = process.env.PORT || 5179
// loopback only: the API hands out full transcripts and can start Claude
const HOST = process.env.HOST || '127.0.0.1'
app.listen(PORT, HOST, () => console.log(`[api] http://${HOST}:${PORT}`))
