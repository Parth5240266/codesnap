import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './App.css'

// ---- room / sync -----------------------------------------------------------
const randomRoom = () => Math.random().toString(36).slice(2, 10)

function getRoom() {
  let room = decodeURIComponent(window.location.pathname.slice(1)).replace(/\/+$/, '')
  if (!room) {
    room = randomRoom()
    window.history.replaceState(null, '', `/${encodeURIComponent(room)}`)
  }
  return room
}

const storageKey = (room) => `devdoc:${room}`

function loadText(room) {
  try {
    return localStorage.getItem(storageKey(room)) ?? ''
  } catch {
    return ''
  }
}

// ---- text helpers ----------------------------------------------------------
function findMatches(text, query, caseSensitive) {
  if (!query) return []
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const out = []
  let i = hay.indexOf(needle)
  while (i !== -1) {
    out.push(i)
    i = hay.indexOf(needle, i + needle.length)
  }
  return out
}

function lineBounds(text, start, end) {
  const blockStart = text.lastIndexOf('\n', start - 1) + 1
  const effEnd = end > start && text[end - 1] === '\n' ? end - 1 : end
  let blockEnd = text.indexOf('\n', effEnd)
  if (blockEnd === -1) blockEnd = text.length
  return [blockStart, blockEnd]
}

