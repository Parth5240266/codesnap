import { useEffect, useRef, useState } from 'react'

const EXPIRY = [
  ['10 minutes', 600],
  ['1 hour', 3600],
  ['1 day', 86400],
  ['7 days', 604800],
  ['30 days', 2592000],
]
const MAX_FILE = 50 * 1024 * 1024

function formatSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function timeLeft(expiresAt) {
  const s = Math.max(0, (expiresAt - Date.now()) / 1000)
  if (s < 60) return 'under a minute'
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 86400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} days`
}

function Thumb({ file, url }) {
  if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
    return <img className="thumb" src={url} alt="" loading="lazy" />
  }
  const ext = file.type === 'application/pdf' ? 'PDF' : file.name.split('.').pop().slice(0, 4).toUpperCase()
  return <span className="thumb badge">{ext}</span>
}

export default function FilesPanel({ room, files }) {
  const fileUrl = (f, query = '') => `/api/files/${f.id}${query}`

  const [ttl, setTtl] = useState(86400)
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState('')
  const [drag, setDrag] = useState(false)
  const [, setTick] = useState(0)
  const inputRef = useRef(null)

  // Refresh the "expires in" labels.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // The server broadcasts the new list to everyone in the room, so no local update is needed.
  const upload = async (list) => {
    setError('')
    for (const file of list) {
      if (file.size > MAX_FILE) {
        setError(`${file.name} is larger than 50 MB`)
        continue
      }
      setBusy((n) => n + 1)
      try {
        const q = new URLSearchParams({ room, ttl, name: file.name })
        const res = await fetch(`/api/files?${q}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        if (!res.ok) setError((await res.text()) || 'Upload failed')
      } catch {
        setError('Upload failed')
      } finally {
        setBusy((n) => n - 1)
      }
    }
  }

  const remove = (file) => {
    if (window.confirm(`Delete ${file.name} for everyone?`)) fetch(fileUrl(file), { method: 'DELETE' })
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDrag(false)
    upload([...e.dataTransfer.files])
  }

  return (
    <aside className="files">
      <div
        className={`dropzone${drag ? ' over' : ''}`}
        onClick={() => inputRef.current.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        {busy ? 'Uploading…' : 'Drop files here or click to upload'}
        <small>Images, PDFs or any file up to 50 MB</small>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            upload([...e.target.files])
            e.target.value = ''
          }}
        />
      </div>
      <label className="expiry">
        Keep for
        <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
          {EXPIRY.map(([label, s]) => (
            <option key={s} value={s}>{label}</option>
          ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}

      <ul>
        {files.map((f) => (
          <li key={f.id}>
            <a href={fileUrl(f)} target="_blank" rel="noreferrer">
              <Thumb file={f} url={fileUrl(f)} />
            </a>
            <div className="meta">
              <a href={fileUrl(f)} target="_blank" rel="noreferrer" title={f.name}>{f.name}</a>
              <small>{formatSize(f.size)} · expires in {timeLeft(f.expiresAt)}</small>
            </div>
            <a className="icon" href={fileUrl(f, '?download=1')} title="Download">⤓</a>
            <button className="icon" onClick={() => remove(f)} title="Delete">✕</button>
          </li>
        ))}
      </ul>
      {!files.length && <p className="empty">No files in this room yet.</p>}
    </aside>
  )
}
