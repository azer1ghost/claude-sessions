import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

// honours CLAUDE_CONFIG_DIR, the same override Claude Code itself uses
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects')
export const TRASH_DIR = path.join(CLAUDE_DIR, '.session-browser-trash')
// kept outside the project so the dev server's file watcher never sees it
const CACHE_FILE = path.join(CLAUDE_DIR, '.session-browser-cache.json')

const BLOCK_LIMIT = 6000 // chars kept per tool block before truncation
const META_VERSION = 4   // bump to invalidate cached session metadata

/* ---------------------------------------------------------------- cache */

let metaCache = {}
try {
  metaCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
} catch {
  metaCache = {}
}
let cacheDirty = false
setInterval(flushCache, 5000).unref()

function flushCache() {
  if (!cacheDirty) return
  cacheDirty = false
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(metaCache))
  } catch {}
}

/* ------------------------------------------------------------- helpers */

const isJsonl = (n) => n.endsWith('.jsonl')

function cleanText(s = '') {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, (m) => m.replace(/<[^>]+>/g, ' '))
    .trim()
}

function textOfContent(content) {
  if (typeof content === 'string') return cleanText(content)
  if (!Array.isArray(content)) return ''
  return cleanText(
    content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  )
}

function truncate(s, n = BLOCK_LIMIT) {
  if (typeof s !== 'string') s = JSON.stringify(s, null, 2) ?? ''
  if (s.length <= n) return { text: s, truncated: false, total: s.length }
  return { text: s.slice(0, n), truncated: true, total: s.length }
}

function resultToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b) return ''
        if (b.type === 'text') return b.text
        if (b.type === 'image') return '[image]'
        return JSON.stringify(b)
      })
      .join('\n')
  }
  if (content == null) return ''
  return JSON.stringify(content, null, 2)
}

async function* lines(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) if (line) yield line
}

export async function dirSize(dir) {
  let total = 0
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(full)
    else
      try {
        total += (await fsp.stat(full)).size
      } catch {}
  }
  return total
}

/** Resolve a session file, or one of its subagent transcripts, safely. */
export function resolveFile(projectId, sessionId, sub = '') {
  const base = path.join(PROJECTS_DIR, projectId)
  if (!sub) return path.join(base, sessionId + '.jsonl')
  const root = path.resolve(base, sessionId)
  const full = path.resolve(root, sub)
  if (!full.startsWith(root + path.sep) || !full.endsWith('.jsonl')) throw new Error('bad subagent path')
  return full
}

/** All subagent / workflow transcripts that belong to one session. */
export async function listSubagents(projectId, sessionId) {
  const root = path.join(PROJECTS_DIR, projectId, sessionId)
  const out = []
  async function walk(dir) {
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (isJsonl(e.name)) {
        const rel = path.relative(root, full)
        try {
          const meta = await sessionMeta(projectId, sessionId, rel)
          const wf = rel.match(/workflows\/(wf_[^/]+)/)
          out.push({ ...meta, sub: rel, workflow: wf ? wf[1] : null })
        } catch {}
      }
    }
  }
  await walk(root)
  out.sort((a, b) => (a.firstTs || '').localeCompare(b.firstTs || ''))
  return out
}

export function decodeProjectId(id, fallbackCwd) {
  if (fallbackCwd) return fallbackCwd
  // dir names are the cwd with "/" replaced by "-" (lossy, best effort)
  return id.replace(/^-/, '/').replace(/-/g, '/')
}

/* ------------------------------------------------------------ projects */

const cwdCache = {}
const idPathCache = {}

/** Claude encodes a cwd by replacing "/", "_" and "." with "-", which is lossy.
    Walk the real filesystem to find the directory the id was encoded from. */
