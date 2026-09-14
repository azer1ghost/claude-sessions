/* Tiny, dependency-free markdown renderer. Everything is escaped first,
   so nothing that comes out of a session file can inject HTML. */

export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|[\s])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
}

export function md(src = '') {
  const lines = String(src).split('\n')
  const out = []
  let i = 0
  let list = null // 'ul' | 'ol'

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // fenced code
    const fence = line.match(/^\s*```(\S*)\s*$/)
    if (fence) {
      closeList()
      const lang = fence[1]
      const body = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(
        `<pre data-lang="${esc(lang)}"><code>${esc(body.join('\n'))}</code></pre>`
      )
      continue
    }

    if (/^\s*$/.test(line)) { closeList(); i++; continue }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue }

    const q = line.match(/^\s*>\s?(.*)$/)
    if (q) { closeList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); i++; continue }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol'
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want }
      out.push(`<li>${inline((ul || ol)[1])}</li>`)
      i++
      continue
    }

    // table
    if (/\|/.test(line) && /^\s*\|?[-: |]+\|[-: |]*$/.test(lines[i + 1] || '')) {
      closeList()
      const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /\|/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>'
      )
      continue
    }

    closeList()
    const para = [line]
    i++
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i]))
      para.push(lines[i++])
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`)
  }
  closeList()
  return out.join('\n')
}
