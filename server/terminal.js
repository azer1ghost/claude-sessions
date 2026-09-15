import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { sessionMeta } from './store.js'

const APP = process.env.TERMINAL_APP || 'Terminal'
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} exited ${code}`))))
  })
}

/** Open a real terminal in the session's folder, resuming that session. */
export async function openInTerminal(req, res) {
  const { pid, sid } = req.params
  const meta = await sessionMeta(pid, sid)
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : os.homedir()
  const command = `cd ${shellQuote(cwd)} && ${CLAUDE_BIN} --resume ${sid}`

  try {
    if (process.platform === 'darwin') {
      const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const script = /iterm/i.test(APP)
        ? `tell application "${APP}"\n activate\n set w to (create window with default profile)\n tell current session of w to write text "${escaped}"\nend tell`
        : `tell application "${APP}"\n activate\n do script "${escaped}"\nend tell`
      await run('osascript', ['-e', script])
    } else if (process.platform === 'linux') {
      const term = process.env.TERMINAL_APP || 'x-terminal-emulator'
      await run(term, ['-e', 'bash', '-lc', `${command}; exec bash`])
    } else {
      throw new Error(`unsupported platform: ${process.platform}`)
    }
  } catch (e) {
    // the client falls back to copying the command
    return res.status(500).json({ error: String(e.message || e), command, cwd })
  }
  res.json({ ok: true, cwd, command })
}