async function resolveFromId(id) {
  if (id in idPathCache) return idPathCache[id]
  const tokens = id.replace(/^-/, '').split('-')
  let base = '/'
  let i = 0
  while (i < tokens.length) {
    let entries = []
    try {
      entries = await fsp.readdir(base, { withFileTypes: true })
    } catch {
      return (idPathCache[id] = null)
    }
    let found = null
    for (let j = tokens.length; j > i; j--) {
      const want = tokens.slice(i, j).join('-')
      const hit = entries.find((e) => e.isDirectory() && e.name.replace(/[_.]/g, '-') === want)
      if (hit) {
        found = [path.join(base, hit.name), j]
        break
      }
    }
    if (!found) return (idPathCache[id] = null)
    base = found[0]
    i = found[1]
  }
  return (idPathCache[id] = base)
}

/** The real working directory of a project, read from its newest transcript. */
async function projectCwd(dir, files) {
  if (cwdCache[dir]) return cwdCache[dir]
  let newest = null
  let newestTime = 0
  for (const f of files) {
    try {
      const st = await fsp.stat(path.join(dir, f))
      if (st.mtimeMs > newestTime) { newestTime = st.mtimeMs; newest = path.join(dir, f) }
    } catch {}
  }
  if (!newest) return ''
  let n = 0
  try {
    for await (const line of lines(newest)) {
      if (++n > 80) break
      if (line.length > 400_000) continue
      let d
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      if (d.cwd) {
        cwdCache[dir] = d.cwd
        return d.cwd
      }
    }
  } catch {}
  return ''
}