export default function App() {
  const [room] = useState(getRoom)
  const [text, setText] = useState(() => loadText(room))
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [current, setCurrent] = useState(0)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [copied, setCopied] = useState(false)

  const taRef = useRef(null)
  const backdropRef = useRef(null)
  const gutterRef = useRef(null)
  const findRef = useRef(null)
  const socketRef = useRef(null)
  const pendingSel = useRef(null)
  const [status, setStatus] = useState('offline')
  const [users, setUsers] = useState(0)

  const matches = useMemo(
    () => findMatches(text, query, caseSensitive),
    [text, query, caseSensitive],
  )
  const activeIdx = matches.length ? Math.min(current, matches.length - 1) : -1

  // Persist + broadcast to other tabs on the same room
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(room), text)
    } catch {
      /* ignore */
    }
  }, [room, text])

  // Apply someone else's text while keeping the local caret/selection in place.
  const applyRemote = useCallback((next) => {
    const ta = taRef.current
    const prev = ta.value
    if (prev === next) return
    let p = 0
    const max = Math.min(prev.length, next.length)
    while (p < max && prev[p] === next[p]) p++
    let sfx = 0
    while (sfx < max - p && prev[prev.length - 1 - sfx] === next[next.length - 1 - sfx]) sfx++
    const map = (pos) => {
      if (pos <= p) return pos
      if (pos >= prev.length - sfx) return pos + next.length - prev.length
      return p
    }
    pendingSel.current = [map(ta.selectionStart), map(ta.selectionEnd)]
    setText(next)
  }, [])

  // Live sync over WebSocket (auto-reconnects)
  useEffect(() => {
    let ws
    let timer
    let closed = false
    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${window.location.host}/ws?room=${encodeURIComponent(room)}`)
      socketRef.current = ws
      ws.onopen = () => setStatus('online')
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'users') return setUsers(msg.count)
        if (msg.type === 'init') {
          // Server copy wins, unless the room is new and we have local text to seed it with.
          if (msg.text === '' && taRef.current.value) {
            ws.send(JSON.stringify({ type: 'text', text: taRef.current.value }))
            return
          }
        }
        if (msg.type === 'init' || msg.type === 'text') applyRemote(msg.text)
      }
      ws.onclose = () => {
        setStatus('offline')
        setUsers(0)
        if (!closed) timer = setTimeout(connect, 1500)
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      ws.close()
    }
  }, [room, applyRemote])

  useLayoutEffect(() => {
    if (!pendingSel.current) return
    const [a, b] = pendingSel.current
    pendingSel.current = null
    const ta = taRef.current
    if (document.activeElement === ta) ta.setSelectionRange(a, b)
  }, [text])

  const onChange = (value) => {
    setText(value)
    const ws = socketRef.current
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'text', text: value }))
  }

  const updateCursor = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const before = ta.value.slice(0, ta.selectionStart)
    const line = before.split('\n').length
    setCursor({ line, col: before.length - before.lastIndexOf('\n') })
  }, [])

  // Edit a range through the browser so native undo/redo keeps working.
  const replaceRange = (start, end, str, selStart, selEnd) => {
    const ta = taRef.current
    ta.focus()
    ta.setSelectionRange(start, end)
    const ok = document.execCommand('insertText', false, str)
    if (!ok) {
      ta.setRangeText(str, start, end, 'end')
      onChange(ta.value)
    }
    ta.setSelectionRange(selStart ?? start + str.length, selEnd ?? start + str.length)
    updateCursor()
  }

  // ---- line commands -------------------------------------------------------
  const selectLine = () => {
    const ta = taRef.current
    ta.focus()
    const t = ta.value
    let [s, e] = lineBounds(t, ta.selectionStart, ta.selectionEnd)
    const alreadySelected = ta.selectionStart === s && ta.selectionEnd >= e && e > s
    if (alreadySelected || ta.selectionEnd === e + 1) {
      // extend to following line
      const next = t.indexOf('\n', ta.selectionEnd)
      e = next === -1 ? t.length : next
    }
    ta.setSelectionRange(s, Math.min(e + 1, t.length))
    updateCursor()
  }

  const moveLine = (dir) => {
    const ta = taRef.current
    const t = ta.value
    const selS = ta.selectionStart
    const selE = ta.selectionEnd
    const [bs, be] = lineBounds(t, selS, selE)
    const block = t.slice(bs, be)
    if (dir < 0) {
      if (bs === 0) return
      const ps = t.lastIndexOf('\n', bs - 2) + 1
      const prev = t.slice(ps, bs - 1)
      const shift = prev.length + 1
      replaceRange(ps, be, `${block}\n${prev}`, selS - shift, selE - shift)
    } else {
      if (be >= t.length) return
      let ne = t.indexOf('\n', be + 1)
      if (ne === -1) ne = t.length
      const next = t.slice(be + 1, ne)
      const shift = next.length + 1
      replaceRange(bs, ne, `${next}\n${block}`, selS + shift, selE + shift)
    }
  }

  // ---- find / replace ------------------------------------------------------
  const scrollToIndex = (index) => {
    const ta = taRef.current
    const line = text.slice(0, index).split('\n').length - 1
    const lh = parseFloat(getComputedStyle(ta).lineHeight)
    const top = line * lh
    if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - lh * 2) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 2)
    }
  }

  const goTo = (i) => {
    if (!matches.length) return
    const n = (i + matches.length) % matches.length
    setCurrent(n)
    scrollToIndex(matches[n])
  }

  const replaceOne = () => {
    if (activeIdx < 0) return
    const s = matches[activeIdx]
    replaceRange(s, s + query.length, replacement)
    findRef.current?.focus()
  }

  const replaceAll = () => {
    if (!matches.length) return
    let out = ''
    let last = 0
    for (const s of matches) {
      out += text.slice(last, s) + replacement
      last = s + query.length
    }
    out += text.slice(last)
    replaceRange(0, text.length, out)
    findRef.current?.focus()
  }

  const openFind = () => {
    const ta = taRef.current
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd)
    if (sel && !sel.includes('\n')) setQuery(sel)
    setFindOpen(true)
    setTimeout(() => {
      findRef.current?.focus()
      findRef.current?.select()
    }, 0)
  }

  // ---- keyboard ------------------------------------------------------------
  const onKeyDown = (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      openFind()
    } else if (mod && e.key.toLowerCase() === 'h') {
      e.preventDefault()
      openFind()
    } else if (mod && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      selectLine()
    } else if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault()
      moveLine(-1)
    } else if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault()
      moveLine(1)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const ta = taRef.current
      replaceRange(ta.selectionStart, ta.selectionEnd, '  ')
    }
  }

  const onFindKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      goTo(activeIdx + (e.shiftKey ? -1 : 1))
    } else if (e.key === 'Escape') {
      setFindOpen(false)
      taRef.current?.focus()
    }
  }

  const syncScroll = () => {
    const ta = taRef.current
    backdropRef.current.scrollTop = ta.scrollTop
    backdropRef.current.scrollLeft = ta.scrollLeft
    gutterRef.current.scrollTop = ta.scrollTop
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const newRoom = () => {
    window.location.assign(`/${randomRoom()}`)
  }

  // Backdrop with highlighted matches (same metrics as the textarea)
  const backdrop = useMemo(() => {
    if (!findOpen || !matches.length) return text
    const parts = []
    let last = 0
    matches.forEach((s, i) => {
      parts.push(text.slice(last, s))
      parts.push(
        <mark key={s} className={i === activeIdx ? 'current' : ''}>
          {text.slice(s, s + query.length)}
        </mark>,
      )
      last = s + query.length
    })
    parts.push(text.slice(last))
    return parts
  }, [text, matches, activeIdx, findOpen, query])

  const lineCount = text.split('\n').length

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">CodeSnap</strong>
        <span className="tagline">Capture. Share. Code.</span>
        <span className="room">/{room}</span>
        <span className={`live ${status}`}>
          ● {status === 'online' ? `${users} online` : 'offline'}
        </span>
        <button onClick={copyLink}>{copied ? 'Copied!' : 'Copy link'}</button>
        <button onClick={newRoom}>New</button>
        <span className="sep" />
        <button onClick={openFind} title="Ctrl+F">Find / Replace</button>
        <button onClick={selectLine} title="Ctrl+L">Select line</button>
        <button onClick={() => moveLine(-1)} title="Alt+↑">Line ↑</button>
        <button onClick={() => moveLine(1)} title="Alt+↓">Line ↓</button>
      </header>

      {findOpen && (
        <div className="findbar">
          <div className="row">
            <input
              ref={findRef}
              value={query}
              placeholder="Find"
              onChange={(e) => {
                setQuery(e.target.value)
                setCurrent(0)
              }}
              onKeyDown={onFindKeyDown}
            />
            <span className="count">
              {matches.length ? `${activeIdx + 1} of ${matches.length}` : 'No results'}
            </span>
            <button onClick={() => goTo(activeIdx - 1)} title="Previous (Shift+Enter)">↑</button>
            <button onClick={() => goTo(activeIdx + 1)} title="Next (Enter)">↓</button>
            <label>
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
              />
              Aa
            </label>
            <button onClick={() => setFindOpen(false)} title="Close (Esc)">✕</button>
          </div>
          <div className="row">
            <input
              value={replacement}
              placeholder="Replace"
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={onFindKeyDown}
            />
            <button onClick={replaceOne} disabled={!matches.length}>Replace</button>
            <button onClick={replaceAll} disabled={!matches.length}>Replace all</button>
          </div>
        </div>
      )}

      <div className="editor">
        <div className="gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className={i + 1 === cursor.line ? 'active' : ''}>{i + 1}</div>
          ))}
        </div>
        <div className="pane">
          <pre className="backdrop" ref={backdropRef} aria-hidden="true">
            {backdrop}
            {'\n'}
          </pre>
          <textarea
            ref={taRef}
            value={text}
            spellCheck={false}
            autoFocus
            wrap="off"
            placeholder="Start typing or paste code here…"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={updateCursor}
            onClick={updateCursor}
            onSelect={updateCursor}
            onScroll={syncScroll}
          />
        </div>
      </div>

      <footer className="status">
        Ln {cursor.line}, Col {cursor.col} · {lineCount} lines · Ctrl+F find · Ctrl+L select line · Alt+↑/↓ move line
      </footer>
    </div>
  )
}
