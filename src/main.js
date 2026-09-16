import { api } from './api.js'
import { md, esc } from './md.js'
import { bytes, num, ago, dateTime } from './format.js'

/* ------------------------------------------------------------------ state */

const CONTEXT_WINDOW = 200_000
const LIVE_WINDOW = 120_000   // a transcript touched this recently counts as running
const POLL_EVERY = 8_000
const windowFor = (t) => (t > CONTEXT_WINDOW ? 1_000_000 : CONTEXT_WINDOW)

const state = {
  stats: null,
  projects: [],
  projectFilter: '',
  expanded: new Set(),
  sessionsByProject: {},   // pid -> [meta]
  loadingProjects: new Set(),
  project: null,
  view: 'empty',   // 'empty' | 'project' | 'session'
  session: null,
  sub: '',                 // subagent transcript currently open (relative path)
  subagents: [],
  meta: null,
  messages: [],
  total: 0,
  head: 0,      // index of the first loaded message; the window always ends at the last one
  limit: 60,
  chatLoading: false,
  hideTools: false,
  showDetails: true,
  live: { sessions: new Set(), projects: new Set() },  // written to in the last LIVE_WINDOW ms
  search: { q: '', active: false, loading: false, results: [] },
  modal: null,
}

const $ = (sel) => document.querySelector(sel)

let lastProjectClick = { id: null, at: 0 }

/* ------------------------------------------------------------------ theme */

function initTheme() {
  let saved = null
  try {
    saved = localStorage.getItem('cs-theme')
  } catch {}
  const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  return dark
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  try {
    localStorage.setItem('cs-theme', dark ? 'dark' : 'light')
  } catch {}
  renderThemeButton()
}

function renderThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark'
  const btn = $('#theme-btn')
  if (btn) btn.textContent = dark ? '☀' : '☾'
}

initTheme()

/* ------------------------------------------------------------------ shell */

$('#app').innerHTML = `
  <div class="flex h-full flex-col">
    <header class="flex shrink-0 items-center gap-3 border-b border-line bg-cream/70 px-4 py-2.5">
      <div class="flex items-center gap-2 text-sm font-semibold tracking-tight text-ink">
        <span class="grid h-6 w-6 place-items-center rounded-md bg-clay text-[13px] text-white">✦</span>
        <span class="font-display text-[15px]">Claude Sessions</span>
      </div>
      <div class="relative ml-2 flex-1 max-w-md">
        <input id="deep-search" placeholder="Search across all conversations…  (Enter)"
          class="w-full rounded-lg border border-line bg-card py-1.5 pl-8 pr-3 text-sm text-ink placeholder-ghost outline-none focus:border-clay/70" />
        <svg class="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </div>
      <div id="stats" class="ml-auto hidden text-xs text-muted lg:block"></div>
      <button id="theme-btn" data-action="toggle-theme" title="Light / dark theme"
        class="rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-muted hover:border-clay/60 hover:text-ink">☾</button>
      <button data-action="toggle-details" class="rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-muted hover:border-clay/60 hover:text-ink">Details</button>
      <button data-action="cleanup" class="rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-muted hover:border-clay/60 hover:text-ink">Cleanup</button>
      <button data-action="trash" class="rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-muted hover:border-clay/60 hover:text-ink">Trash</button>
      <button data-action="refresh" class="rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-muted hover:border-clay/60 hover:text-ink">Refresh</button>
    </header>

    <main class="flex min-h-0 flex-1">
      <aside id="tree" class="flex w-80 shrink-0 flex-col border-r border-line bg-cream/60"></aside>
      <section id="chat" class="flex min-w-0 flex-1 flex-col"></section>
      <aside id="details" class="hidden w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-cream/60 xl:flex"></aside>
    </main>
  </div>
  <div id="modal"></div>
  <div id="toast" class="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2"></div>
`

let toastTimer
function toast(msg, kind = 'ok') {
  clearTimeout(toastTimer)
  $('#toast').innerHTML = `<div class="pointer-events-auto rounded-lg border px-3.5 py-2 text-sm shadow-xl ${
    kind === 'err' ? 'border-rust/50 bg-rust/10 text-rust' : 'border-line bg-card text-ink'
  }">${esc(msg)}</div>`
  toastTimer = setTimeout(() => ($('#toast').innerHTML = ''), 3500)
}

/* ------------------------------------------------------------------- tree */

const projectName = (p) => p.path.split('/').filter(Boolean).slice(-2).join('/') || p.path

const liveDot = (on) => (on ? '<span class="live-dot" title="active right now"></span>' : '')

function sessionRow(s, { nested = true } = {}) {
  const on = state.session === s.id && state.view === 'session'
  const msgs = (s.counts?.user ?? 0) + (s.counts?.assistant ?? 0)
  return `
  <div data-action="open-session" data-pid="${esc(s.projectId)}" data-sid="${esc(s.id)}"
    class="group flex cursor-pointer items-start gap-2 rounded-r-md py-1.5 pr-1.5 ${
      nested ? 'ml-[18px] border-l-2 pl-2.5' : 'pl-2'
    } ${on ? 'border-clay bg-clay-soft' : nested ? 'border-line hover:border-ghost hover:bg-cream/70' : 'hover:bg-cream/70'}">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5">
        ${liveDot(state.live.sessions.has(`${s.projectId}/${s.id}`))}
        <div class="truncate text-[12px] leading-tight ${on ? 'font-medium text-clay' : 'text-muted'}">${esc(s.title || s.id)}</div>
      </div>
      ${nested ? '' : `<div class="truncate text-[10px] text-muted">${esc(s.cwd || s.projectId)}</div>`}
      <div class="mt-0.5 flex items-center gap-1.5 text-[10px] text-faint">
        <span>${esc(ago(s.lastTs || s.mtime))}</span><span>·</span><span>${msgs} msgs</span>
        <span>·</span><span>${bytes(s.size)}</span>
        ${s.context?.last ? `<span>·</span><span class="${ctxColor(s.context.last)}">${Math.round((s.context.last / windowFor(s.context.last)) * 100)}% ctx</span>` : ''}
      </div>
    </div>
    <button data-action="del-session" data-pid="${esc(s.projectId)}" data-sid="${esc(s.id)}" title="Delete session"
      class="mt-0.5 hidden shrink-0 rounded p-0.5 text-muted hover:bg-rust/10 hover:text-rust group-hover:block">
      <svg class="pointer-events-none h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
    </button>
  </div>`
}