export async function listProjects() {
  let entries = []
  try {
    entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = path.join(PROJECTS_DIR, e.name)
    let files = []
    try {
      files = (await fsp.readdir(dir)).filter(isJsonl)
    } catch {
      continue
    }
    if (!files.length) continue // nothing left in this project folder — hide it
    let mtime = 0
    for (const f of files) {
      try {
        const st = await fsp.stat(path.join(dir, f))
        if (st.mtimeMs > mtime) mtime = st.mtimeMs
      } catch {}
    }
    const size = await dirSize(dir)
    const cachedCwd =
      (await resolveFromId(e.name)) ||
      Object.values(metaCache).find((m) => m && m.projectId === e.name && m.cwd)?.cwd ||
      (await projectCwd(dir, files))
    out.push({
      id: e.name,
      path: decodeProjectId(e.name, cachedCwd),
      sessions: files.length,
      size,
      mtime,
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/* -------------------------------------------------------- session meta */

export async function sessionMeta(projectId, sessionId, sub = '') {
  const file = resolveFile(projectId, sessionId, sub)
  const st = await fsp.stat(file)
  const key = `${projectId}/${sessionId}${sub ? '::' + sub : ''}`
  const cached = metaCache[key]
  if (cached && cached.v === META_VERSION && cached.size === st.size && cached.mtime === st.mtimeMs) return cached

  const meta = {
    v: META_VERSION,
    id: sessionId,
    projectId,
    sub,
    agentName: '',
    size: st.size,
    mtime: st.mtimeMs,
    title: '',
    slug: '',
    firstPrompt: '',
    lastPrompt: '',
    cwd: '',
    gitBranch: '',
    version: '',
    models: [],
    counts: { user: 0, assistant: 0, tools: 0 },
    firstTs: null,
    lastTs: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    context: { last: 0, max: 0 },
    toolCounts: {},
    durationMs: 0,
    sidechain: 0,
    partial: false,
  }
  const models = new Set()

  for await (const line of lines(file)) {
    if (line.length > 400_000) {
      // giant line: classify cheaply, don't parse
      meta.partial = true
      if (line.includes('"type":"assistant"')) meta.counts.assistant++
      else if (line.includes('"type":"user"')) meta.counts.user++
      const m = line.match(/"timestamp":"([^"]+)"/)
      if (m) {
        if (!meta.firstTs) meta.firstTs = m[1]
        meta.lastTs = m[1]
      }
      continue
    }
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.type === 'agent-name' && d.agentName) meta.agentName = d.agentName
    if (d.type === 'ai-title' && d.aiTitle) meta.title = d.aiTitle
    if (d.type === 'summary' && d.summary && !meta.title) meta.title = d.summary
    if (d.timestamp) {
      if (!meta.firstTs) meta.firstTs = d.timestamp
      meta.lastTs = d.timestamp
    }
    if (d.cwd) meta.cwd = d.cwd
    if (d.gitBranch) meta.gitBranch = d.gitBranch
    if (d.version) meta.version = d.version
    if (d.slug && !meta.slug) meta.slug = d.slug
    if (d.isSidechain) meta.sidechain++

    if (d.type === 'user') {
      meta.counts.user++
      const t = textOfContent(d.message?.content)
      if (t) {
        if (!meta.firstPrompt) meta.firstPrompt = t.slice(0, 400)
        meta.lastPrompt = t.slice(0, 400)
      }
    } else if (d.type === 'assistant') {
      meta.counts.assistant++
      const msg = d.message || {}
      if (msg.model) models.add(msg.model)
      if (Array.isArray(msg.content))
        for (const b of msg.content)
          if (b?.type === 'tool_use') {
            meta.counts.tools++
            meta.toolCounts[b.name || '?'] = (meta.toolCounts[b.name || '?'] || 0) + 1
          }
      const u = msg.usage
      if (u) {
        meta.tokens.input += u.input_tokens || 0
        meta.tokens.output += u.output_tokens || 0
        meta.tokens.cacheRead += u.cache_read_input_tokens || 0
        meta.tokens.cacheWrite += u.cache_creation_input_tokens || 0
        // How full the context window was when this turn ran. A single assistant
        // record can cover several inference iterations whose top-level usage is
        // summed, so prefer the last iteration's own numbers.
        const it = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : u
        const ctx =
          (it.input_tokens || 0) + (it.cache_read_input_tokens || 0) + (it.cache_creation_input_tokens || 0)
        meta.context.last = ctx
        if (ctx > meta.context.max) meta.context.max = ctx
      }
    }
  }
  meta.models = [...models]
  if (meta.firstTs && meta.lastTs) meta.durationMs = Math.max(0, Date.parse(meta.lastTs) - Date.parse(meta.firstTs))
  if (!meta.title)
    meta.title =
      meta.agentName || meta.firstPrompt.slice(0, 80) || meta.slug || path.basename(file, '.jsonl').slice(0, 20)

  metaCache[key] = meta
  cacheDirty = true
  return meta
}

export async function listSessions(projectId) {
  const dir = path.join(PROJECTS_DIR, projectId)
  const files = (await fsp.readdir(dir)).filter(isJsonl)
  const out = []
  for (const f of files) {
    const id = f.slice(0, -6)
    try {
      out.push(await sessionMeta(projectId, id))
    } catch (e) {
      out.push({ id, projectId, error: String(e.message || e) })
    }
  }
  flushCache()
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  return out
}

/* --------------------------------------------------------------- sweep */

/** Cheap metadata for the cleanup preview: cached meta when we already have it,
    otherwise a head-scan that never parses the whole (possibly huge) file. */
async function quickMeta(projectId, sessionId) {
  const file = path.join(PROJECTS_DIR, projectId, sessionId + '.jsonl')
  const st = await fsp.stat(file)
  const cached = metaCache[`${projectId}/${sessionId}`]
  if (cached && cached.v === META_VERSION && cached.size === st.size && cached.mtime === st.mtimeMs)
    return {
      id: sessionId,
      projectId,
      title: cached.title,
      cwd: cached.cwd,
      size: st.size,
      mtime: st.mtimeMs,
      lastTs: cached.lastTs,
      messages: (cached.counts?.user || 0) + (cached.counts?.assistant || 0),
    }

  let title = ''
  let firstPrompt = ''
  let cwd = ''
  let n = 0
  try {
    for await (const line of lines(file)) {
      if (++n > 400) break
      if (line.length > 400_000) continue
      let d
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle
      if (d.cwd && !cwd) cwd = d.cwd
      if (!firstPrompt && d.type === 'user') firstPrompt = textOfContent(d.message?.content).slice(0, 120)
      if (title && cwd && firstPrompt) break
    }
  } catch {}

  return {
    id: sessionId,
    projectId,
    title: title || firstPrompt || sessionId.slice(0, 8),
    cwd,
    size: st.size,
    mtime: st.mtimeMs,
    lastTs: null,
    messages: null,
  }
}

/** Every top-level session last touched more than `days` ago. */
export async function staleSessions({ days = 30, projectId = '' } = {}) {
  const cutoff = Date.now() - days * 86400_000
  let projects = await listProjects()
  if (projectId) projects = projects.filter((p) => p.id === projectId)

  const items = []
  for (const p of projects) {
    const dir = path.join(PROJECTS_DIR, p.id)
    let files = []
    try {
      files = (await fsp.readdir(dir)).filter(isJsonl)
    } catch {
      continue
    }
    for (const f of files) {
      const full = path.join(dir, f)
      let st
      try {
        st = await fsp.stat(full)
      } catch {
        continue
      }
      if (st.mtimeMs >= cutoff) continue
      const id = f.slice(0, -6)
      const meta = await quickMeta(p.id, id)
      // subagent transcripts live in a sibling folder and go with the session
      const extras = await dirSize(path.join(dir, id))
      items.push({ ...meta, projectPath: p.path, extraSize: extras, totalSize: meta.size + extras })
    }
  }
  items.sort((a, b) => a.mtime - b.mtime)
  return {
    days,
    cutoff,
    count: items.length,
    size: items.reduce((a, i) => a + i.totalSize, 0),
    items,
  }
}

/** Move an explicit list of sessions to the trash in one go. */
export async function sweepSessions(list = []) {
  const done = []
  const failed = []
  let freed = 0
  for (const { projectId, id } of list) {
    if (!projectId || !id || projectId.includes('/') || id.includes('/') || projectId.includes('..') || id.includes('..')) {
      failed.push({ projectId, id, error: 'bad id' })
      continue
    }
    try {
      const dir = path.join(PROJECTS_DIR, projectId)
      const size = (await fsp.stat(path.join(dir, id + '.jsonl'))).size + (await dirSize(path.join(dir, id)))
      await trashSession(projectId, id)
      freed += size
      done.push({ projectId, id })
    } catch (e) {
      failed.push({ projectId, id, error: String(e.message || e) })
    }
  }
  return { moved: done.length, freed, failed }
}

/* ------------------------------------------------------------ messages */

const msgCache = new Map() // key -> { key, messages }
const MSG_CACHE_MAX = 4

function normalizeRecord(d, index) {
  const msg = d.message || {}
  const raw = msg.content
  const blocks = []
  let kind = d.type

  if (typeof raw === 'string') {
    const t = cleanText(raw)
    if (t) blocks.push({ t: 'text', text: t })
  } else if (Array.isArray(raw)) {
    for (const b of raw) {
      if (!b) continue
      if (b.type === 'text') {
        const t = cleanText(b.text || '')
        if (t) blocks.push({ t: 'text', text: t })
      } else if (b.type === 'thinking') {
        if (b.thinking) blocks.push({ t: 'thinking', ...truncate(b.thinking) })
      } else if (b.type === 'tool_use') {
        blocks.push({
          t: 'tool_use',
          name: b.name,
          id: b.id,
          ...truncate(JSON.stringify(b.input ?? {}, null, 2)),
        })
      } else if (b.type === 'tool_result') {
        blocks.push({
          t: 'tool_result',
          id: b.tool_use_id,
          isError: !!b.is_error,
          ...truncate(resultToText(b.content)),
        })
      } else if (b.type === 'image') {
        const data = b.source?.data
        blocks.push({
          t: 'image',
          media: b.source?.media_type || 'image/png',
          data: data && data.length < 4_000_000 ? data : null,
        })
      } else {
        blocks.push({ t: 'other', ...truncate(JSON.stringify(b, null, 2)) })
      }
    }
  }
  if (!blocks.length) return null
  if (d.type === 'user' && blocks.every((b) => b.t === 'tool_result')) kind = 'tool'

  return {
    i: index,
    uuid: d.uuid,
    role: d.type,
    kind,
    ts: d.timestamp || null,
    model: msg.model || null,
    sidechain: !!d.isSidechain,
    blocks,
  }
}

async function loadMessages(projectId, sessionId, sub = '') {
  const file = resolveFile(projectId, sessionId, sub)
  const st = await fsp.stat(file)
  const key = `${projectId}/${sessionId}::${sub}:${st.size}:${st.mtimeMs}`
  const hit = msgCache.get(key)
  if (hit) return hit.messages

  const messages = []
  let i = 0
  for await (const line of lines(file)) {
    if (line.length > 12_000_000) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.type !== 'user' && d.type !== 'assistant') continue
    const m = normalizeRecord(d, i)
    if (m) {
      messages.push(m)
      i++
    }
  }
  msgCache.set(key, { key, messages })
  while (msgCache.size > MSG_CACHE_MAX) msgCache.delete(msgCache.keys().next().value)
  return messages
}

export async function getMessages(projectId, sessionId, { offset = 0, limit = 60, filter = 'all', sub = '' } = {}) {
  let messages = await loadMessages(projectId, sessionId, sub)
  if (filter === 'chat') messages = messages.filter((m) => m.kind !== 'tool' && m.blocks.some((b) => b.t === 'text'))
  const total = messages.length
  // a negative offset means "the last page"
  const start = offset < 0 ? Math.max(0, total - limit) : offset
  return { total, offset: start, limit, messages: messages.slice(start, start + limit) }
}

export async function getBlock(projectId, sessionId, uuid, index, sub = '') {
  const file = resolveFile(projectId, sessionId, sub)
  for await (const line of lines(file)) {
    if (!line.includes(uuid)) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.uuid !== uuid) continue
    const raw = d.message?.content
    const b = Array.isArray(raw) ? raw[index] : null
    if (!b) return { text: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2) }
    if (b.type === 'tool_result') return { text: resultToText(b.content) }
    if (b.type === 'tool_use') return { text: JSON.stringify(b.input ?? {}, null, 2) }
    if (b.type === 'thinking') return { text: b.thinking || '' }
    return { text: b.text ?? JSON.stringify(b, null, 2) }
  }
  return { text: '', missing: true }
}

