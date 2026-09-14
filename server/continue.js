import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { sessionMeta } from './store.js'

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions'])

/**
 * Resume a recorded session and send it one more prompt, streaming Claude's
 * ndjson output straight back to the browser. The CLI appends to the very same
 * transcript file, so the new turns show up in the UI after a refresh.
 */
export async function continueSession(req, res) {
  const { pid, sid } = req.params
  const text = String(req.body?.text || '').trim()
  const mode = MODES.has(req.body?.permissionMode) ? req.body.permissionMode : 'default'
  if (!text) return res.status(400).json({ error: 'boş mesaj' })

  const meta = await sessionMeta(pid, sid)
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : process.cwd()

  const args = [
    '--resume', sid,
    '--print', text,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-prompts', 'none',
  ]
  if (mode !== 'default') args.push('--permission-mode', mode)

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('x-accel-buffering', 'no')
  res.flushHeaders?.()

  let child
  try {
    child = spawn(CLAUDE_BIN, args, { cwd, env: process.env })
  } catch (e) {
    res.write(JSON.stringify({ type: 'fatal', error: String(e.message || e) }) + '\n')
    return res.end()
  }

  res.write(JSON.stringify({ type: 'started', cwd, mode }) + '\n')
  child.stdout.pipe(res, { end: false })
  child.stderr.on('data', (d) => res.write(JSON.stringify({ type: 'stderr', text: String(d) }) + '\n'))
  child.on('error', (e) => {
    res.write(JSON.stringify({ type: 'fatal', error: String(e.message || e) }) + '\n')
    res.end()
  })
  child.on('close', (code) => {
    res.write(JSON.stringify({ type: 'exit', code }) + '\n')
    res.end()
  })
  req.on('close', () => child.kill('SIGTERM'))
}