function ctxColor(t) {
  const pct = (t / windowFor(t)) * 100
  if (pct >= 85) return 'text-rust'
  if (pct >= 60) return 'text-honey'
  return 'text-moss'
}

function renderTree() {
  const el = $('#tree')
  const focused = document.activeElement
  const keepFilter = focused?.id === 'project-filter' ? focused.selectionStart : null
  const keepScroll = $('#tree-scroll')?.scrollTop ?? 0
  const q = state.projectFilter.toLowerCase()
  const list = state.projects.filter((p) => !q || p.path.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))

  const searchBlock = state.search.active
    ? `<div class="border-b border-line bg-cream/70 p-1.5">
         <div class="flex items-center gap-2 px-1 pb-1">
           <span class="text-[11px] font-semibold text-ink-soft">Search: “${esc(state.search.q)}”</span>
           <button data-action="clear-search" class="ml-auto text-[10.5px] text-muted hover:text-ink">clear</button>
         </div>
         ${
           state.search.loading
             ? `<div class="px-1 py-3 text-center text-[11px] text-muted">Searching… may take 10-60s across a large archive</div>`
             : state.search.results.length
               ? `<div class="max-h-72 overflow-y-auto">${state.search.results.map((s) => sessionRow(s, { nested: false })).join('')}</div>`
               : `<div class="px-1 py-3 text-center text-[11px] text-faint">No matches</div>`
         }
       </div>`
    : ''

  el.innerHTML = `
    <div class="shrink-0 border-b border-line p-2">
      <input id="project-filter" value="${esc(state.projectFilter)}" placeholder="Filter projects…"
        class="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-ink placeholder-ghost outline-none focus:border-clay/70" />
    </div>
    ${searchBlock}
    <div id="tree-scroll" class="min-h-0 flex-1 overflow-y-auto p-1.5">
      ${
        list.length
          ? list
              .map((p) => {
                const open = state.expanded.has(p.id)
                const viewing = state.view === 'project' && state.project?.id === p.id
                const sessions = state.sessionsByProject[p.id]
                return `
        <div class="mb-1.5">
          <div data-action="toggle-project" data-id="${esc(p.id)}" title="double-click to list the sessions in the main pane"
            class="group flex cursor-pointer select-none items-center gap-1.5 rounded-lg border px-2 py-1.5 ${
              viewing
                ? 'border-clay/60 bg-clay-soft'
                : open
                  ? 'border-line bg-card'
                  : 'border-transparent hover:border-line hover:bg-card/60'
            }">
            <svg class="h-3 w-3 shrink-0 text-ghost transition-transform ${open ? 'rotate-90' : ''}" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
            <svg class="h-4 w-4 shrink-0 ${viewing ? 'text-clay' : 'text-clay/70'}" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
              <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z"/>
            </svg>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                ${liveDot(state.live.projects.has(p.id))}
                <div class="truncate text-[13px] font-semibold tracking-tight ${viewing ? 'text-clay' : 'text-ink'}">${esc(projectName(p))}</div>
              </div>
              <div class="truncate text-[10px] text-faint">${p.sessions} sessions · ${bytes(p.size)} · ${esc(ago(p.mtime))}</div>
            </div>
          </div>
          ${
            open
              ? state.loadingProjects.has(p.id)
                ? `<div class="ml-5 py-2 text-[11px] text-muted">loading sessions…</div>`
                : sessions?.length
                  ? `<div class="mt-0.5">${sessions.map((s) => sessionRow(s)).join('')}</div>`
                  : `<div class="ml-5 py-2 text-[11px] text-faint">no sessions</div>`
              : ''
          }
        </div>`
              })
              .join('')
          : `<div class="p-4 text-center text-xs text-faint">No projects</div>`
      }
    </div>`

  // a background refresh must not move the reader: put scroll, focus and caret back
  const scroller = $('#tree-scroll')
  if (scroller) scroller.scrollTop = keepScroll
  if (keepFilter !== null) {
    const inp = $('#project-filter')
    inp?.focus()
    inp?.setSelectionRange(keepFilter, keepFilter)
  }
}

/* ------------------------------------------------------------------- chat */

const ROLE_STYLE = {
  user: { label: 'You', cls: 'border-line bg-cream/70', dot: 'bg-clay/60' },
  assistant: { label: 'Claude', cls: 'border-line bg-paper', dot: 'bg-clay' },
  tool: { label: 'Tool result', cls: 'border-line bg-cream/40', dot: 'bg-ghost' },
}

function blockHtml(m, b, i) {
  const more = b.truncated
    ? `<button data-action="expand" data-uuid="${esc(m.uuid)}" data-i="${i}"
         class="mt-1.5 rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-ink">
         ${num(b.total - b.text.length)} more characters — show</button>`
    : ''

  if (b.t === 'text') return `<div class="md text-[13.5px] text-ink">${md(b.text)}</div>`

  if (b.t === 'thinking')
    return `<details class="rounded-lg border border-line bg-paper">
      <summary class="cursor-pointer select-none px-2.5 py-1 text-[11.5px] text-plum">thinking</summary>
      <div class="whitespace-pre-wrap border-t border-line px-2.5 py-2 text-[12.5px] text-muted">${esc(b.text)}${more}</div>
    </details>`

  if (b.t === 'tool_use')
    return `<details class="rounded-lg border border-line bg-paper">
      <summary class="cursor-pointer select-none px-2.5 py-1 text-[11.5px] text-moss">→ ${esc(b.name)}</summary>
      <pre class="overflow-x-auto border-t border-line px-2.5 py-2 text-[11.5px] text-muted">${esc(b.text)}</pre>${more}
    </details>`

  if (b.t === 'tool_result')
    return `<details class="rounded-lg border ${b.isError ? 'border-rust/40' : 'border-line'} bg-paper">
      <summary class="cursor-pointer select-none px-2.5 py-1 text-[11.5px] ${b.isError ? 'text-rust' : 'text-muted'}">
        ${b.isError ? '⚠ result (error)' : 'result'} · ${num(b.total)} chars</summary>
      <pre class="max-h-96 overflow-auto whitespace-pre-wrap border-t border-line px-2.5 py-2 text-[11.5px] text-muted">${esc(b.text)}</pre>${more}
    </details>`

  if (b.t === 'image')
    return b.data
      ? `<img src="data:${esc(b.media)};base64,${b.data}" class="max-h-96 rounded-lg border border-line" />`
      : `<div class="text-[11.5px] text-faint">[image — too large]</div>`

  return `<pre class="overflow-x-auto rounded-lg border border-line bg-paper p-2 text-[11.5px] text-muted">${esc(b.text || '')}</pre>${more}`
}