/* -------------------------------------------------------------- export */

export async function exportMarkdown(projectId, sessionId, sub = '') {
  const meta = await sessionMeta(projectId, sessionId, sub)
  const messages = await loadMessages(projectId, sessionId, sub)
  const out = [
    `# ${meta.title}`,
    '',
    `- Session: \`${sessionId}\``,
    `- Project: \`${meta.cwd || projectId}\``,
    `- Date: ${meta.firstTs || ''} → ${meta.lastTs || ''}`,
    `- Messages: ${messages.length}`,
    '',
    '---',
    '',
  ]
  for (const m of messages) {
    const who = m.kind === 'tool' ? 'Tool result' : m.role === 'user' ? 'User' : 'Claude'
    out.push(`### ${who}${m.ts ? ` · ${m.ts}` : ''}`, '')
    for (const b of m.blocks) {
      if (b.t === 'text') out.push(b.text, '')
      else if (b.t === 'thinking') out.push('<details><summary>thinking</summary>', '', b.text, '', '</details>', '')
      else if (b.t === 'tool_use') out.push(`**→ ${b.name}**`, '', '```json', b.text, '```', '')
      else if (b.t === 'tool_result') out.push('```', b.text, '```', '')
      else if (b.t === 'image') out.push('_[image]_', '')
    }
  }
  return out.join('\n')
}

