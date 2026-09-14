export function bytes(n = 0) {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}

export function num(n = 0) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

const UNITS = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86400, 3600, 'hour'],
  [2592000, 86400, 'day'],
  [31536000, 2592000, 'month'],
  [Infinity, 31536000, 'year'],
]

export function ago(ts) {
  if (!ts) return ''
  const t = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!t) return ''
  const diff = Math.max(0, (Date.now() - t) / 1000)
  if (diff < 10) return 'just now'
  for (const [limit, div, unit] of UNITS) {
    if (diff >= limit) continue
    const n = Math.round(diff / div)
    return `${n} ${unit}${n === 1 ? '' : 's'} ago`
  }
  return ''
}

const p2 = (n) => String(n).padStart(2, '0')

export function dateTime(ts) {
  if (!ts) return ''
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts))
  if (isNaN(d)) return ''
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  return `${d.getDate()} ${month} ${d.getFullYear()}, ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