function messageHtml(m) {
  const style = ROLE_STYLE[m.kind] || ROLE_STYLE.assistant
  return `
  <article class="rounded-xl border ${style.cls} px-3.5 py-3">
    <header class="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
      <span class="h-1.5 w-1.5 rounded-full ${style.dot}"></span>
      <span class="font-medium text-muted">${style.label}</span>
      ${m.model ? `<span class="text-faint">${esc(m.model)}</span>` : ''}
      ${m.sidechain ? `<span class="rounded bg-line px-1 text-[10px] text-muted">subagent</span>` : ''}
      <span class="ml-auto">${esc(m.ts ? dateTime(m.ts) : '')}</span>
    </header>
    <div class="space-y-2">${m.blocks.map((b, i) => blockHtml(m, b, i)).join('')}</div>
  </article>`
}

// re-rendering the main pane must not throw the reader back to the top
let paneKey = null
const mainScroller = () => $('#chat-scroll') || $('#project-scroll')
const currentPaneKey = () =>
  state.view === 'project' ? `p|${state.project?.id || ''}` : `s|${state.session || ''}|${state.sub}`

function renderChat() {
  const key = currentPaneKey()
  const before = mainScroller()
  const keep = before && paneKey === key ? before.scrollTop : null
  renderPane()
  paneKey = key
  const after = mainScroller()
  if (after && keep !== null) after.scrollTop = keep
}

function renderPane() {
  const el = $('#chat')
  if (state.view === 'project') return renderProjectView(el)
  if (!state.session || state.view !== 'session') {
    el.innerHTML = `
      <div class="grid h-full place-items-center p-8 text-center">
        <div class="max-w-sm">
          <div class="text-4xl">🗂️</div>
          <h2 class="mt-3 text-sm font-semibold text-ink-soft">Claude Code session browser</h2>
          <p class="mt-1.5 text-xs leading-relaxed text-muted">
            Open a project in the tree on the left and pick a session — the full conversation shows up here,
            with context usage, timing, size and tool stats in the panel on the right.
          </p>
        </div>
      </div>`
    return
  }
  const m = state.meta || {}
  const shown = state.messages.filter((x) => !(state.hideTools && x.kind === 'tool'))
  el.innerHTML = `
    <header class="shrink-0 border-b border-line bg-paper px-4 py-2.5">
      <div class="flex items-center gap-2">
        <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">${esc(m.title || state.session)}</h2>
        <label class="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
          <input type="checkbox" data-action="toggle-tools" ${state.hideTools ? 'checked' : ''} class="accent-clay" /> hide tools
        </label>
        <button data-action="jump-end" class="rounded-lg border border-line px-2 py-1 text-[11px] text-muted hover:text-ink">jump to end</button>
        ${
          state.sub
            ? ''
            : `<button data-action="open-terminal" class="rounded-lg border border-clay/50 bg-clay-soft px-2 py-1 text-[11px] font-medium text-clay hover:border-clay">
                 ⌘ open in terminal
               </button>`
        }
        <a href="/api/sessions/${esc(m.projectId)}/${esc(state.session)}/export?sub=${encodeURIComponent(state.sub)}" class="rounded-lg border border-line px-2 py-1 text-[11px] text-muted hover:text-ink">.md</a>
        <a href="/api/sessions/${esc(m.projectId)}/${esc(state.session)}/raw?sub=${encodeURIComponent(state.sub)}" class="rounded-lg border border-line px-2 py-1 text-[11px] text-muted hover:text-ink">.jsonl</a>
        ${
          state.sub
            ? ''
            : `<button data-action="del-session" data-pid="${esc(m.projectId)}" data-sid="${esc(state.session)}"
                 class="rounded-lg border border-line px-2 py-1 text-[11px] text-rust hover:border-rust/60 hover:text-rust">delete</button>`
        }
      </div>
      ${
        state.sub
          ? `<div class="mt-1.5 flex items-center gap-2">
               <button data-action="back-to-parent" class="rounded-md border border-plum/40 bg-plum/10 px-2 py-0.5 text-[10.5px] text-plum hover:text-plum">← back to main session</button>
               <span class="truncate text-[10.5px] text-plum">subagent · ${esc(state.sub)}</span>
             </div>`
          : `<div class="mt-1 truncate text-[10.5px] text-faint">${esc(m.cwd || m.projectId || '')}${m.gitBranch ? ` · ${esc(m.gitBranch)}` : ''}</div>`
      }
    </header>
    <div id="chat-scroll" class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-4xl space-y-2.5 p-4">
        ${state.chatLoading && !state.messages.length ? `<div class="py-10 text-center text-xs text-muted">Loading… (a few seconds for large sessions)</div>` : ''}
        ${
          state.head > 0
            ? `<button data-action="load-earlier" class="w-full rounded-lg border border-line py-2 text-xs text-muted hover:border-clay/60 hover:text-ink">
                 ${state.chatLoading ? 'Loading…' : `Load ${Math.min(state.limit, state.head)} earlier messages (${state.total - state.head}/${state.total})`}
               </button>`
            : state.messages.length
              ? `<div class="py-2 text-center text-[11px] text-ghost">— start of session —</div>`
              : ''
        }
        ${shown.map(messageHtml).join('')}
        ${state.messages.length ? `<div class="py-4 text-center text-[11px] text-ghost">— end of session —</div>` : ''}
      </div>
    </div>
`
}