/* --------------------------------------------------------------- trash */

export async function trashSession(projectId, sessionId) {
  const src = path.join(PROJECTS_DIR, projectId, sessionId + '.jsonl')
  await fsp.stat(src)
  const stamp = Date.now()
  const dir = path.join(TRASH_DIR, `${stamp}__${projectId}`)
  await fsp.mkdir(dir, { recursive: true })
  const dest = path.join(dir, sessionId + '.jsonl')
  await fsp.rename(src, dest).catch(async (e) => {
    if (e.code !== 'EXDEV') throw e
    await fsp.copyFile(src, dest)
    await fsp.unlink(src)
  })
  // the session's subagent / workflow transcripts live in a sibling folder
  const extras = path.join(PROJECTS_DIR, projectId, sessionId)
  if (fs.existsSync(extras)) await fsp.rename(extras, path.join(dir, sessionId)).catch(() => {})
  await fsp.writeFile(
    path.join(dir, '_restore.json'),
    JSON.stringify({ projectId, sessionId, kind: 'session', deletedAt: stamp, origin: src }, null, 2)
  )
  for (const k of Object.keys(metaCache)) if (k.startsWith(`${projectId}/${sessionId}`)) delete metaCache[k]
  cacheDirty = true
  flushCache()
  return { ok: true, trash: dir }
}

