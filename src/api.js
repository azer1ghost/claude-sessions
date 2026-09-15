const j = async (url, opts) => {
  const r = await fetch(url, opts)
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status} ${r.statusText}`)
  return r.json()
}

export const api = {
  stats: () => j('/api/stats'),
  projects: () => j('/api/projects'),
  sessions: (pid) => j(`/api/projects/${pid}/sessions`),
  session: (pid, sid, { offset = 0, limit = 60, filter = 'all', sub = '' } = {}) =>
    j(`/api/sessions/${pid}/${sid}?offset=${offset}&limit=${limit}&filter=${filter}&sub=${encodeURIComponent(sub)}`),
  subagents: (pid, sid) => j(`/api/sessions/${pid}/${sid}/subagents`),
  block: (pid, sid, uuid, i, sub = '') =>
    j(`/api/sessions/${pid}/${sid}/block?uuid=${uuid}&i=${i}&sub=${encodeURIComponent(sub)}`),
  search: (q) => j(`/api/search?q=${encodeURIComponent(q)}`),
  openTerminal: (pid, sid) => j(`/api/sessions/${pid}/${sid}/terminal`, { method: 'POST' }),
  deleteSession: (pid, sid) => j(`/api/sessions/${pid}/${sid}`, { method: 'DELETE' }),
  cleanupPreview: (days, project = '') =>
    j(`/api/cleanup/preview?days=${days}&project=${encodeURIComponent(project)}`),
  cleanup: (sessions) =>
    j('/api/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessions }),
    }),
  trash: () => j('/api/trash'),
  restore: (entry) => j('/api/trash/restore', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry }),
  }),
  purge: (entry) => j(`/api/trash${entry ? `?entry=${encodeURIComponent(entry)}` : ''}`, { method: 'DELETE' }),
}