function renderProjectView(el) {
  const p = state.project
  if (!p) return (el.innerHTML = '')
  const sessions = state.sessionsByProject[p.id]
  const loading = state.loadingProjects.has(p.id)
  const totals = (sessions || []).reduce(
    (a, s) => {
      a.msgs += (s.counts?.user || 0) + (s.counts?.assistant || 0)
      a.tools += s.counts?.tools || 0
      a.out += s.tokens?.output || 0
      return a
    },
    { msgs: 0, tools: 0, out: 0 }
  )

  el.innerHTML = `
    <header class="shrink-0 border-b border-line bg-cream/70 px-4 py-2.5">
      <div class="flex items-center gap-2">
        <svg class="h-5 w-5 shrink-0 text-clay" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
          <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z"/>
        </svg>
        <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">${esc(projectName(p))}</h2>
        <button data-action="cleanup-project" class="rounded-lg border border-line px-2 py-1 text-[11px] text-muted hover:border-clay/60 hover:text-ink">clean up old</button>
        <button data-action="reload-project" class="rounded-lg border border-line px-2 py-1 text-[11px] text-muted hover:border-clay/60 hover:text-ink">reload</button>
      </div>
      <div class="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-faint">
        <span>${esc(p.path)}</span>
        <span>· ${p.sessions} sessions</span>
        <span>· ${bytes(p.size)}</span>
        <span>· last activity ${esc(ago(p.mtime))}</span>
        ${totals.msgs ? `<span>· ${num(totals.msgs)} messages</span>` : ''}
        ${totals.tools ? `<span>· ${num(totals.tools)} tool calls</span>` : ''}
        ${totals.out ? `<span>· ${num(totals.out)} output tokens</span>` : ''}
      </div>
    </header>
    <div id="project-scroll" class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-4xl space-y-1.5 p-4">
        ${
          loading
            ? `<div class="py-10 text-center text-xs text-muted">Reading sessions…</div>`
            : !sessions?.length
              ? `<div class="py-10 text-center text-xs text-faint">This project has no sessions.</div>`
              : sessions
                  .map((s) => {
                    const msgs = (s.counts?.user ?? 0) + (s.counts?.assistant ?? 0)
                    const ctx = s.context?.last || 0
                    return `
          <div data-action="open-session" data-pid="${esc(s.projectId)}" data-sid="${esc(s.id)}"
            class="group cursor-pointer rounded-xl border border-line bg-card px-3.5 py-3 hover:border-clay/50">
            <div class="flex items-start gap-2">
              ${liveDot(state.live.sessions.has(`${s.projectId}/${s.id}`))}
              <h3 class="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">${esc(s.title || s.id)}</h3>
              <button data-action="del-session" data-pid="${esc(s.projectId)}" data-sid="${esc(s.id)}" title="Delete session"
                class="hidden shrink-0 rounded p-0.5 text-muted hover:bg-rust/10 hover:text-rust group-hover:block">
                <svg class="pointer-events-none h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
              </button>
            </div>
            ${s.firstPrompt ? `<p class="mt-1 line-clamp-2 text-[12px] leading-snug text-muted">${esc(s.firstPrompt.slice(0, 220))}</p>` : ''}
            <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-faint">
              <span>${esc(dateTime(s.lastTs || s.mtime))}</span>
              <span>· ${esc(ago(s.lastTs || s.mtime))}</span>
              <span>· ${msgs} messages</span>
              <span>· ${bytes(s.size)}</span>
              ${s.counts?.tools ? `<span>· ${s.counts.tools} tools</span>` : ''}
              ${ctx ? `<span>· <span class="${ctxColor(ctx)}">${Math.round((ctx / windowFor(ctx)) * 100)}% ctx</span></span>` : ''}
              ${s.models?.length ? `<span>· ${esc(s.models.join(', '))}</span>` : ''}
            </div>
          </div>`
                  })
                  .join('')
        }
      </div>
    </div>`
}

/* ---------------------------------------------------------------- details */

function duration(ms) {
  if (!ms) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const mnt = Math.round(s / 60)
  if (mnt < 60) return `${mnt} min`
  const h = Math.floor(mnt / 60)
  return `${h}h ${mnt % 60}m`
}

const row = (k, v, cls = '') =>
  `<div class="flex items-baseline gap-2 py-1"><span class="w-24 shrink-0 text-[11px] text-muted">${esc(k)}</span><span class="min-w-0 flex-1 break-words text-[11.5px] ${cls || 'text-ink-soft'}">${v}</span></div>`

