import { spawn } from 'node:child_process'
import path from 'node:path'
import { PROJECTS_DIR, sessionMeta } from './store.js'

const MAX_FILES = 120

/** Deep search: grep every session file for a literal string. */
export function deepSearch(query, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const files = []
    const proc = spawn('grep', ['-rilF', '--include=*.jsonl', '--', query, PROJECTS_DIR])
    let buf = ''
    let done = false

    const finish = (err) => {
      if (done) return
      done = true
      try { proc.kill('SIGTERM') } catch {}
      err ? reject(err) : resolve(files)
    }

    const timer = setTimeout(() => finish(null), 90_000)
    signal?.addEventListener('abort', () => finish(null))

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buf += chunk
      const parts = buf.split('\n')
      buf = parts.pop()
      for (const p of parts) {
        if (p) files.push(p)
        if (files.length >= MAX_FILES) return finish(null)
      }
    })
    proc.on('error', (e) => { clearTimeout(timer); finish(e) })
    proc.on('close', () => { clearTimeout(timer); if (buf) files.push(buf); finish(null) })
  })
}

export async function searchResults(query, signal) {
  const files = await deepSearch(query, { signal })
  const out = []
  for (const f of files) {
    const rel = path.relative(PROJECTS_DIR, f)
    const [projectId, base] = [path.dirname(rel), path.basename(rel, '.jsonl')]
    if (!projectId || projectId === '.') continue
    try {
      const meta = await sessionMeta(projectId, base)
      out.push(meta)
    } catch {}
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  return out
}