export async function listTrash() {
  let entries = []
  try {
    entries = await fsp.readdir(TRASH_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      const info = JSON.parse(await fsp.readFile(path.join(TRASH_DIR, e.name, '_restore.json'), 'utf8'))
      const files = (await fsp.readdir(path.join(TRASH_DIR, e.name))).filter(isJsonl)
      const size = await dirSize(path.join(TRASH_DIR, e.name))
      out.push({ entry: e.name, ...info, files: files.length, size })
    } catch {}
  }
  out.sort((a, b) => b.deletedAt - a.deletedAt)
  return out
}

export async function restoreTrash(entry) {
  const dir = path.join(TRASH_DIR, entry)
  const info = JSON.parse(await fsp.readFile(path.join(dir, '_restore.json'), 'utf8'))
  // kind 'project' only exists for entries trashed by older versions
  if (info.kind === 'project') {
    await fsp.rename(dir, path.join(PROJECTS_DIR, info.projectId))
    await fsp.unlink(path.join(PROJECTS_DIR, info.projectId, '_restore.json')).catch(() => {})
  } else {
    const destDir = path.join(PROJECTS_DIR, info.projectId)
    await fsp.mkdir(destDir, { recursive: true })
    await fsp.rename(path.join(dir, info.sessionId + '.jsonl'), path.join(destDir, info.sessionId + '.jsonl'))
    const extras = path.join(dir, info.sessionId)
    if (fs.existsSync(extras)) await fsp.rename(extras, path.join(destDir, info.sessionId)).catch(() => {})
    await fsp.rm(dir, { recursive: true, force: true })
  }
  return { ok: true }
}

export async function purgeTrash(entry) {
  if (entry) {
    await fsp.rm(path.join(TRASH_DIR, entry), { recursive: true, force: true })
  } else {
    await fsp.rm(TRASH_DIR, { recursive: true, force: true })
  }
  return { ok: true }
}

/* ---------------------------------------------------------------- misc */

export function sessionFile(projectId, sessionId, sub = '') {
  return resolveFile(projectId, sessionId, sub)
}

export async function stats() {
  const projects = await listProjects()
  return {
    projects: projects.length,
    sessions: projects.reduce((a, p) => a + p.sessions, 0),
    size: projects.reduce((a, p) => a + p.size, 0),
    dir: PROJECTS_DIR,
  }
}