function renderDetails() {
  const el = $('#details')
  el.classList.toggle('hidden', !state.showDetails)
  el.classList.toggle('xl:flex', state.showDetails)
  el.classList.toggle('flex', state.showDetails)
  if (!state.showDetails) return
  if (state.view === 'project') {
    const p = state.project
    const sessions = state.sessionsByProject[p?.id] || []
    const top = [...sessions].sort((a, b) => b.size - a.size).slice(0, 6)
    el.innerHTML = p
      ? `<div class="space-y-4 p-3.5">
          <section>
            <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Project</h3>
            ${row('Folder', esc(p.path), 'text-clay')}
            ${row('Sessions', String(p.sessions))}
            ${row('On disk', bytes(p.size))}
            ${row('Last active', esc(ago(p.mtime)))}
          </section>
          ${
            top.length
              ? `<section>
                  <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Largest sessions</h3>
                  <div class="space-y-1">
                    ${top
                      .map(
                        (s) => `
                      <div data-action="open-session" data-pid="${esc(s.projectId)}" data-sid="${esc(s.id)}"
                        class="cursor-pointer rounded-md border border-line px-2 py-1.5 hover:border-clay/60">
                        <div class="truncate text-[11.5px] text-ink-soft">${esc(s.title || s.id)}</div>
                        <div class="text-[10px] text-faint">${bytes(s.size)} · ${esc(ago(s.lastTs || s.mtime))}</div>
                      </div>`
                      )
                      .join('')}
                  </div>
                </section>`
              : ''
          }
        </div>`
      : ''
    return
  }

  const m = state.meta
  if (!m || state.view !== 'session') {
    el.innerHTML = `<div class="p-4 text-[11.5px] text-faint">No session selected</div>`
    return
  }
  const ctx = m.context || { last: 0, max: 0 }
  const win = windowFor(Math.max(ctx.last, ctx.max))
  const pct = Math.min(100, Math.round((ctx.last / win) * 100))
  const pctMax = Math.min(100, Math.round((ctx.max / win) * 100))
  const tools = Object.entries(m.toolCounts || {}).sort((a, b) => b[1] - a[1])
  const t = m.tokens || {}

  el.innerHTML = `
    <div class="space-y-4 p-3.5">
      <section>
        <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Context usage</h3>
        <div class="rounded-lg border border-line bg-cream/70 p-2.5">
          <div class="flex items-baseline justify-between">
            <span class="text-lg font-semibold ${ctxColor(ctx.last)}">${pct}%</span>
            <span class="text-[11px] text-muted">${num(ctx.last)} / ${num(win)}</span>
          </div>
          <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
            <div class="h-full rounded-full ${pct >= 85 ? 'bg-red-500' : pct >= 60 ? 'bg-honey' : 'bg-moss'}" style="width:${pct}%"></div>
          </div>
          <div class="mt-1.5 text-[10.5px] text-faint">last turn · peak: ${pctMax}% (${num(ctx.max)})</div>
        </div>
      </section>

      <section>
        <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Time</h3>
        ${row('Started', esc(dateTime(m.firstTs)))}
        ${row('Last', esc(dateTime(m.lastTs)))}
        ${row('Duration', duration(m.durationMs))}
        ${row('Modified', esc(ago(m.mtime)))}
      </section>

      <section>
        <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Size</h3>
        ${row('File', bytes(m.size))}
        ${row('Messages', `${m.counts.user} user · ${m.counts.assistant} assistant`)}
        ${row('Tools', String(m.counts.tools))}
        ${m.sidechain ? row('Subagents', `${m.sidechain} records`) : ''}
      </section>

      <section>
        <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Tokens (total)</h3>
        ${row('Output', num(t.output || 0), 'text-clay')}
        ${row('Input', num(t.input || 0))}
        ${row('Cache write', num(t.cacheWrite || 0))}
        ${row('Cache read', num(t.cacheRead || 0), 'text-muted')}
      </section>

      ${
        tools.length
          ? `<section>
        <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Tools used</h3>
        <div class="space-y-1">
          ${tools
            .map(
              ([name, n]) => `
            <div class="flex items-center gap-2">
              <span class="w-28 shrink-0 truncate text-[11px] text-muted">${esc(name)}</span>
              <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                <div class="h-full rounded-full bg-moss/70" style="width:${Math.round((n / tools[0][1]) * 100)}%"></div>
              </div>
              <span class="w-7 shrink-0 text-right text-[10.5px] text-muted">${n}</span>
            </div>`
            )
            .join('')}
        </div>
      </section>`
          : ''
      }

      ${
        state.subagents.length
          ? `<section>
        <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Subagents (${state.subagents.length})</h3>
        <div class="space-y-1">
          ${state.subagents
            .map(
              (s) => `
            <div data-action="open-sub" data-sub="${esc(s.sub)}"
              class="cursor-pointer rounded-md border px-2 py-1.5 ${
                state.sub === s.sub ? 'border-plum bg-plum/10' : 'border-line hover:border-line'
              }">
              <div class="truncate text-[11.5px] text-ink-soft">${esc(s.title || s.sub)}</div>
              <div class="truncate text-[10px] text-faint">
                ${s.workflow ? `${esc(s.workflow)} · ` : ''}${(s.counts?.user ?? 0) + (s.counts?.assistant ?? 0)} msj · ${bytes(s.size)}
              </div>
            </div>`
            )
            .join('')}
        </div>
      </section>`
          : ''
      }

      <section>
        <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Environment</h3>
        ${row('Folder', esc(m.cwd || m.projectId), 'text-muted')}
        ${m.gitBranch ? row('Branch', esc(m.gitBranch)) : ''}
        ${m.models?.length ? row('Model', esc(m.models.join(', '))) : ''}
        ${m.version ? row('CLI', esc(m.version)) : ''}
        ${row('Session', `<span class="font-mono text-[10px] text-muted">${esc(m.id)}</span>`)}
      </section>

      <button data-action="copy-resume" data-sid="${esc(m.id)}" data-cwd="${esc(m.cwd || '')}"
        class="w-full rounded-lg border border-line py-1.5 text-[11px] text-muted hover:border-line hover:text-ink">
        copy claude --resume command
      </button>
      ${m.partial ? `<p class="text-[10.5px] text-honey">Note: this session contains very large lines, so some stats are approximate.</p>` : ''}
    </div>`
}

function renderStats() {
  const s = state.stats
  $('#stats').innerHTML = s ? `${s.projects} projects · ${s.sessions} sessions · ${bytes(s.size)}` : ''
}

/* ------------------------------------------------------------------ modal */

function renderModal() {
  const el = $('#modal')
  if (!state.modal) return (el.innerHTML = '')
  const m = state.modal
  if (m.kind === 'confirm') {
    el.innerHTML = `
      <div data-action="close-modal" class="fixed inset-0 z-40 grid place-items-center bg-ink/25 p-4">
        <div data-stop class="w-full max-w-sm rounded-xl border border-line bg-card p-4 shadow-2xl">
          <h3 class="text-sm font-semibold text-ink">${esc(m.title)}</h3>
          <p class="mt-1.5 text-xs leading-relaxed text-muted">${esc(m.body)}</p>
          <div class="mt-4 flex justify-end gap-2">
            <button data-action="close-modal" class="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-ink">Cancel</button>
            <button data-action="confirm-yes" class="rounded-lg bg-rust px-3 py-1.5 text-xs font-medium text-white hover:bg-rust/85">Delete</button>
          </div>
        </div>
      </div>`
    return
  }
  if (m.kind === 'cleanup') {
    const d = m.data
    const selectedItems = d ? d.items.filter((i) => m.selected.has(`${i.projectId}/${i.id}`)) : []
    const selSize = selectedItems.reduce((a, i) => a + i.totalSize, 0)
    el.innerHTML = `
      <div data-action="close-modal" class="fixed inset-0 z-40 grid place-items-center bg-ink/25 p-4">
        <div data-stop class="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border border-line bg-card shadow-2xl">
          <div class="flex items-center gap-2 border-b border-line px-4 py-3">
            <h3 class="text-sm font-semibold text-ink">Delete old sessions</h3>
            <button data-action="close-modal" class="ml-auto rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted hover:text-ink">close</button>
          </div>

          <div class="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
            <label class="text-[11px] text-muted">
              Older than
              <div class="mt-1 flex items-center gap-1.5">
                <input id="cleanup-days" type="number" min="1" max="3650" value="${m.days}"
                  class="w-20 rounded-lg border border-line bg-paper px-2 py-1.5 text-[13px] text-ink outline-none focus:border-clay/70" />
                <span class="text-[12px] text-ink-soft">days</span>
              </div>
            </label>
            <label class="text-[11px] text-muted">
              Scope
              <select id="cleanup-scope" class="mt-1 block rounded-lg border border-line bg-paper px-2 py-1.5 text-[12px] text-ink outline-none">
                <option value="all" ${m.scope === 'all' ? 'selected' : ''}>All projects</option>
                ${
                  state.project
                    ? `<option value="project" ${m.scope === 'project' ? 'selected' : ''}>${esc(projectName(state.project))} only</option>`
                    : ''
                }
              </select>
            </label>
            <button data-action="cleanup-preview" class="rounded-lg border border-line bg-paper px-3 py-1.5 text-xs text-ink hover:border-clay/60">
              ${m.loading ? 'Scanning…' : 'Preview'}
            </button>
            ${
              d
                ? `<div class="ml-auto text-[11.5px] text-muted">
                     <span class="font-medium text-ink">${d.count}</span> sessions ·
                     <span class="font-medium text-ink">${bytes(d.size)}</span> untouched since ${esc(dateTime(d.cutoff))}
                   </div>`
                : ''
            }
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            ${
              m.loading
                ? `<div class="p-8 text-center text-xs text-muted">Scanning transcripts…</div>`
                : !d
                  ? `<div class="p-8 text-center text-xs text-faint">Pick an age and hit Preview — nothing is deleted until you confirm the list below.</div>`
                  : !d.items.length
                    ? `<div class="p-8 text-center text-xs text-faint">No session is older than ${m.days} days.</div>`
                    : `<div class="mb-1 flex items-center gap-2 px-2 text-[11px] text-muted">
                         <button data-action="cleanup-all" class="hover:text-ink">select all</button>
                         <span>·</span>
                         <button data-action="cleanup-none" class="hover:text-ink">select none</button>
                         <span class="ml-auto">oldest first</span>
                       </div>
                       ${d.items
                         .map((i) => {
                           const key = `${i.projectId}/${i.id}`
                           const on = m.selected.has(key)
                           return `
                         <label class="mb-0.5 flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 ${
                           on ? 'border-rust/40 bg-rust/5' : 'border-transparent hover:bg-cream/60'
                         }">
                           <input type="checkbox" data-action="cleanup-toggle" data-key="${esc(key)}" ${on ? 'checked' : ''}
                             class="mt-0.5 accent-clay" />
                           <div class="min-w-0 flex-1">
                             <div class="truncate text-[12.5px] text-ink">${esc(i.title)}</div>
                             <div class="truncate text-[10.5px] text-faint">${esc(i.projectPath || i.projectId)}</div>
                           </div>
                           <div class="shrink-0 text-right text-[10.5px] text-muted">
                             <div>${esc(ago(i.mtime))}</div>
                             <div>${bytes(i.totalSize)}${i.extraSize ? ' · +subagents' : ''}</div>
                           </div>
                         </label>`
                         })
                         .join('')}`
            }
          </div>

          <div class="flex items-center gap-2 border-t border-line px-4 py-3">
            <div class="text-[11.5px] text-muted">
              ${selectedItems.length} selected · ${bytes(selSize)} — moved to the trash, restorable.
            </div>
            <button data-action="cleanup-run" ${selectedItems.length && !m.working ? '' : 'disabled'}
              class="ml-auto rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 ${
                m.confirm ? 'bg-rust hover:bg-rust/85' : 'bg-ink/80 hover:bg-ink'
              }">
              ${m.working ? 'Moving…' : m.confirm ? `Confirm — move ${selectedItems.length} to trash` : `Move ${selectedItems.length} to trash`}
            </button>
          </div>
        </div>
      </div>`
    return
  }

  if (m.kind === 'trash') {
    el.innerHTML = `
      <div data-action="close-modal" class="fixed inset-0 z-40 grid place-items-center bg-ink/25 p-4">
        <div data-stop class="flex max-h-[75vh] w-full max-w-2xl flex-col rounded-xl border border-line bg-card shadow-2xl">
          <div class="flex items-center gap-2 border-b border-line px-4 py-3">
            <h3 class="text-sm font-semibold text-ink">Trash</h3>
            <span class="hidden text-[11px] text-faint sm:block">~/.claude/.session-browser-trash</span>
            <button data-action="purge-all" class="ml-auto rounded-lg border border-line px-2.5 py-1 text-[11px] text-rust hover:text-rust">empty trash permanently</button>
            <button data-action="close-modal" class="rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted hover:text-ink">close</button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            ${
              m.items?.length
                ? m.items
                    .map(
                      (t) => `
              <div class="mb-1 flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <div class="min-w-0 flex-1">
                  <div class="truncate text-xs text-ink">${esc(t.kind === 'project' ? `PROJECT · ${t.projectId}` : t.sessionId)}</div>
                  <div class="truncate text-[10.5px] text-faint">${esc(t.projectId)} · ${t.files} files · ${bytes(t.size)} · ${esc(ago(t.deletedAt))}</div>
                </div>
                <button data-action="restore" data-entry="${esc(t.entry)}" class="rounded-lg border border-line px-2.5 py-1 text-[11px] text-moss hover:text-moss">restore</button>
                <button data-action="purge" data-entry="${esc(t.entry)}" class="rounded-lg border border-line px-2.5 py-1 text-[11px] text-rust hover:text-rust">delete forever</button>
              </div>`
                    )
                    .join('')
                : `<div class="p-6 text-center text-xs text-faint">Trash is empty</div>`
            }
          </div>
        </div>
      </div>`
  }
}

/* ---------------------------------------------------------------- actions */

function treeSignature() {
  return [
    state.projects.map((p) => `${p.id}:${p.mtime}:${p.sessions}`).join(','),
    [...state.live.sessions].sort().join(','),
    [...state.expanded].sort().join(','),
    Math.floor(Date.now() / 60_000), // let the "x minutes ago" labels tick over
  ].join('|')
}

async function pollActivity() {
  let a
  try {
    a = await api.activity(LIVE_WINDOW)
  } catch {
    return
  }
  const before = treeSignature()
  state.live = {
    sessions: new Set(a.active.map((x) => `${x.projectId}/${x.id}`)),
    projects: new Set(a.active.map((x) => x.projectId)),
  }

  // refresh mtimes and re-sort so the most recently touched project stays on top
  const fresh = new Map(a.projects.map((p) => [p.id, p]))
  let changed = state.projects.length !== a.projects.length
  for (const p of state.projects) {
    const f = fresh.get(p.id)
    if (!f) { changed = true; continue }
    if (f.mtime !== p.mtime || f.sessions !== p.sessions) changed = true
    p.mtime = f.mtime
    p.sessions = f.sessions
  }
  if (changed && state.projects.length === a.projects.length) {
    state.projects = state.projects.filter((p) => fresh.has(p.id))
    state.projects.sort((x, y) => y.mtime - x.mtime)
  }
  // a project appeared or disappeared — pull the full list again
  if (state.projects.length !== a.projects.length) return loadProjects()

  for (const x of a.active) {
    const row = state.sessionsByProject[x.projectId]?.find((s) => s.id === x.id)
    if (row) { row.mtime = x.mtime; row.size = x.size }
  }
  if (!state.modal && treeSignature() !== before) renderTree()
}

async function loadProjects() {
  state.projects = await api.projects()
  state.stats = await api.stats()
  renderTree()
  renderStats()
}

async function loadSessions(pid, { force = false } = {}) {
  if (state.sessionsByProject[pid] && !force) return state.sessionsByProject[pid]
  state.loadingProjects.add(pid)
  renderTree()
  try {
    state.sessionsByProject[pid] = await api.sessions(pid)
  } catch (e) {
    toast(e.message, 'err')
    state.sessionsByProject[pid] = []
  }
  state.loadingProjects.delete(pid)
  renderTree()
  return state.sessionsByProject[pid]
}

async function toggleProject(pid) {
  if (state.expanded.has(pid)) {
    state.expanded.delete(pid)
    return renderTree()
  }
  state.expanded.add(pid)
  state.project = state.projects.find((p) => p.id === pid) || null
  renderTree()
  await loadSessions(pid)
}

async function openProjectView(pid) {
  state.project = state.projects.find((p) => p.id === pid) || state.project
  state.view = 'project'
  state.expanded.add(pid)
  renderTree()
  renderChat()
  renderDetails()
  await loadSessions(pid)
  if (state.view === 'project') renderChat()
}

async function openSession(pid, sid, sub = '') {
  state.view = 'session'
  state.project = state.projects.find((p) => p.id === pid) || state.project
  state.session = sid
  state.sub = sub
  state.head = 0
  state.messages = []
  state.total = 0
  state.meta = (!sub && state.sessionsByProject[pid]?.find((s) => s.id === sid)) || null
  if (!sub) state.subagents = []
  state.chatLoading = true
  renderTree()
  renderChat()
  renderDetails()
  try {
    // sessions always open on their newest message
    const r = await api.session(pid, sid, { offset: -1, limit: state.limit, sub })
    state.meta = r.meta
    state.messages = r.messages
    state.total = r.total
    state.head = r.offset
  } catch (e) {
    toast(e.message, 'err')
  }
  state.chatLoading = false
  renderChat()
  renderDetails()
  scrollChatToEnd()

  if (!sub) {
    try {
      state.subagents = await api.subagents(pid, sid)
      renderDetails()
    } catch {}
  }
}

function scrollChatToEnd() {
  const el = document.getElementById('chat-scroll')
  if (el) el.scrollTop = el.scrollHeight
}

async function loadEarlier() {
  if (state.chatLoading || state.head <= 0) return
  const limit = Math.min(state.limit, state.head)
  const offset = state.head - limit
  const el = document.getElementById('chat-scroll')
  const before = el ? el.scrollHeight - el.scrollTop : 0
  state.chatLoading = true
  renderChat()
  try {
    const r = await api.session(state.meta.projectId, state.session, { offset, limit, sub: state.sub })
    state.messages = r.messages.concat(state.messages)
    state.head = r.offset
    state.total = r.total
  } catch (e) {
    toast(e.message, 'err')
  }
  state.chatLoading = false
  renderChat()
  // keep the message the user was reading in place
  const after = document.getElementById('chat-scroll')
  if (after) after.scrollTop = after.scrollHeight - before
}

async function runSearch(q) {
  state.search = { q, active: true, loading: true, results: [] }
  renderTree()
  try {
    state.search.results = await api.search(q)
  } catch (e) {
    toast(e.message, 'err')
  }
  state.search.loading = false
  renderTree()
}

async function openTerminal() {
  const m = state.meta
  if (!m) return
  try {
    const r = await api.openTerminal(m.projectId, state.session)
    toast(`Terminal opened in ${r.cwd}`)
  } catch (e) {
    // no terminal we could drive — hand over the command instead
    const cmd = `cd ${m.cwd || '.'} && claude --resume ${state.session}`
    await navigator.clipboard.writeText(cmd).catch(() => {})
    toast(`Could not open a terminal — command copied: ${cmd}`, 'err')
  }
}

function confirmModal(title, body, onYes) {
  state.modal = { kind: 'confirm', title, body, onYes }
  renderModal()
}

async function cleanupPreview() {
  const m = state.modal
  m.loading = true
  m.data = null
  m.confirm = false
  renderModal()
  try {
    m.data = await api.cleanupPreview(m.days, m.scope === 'project' ? state.project?.id || '' : '')
    m.selected = new Set(m.data.items.map((i) => `${i.projectId}/${i.id}`))
  } catch (e) {
    toast(e.message, 'err')
  }
  m.loading = false
  renderModal()
}

async function cleanupRun() {
  const m = state.modal
  if (!m.confirm) {
    m.confirm = true
    return renderModal()
  }
  const sessions = m.data.items
    .filter((i) => m.selected.has(`${i.projectId}/${i.id}`))
    .map((i) => ({ projectId: i.projectId, id: i.id }))
  m.working = true
  renderModal()
  try {
    const r = await api.cleanup(sessions)
    toast(`${r.moved} sessions moved to trash · ${bytes(r.freed)} freed${r.failed.length ? ` · ${r.failed.length} failed` : ''}`)
    if (state.meta && sessions.some((x) => x.projectId === state.meta.projectId && x.id === state.session)) {
      state.session = null
      state.meta = null
      state.messages = []
      renderChat()
      renderDetails()
    }
    state.modal = null
    renderModal()
    await loadProjects()
    for (const pid of state.expanded) await loadSessions(pid, { force: true })
  } catch (e) {
    m.working = false
    toast(e.message, 'err')
    renderModal()
  }
}

async function openTrash() {
  state.modal = { kind: 'trash', items: [] }
  renderModal()
  state.modal.items = await api.trash()
  renderModal()
}

/* ----------------------------------------------------------------- events */

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const a = btn.dataset.action

  switch (a) {
    case 'toggle-project': {
      // single click expands, double click lists the sessions in the main pane
      const id = btn.dataset.id
      const now = Date.now()
      if (lastProjectClick.id === id && now - lastProjectClick.at < 350) {
        lastProjectClick = { id: null, at: 0 }
        return openProjectView(id)
      }
      lastProjectClick = { id, at: now }
      return toggleProject(id)
    }

    case 'open-session': {
      e.stopPropagation()
      const pid = btn.dataset.pid
      if (!state.sessionsByProject[pid]) {
        state.expanded.add(pid)
        loadSessions(pid)
      }
      return openSession(pid, btn.dataset.sid)
    }

    case 'open-sub':
      return openSession(state.meta.projectId, state.session, btn.dataset.sub)

    case 'back-to-parent':
      return openSession(state.meta.projectId, state.session, '')

    case 'del-session': {
      e.stopPropagation()
      const { pid, sid } = btn.dataset
      const s = state.sessionsByProject[pid]?.find((x) => x.id === sid) || state.meta
      return confirmModal(
        'Delete session?',
        `“${s?.title || sid}” will be moved to the trash — you can restore it at any time.`,
        async () => {
          await api.deleteSession(pid, sid)
          if (state.sessionsByProject[pid])
            state.sessionsByProject[pid] = state.sessionsByProject[pid].filter((x) => x.id !== sid)
          state.search.results = state.search.results.filter((x) => x.id !== sid)
          if (state.session === sid) {
            state.session = null
            state.meta = null
            state.messages = []
          }
          toast('Session moved to trash')
          await loadProjects()
          renderChat()
          renderDetails()
        }
      )
    }

    case 'confirm-yes': {
      const fn = state.modal?.onYes
      state.modal = null
      renderModal()
      try {
        await fn?.()
      } catch (err) {
        toast(err.message, 'err')
      }
      return
    }

    case 'close-modal':
      // overlay click closes; inside the panel only its own buttons close
      if (btn.tagName !== 'BUTTON' && e.target !== btn) return
      state.modal = null
      return renderModal()

    case 'cleanup-project':
      state.modal = { kind: 'cleanup', days: 30, scope: 'project', loading: false, data: null, selected: new Set(), confirm: false, working: false }
      return renderModal()

    case 'reload-project':
      await loadSessions(state.project.id, { force: true })
      return renderChat()

    case 'cleanup':
      state.modal = { kind: 'cleanup', days: 30, scope: 'all', loading: false, data: null, selected: new Set(), confirm: false, working: false }
      return renderModal()

    case 'cleanup-preview':
      return cleanupPreview()

    case 'cleanup-all':
      state.modal.selected = new Set(state.modal.data.items.map((i) => `${i.projectId}/${i.id}`))
      state.modal.confirm = false
      return renderModal()

    case 'cleanup-none':
      state.modal.selected = new Set()
      state.modal.confirm = false
      return renderModal()

    case 'cleanup-run':
      return cleanupRun()

    case 'trash':
      return openTrash()

    case 'restore':
      await api.restore(btn.dataset.entry)
      toast('Restored')
      await loadProjects()
      for (const pid of state.expanded) await loadSessions(pid, { force: true })
      return openTrash()

    case 'purge':
      await api.purge(btn.dataset.entry)
      return openTrash()

    case 'purge-all':
      return confirmModal('Empty the trash?', 'This cannot be undone — the files are removed from disk.', async () => {
        await api.purge()
        toast('Trash emptied')
        await openTrash()
      })

    case 'refresh':
      await loadProjects()
      for (const pid of state.expanded) await loadSessions(pid, { force: true })
      return toast('Refreshed')

    case 'toggle-theme':
      return toggleTheme()

    case 'toggle-details':
      state.showDetails = !state.showDetails
      return renderDetails()

    case 'clear-search':
      state.search = { q: '', active: false, loading: false, results: [] }
      $('#deep-search').value = ''
      return renderTree()

    case 'load-earlier':
      return loadEarlier()

    case 'open-terminal':
      return openTerminal()

    case 'jump-end':
      return openSession(state.meta.projectId, state.session, state.sub)

    case 'copy-resume': {
      const cmd = `cd ${btn.dataset.cwd || '.'} && claude --resume ${btn.dataset.sid}`
      await navigator.clipboard.writeText(cmd).catch(() => {})
      return toast('Copied: ' + cmd)
    }

    case 'expand': {
      const pre = btn.previousElementSibling
      const r = await api.block(state.meta.projectId, state.session, btn.dataset.uuid, Number(btn.dataset.i), state.sub)
      if (pre) pre.textContent = r.text
      btn.remove()
      return
    }
  }
})

document.addEventListener('change', (e) => {
  const tog = e.target.closest('[data-action="cleanup-toggle"]')
  if (tog) {
    const sel = state.modal.selected
    e.target.checked ? sel.add(tog.dataset.key) : sel.delete(tog.dataset.key)
    state.modal.confirm = false
    return renderModal()
  }
  if (e.target.id === 'cleanup-scope') {
    state.modal.scope = e.target.value
    return
  }
  if (!e.target.closest('[data-action="toggle-tools"]')) return
  state.hideTools = e.target.checked
  renderChat()
})

document.addEventListener('input', (e) => {
  if (e.target.id === 'cleanup-days') {
    state.modal.days = Math.max(1, Number(e.target.value) || 1)
    return
  }
  if (e.target.id !== 'project-filter') return
  state.projectFilter = e.target.value
  renderTree()
  const inp = $('#project-filter')
  inp.focus()
  inp.setSelectionRange(inp.value.length, inp.value.length)
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.modal) {
    state.modal = null
    renderModal()
  }
  if (e.key === 'Enter' && e.target.id === 'deep-search') {
    const q = e.target.value.trim()
    if (q.length >= 2) runSearch(q)
  }
  if (e.key === '/' && !/input|textarea/i.test(e.target.tagName)) {
    e.preventDefault()
    $('#deep-search').focus()
  }
})

/* -------------------------------------------------------------------- boot */

renderThemeButton()
setInterval(pollActivity, POLL_EVERY)
pollActivity()
renderTree()
renderChat()
renderDetails()
loadProjects().catch((e) => toast(e.message, 'err'))
