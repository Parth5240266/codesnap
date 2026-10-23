import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { WebSocketServer } from 'ws'

// Set DATA_DIR to a persistent disk path in production to keep rooms across restarts.
const DATA_DIR = process.env.DATA_DIR || new URL('..', import.meta.url).pathname
const DATA_FILE = path.join(DATA_DIR, 'rooms.json')
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
const MAX_SIZE = 5 * 1024 * 1024
const MAX_FILE = 50 * 1024 * 1024
const TTLS = [600, 3600, 86400, 604800, 2592000] // 10 min, 1 h, 1 day, 7 days, 30 days
// Types the browser may show inline; everything else is served as a download.
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|video\/(mp4|webm)|audio\/\w+|text\/plain)$/
const MAX_ATTEMPTS = 10 // wrong passkeys per IP and room...
const ATTEMPT_WINDOW = 15 * 60 * 1000 // ...per 15 minutes

fs.mkdirSync(UPLOAD_DIR, { recursive: true })

// Signs access tokens. Kept on disk so unlocked browsers stay unlocked across restarts.
const SECRET = (() => {
  const file = path.join(DATA_DIR, 'secret.key')
  try {
    return fs.readFileSync(file)
  } catch {
    const s = crypto.randomBytes(32)
    fs.writeFileSync(file, s, { mode: 0o600 })
    return s
  }
})()

// name -> { name, text, files:[{ id, name, type, size, expiresAt }], lock:{ salt, hash }|null, clients:Set }
const rooms = new Map()

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  for (const [name, r] of Object.entries(saved)) {
    // Older saves stored just the text.
    const { text = '', files = [], lock = null } = typeof r === 'string' ? { text: r } : r
    rooms.set(name, { name, text, files, lock, clients: new Set() })
  }
} catch {
  /* no saved rooms yet */
}

let saveTimer
function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const out = {}
    for (const [name, r] of rooms) {
      if (r.text || r.files.length || r.lock) out[name] = { text: r.text, files: r.files, lock: r.lock }
    }
    fs.writeFile(DATA_FILE, JSON.stringify(out), () => {})
  }, 500)
}

function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, { name, text: '', files: [], lock: null, clients: new Set() })
  return rooms.get(name)
}

// ---- passkey lock ------------------------------------------------------------
const hashPasskey = (passkey, salt) => crypto.scryptSync(passkey, salt, 32).toString('hex')

// A token stays valid until the room's passkey changes.
const tokenFor = (room) => crypto.createHmac('sha256', SECRET).update(`${room.name}\n${room.lock.hash}`).digest('hex')

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

// The token lives in an HttpOnly cookie (one per room) so page scripts can never read it.
const cookieName = (name) => `gcs_${crypto.createHash('sha256').update(name).digest('hex').slice(0, 16)}`

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ''
}

function setTokenCookie(req, res, room, token, remember) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https'
  const attrs = [
    `${cookieName(room.name)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure && 'Secure',
    !token ? 'Max-Age=0' : remember && 'Max-Age=2592000', // 30 days, or until the browser closes
  ]
  res.setHeader('Set-Cookie', attrs.filter(Boolean).join('; '))
}

const canAccess = (room, req) => {
  if (!room.lock) return true
  const token = readCookie(req, cookieName(room.name))
  return !!token && safeEqual(tokenFor(room), token)
}

const attempts = new Map() // `${ip}\n${room}` -> { count, resetAt }

// Returns null when the passkey is right, otherwise an error message.
function checkPasskey(room, passkey, ip) {
  const key = `${ip}\n${room.name}`
  const now = Date.now()
  let a = attempts.get(key)
  if (!a || a.resetAt <= now) a = { count: 0, resetAt: now + ATTEMPT_WINDOW }
  if (a.count >= MAX_ATTEMPTS) {
    return `Too many wrong attempts. Try again in ${Math.ceil((a.resetAt - now) / 60000)} min.`
  }
  if (typeof passkey === 'string' && safeEqual(hashPasskey(passkey, room.lock.salt), room.lock.hash)) {
    attempts.delete(key)
    return null
  }
  a.count++
  attempts.set(key, a)
  return 'Wrong passkey'
}

setInterval(() => {
  const now = Date.now()
  for (const [k, a] of attempts) if (a.resetAt <= now) attempts.delete(k)
}, ATTEMPT_WINDOW).unref()

// ---- rooms -------------------------------------------------------------------
function broadcast(room, msg) {
  const out = JSON.stringify(msg)
  for (const c of room.clients) if (c.readyState === 1) c.send(out)
}

function broadcastUsers(room) {
  broadcast(room, { type: 'users', count: room.clients.size })
}

function removeFile(room, id) {
  room.files = room.files.filter((f) => f.id !== id)
  fs.rm(path.join(UPLOAD_DIR, id), { force: true }, () => {})
  scheduleSave()
  broadcast(room, { type: 'files', files: room.files })
}

function findFile(id) {
  for (const room of rooms.values()) {
    const file = room.files.find((f) => f.id === id)
    if (file) return { room, file }
  }
  return {}
}

// Drop expired files every 30 seconds.
function sweep() {
  const now = Date.now()
  for (const room of rooms.values()) {
    for (const f of room.files) if (f.expiresAt <= now) removeFile(room, f.id)
  }
}
sweep()
setInterval(sweep, 30_000).unref()

// ---- file API ----------------------------------------------------------------
function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

function upload(req, res, url) {
  const roomName = url.searchParams.get('room')
  const ttl = Number(url.searchParams.get('ttl'))
  const name = (url.searchParams.get('name') || 'file').slice(0, 200)
  if (!roomName) return sendText(res, 400, 'Missing room')
  if (!canAccess(getRoom(roomName), req)) return sendText(res, 403, 'This page is locked')
  if (!TTLS.includes(ttl)) return sendText(res, 400, 'Invalid expiry')
  if (Number(req.headers['content-length']) > MAX_FILE) return sendText(res, 413, 'File is larger than 50 MB')

  const id = crypto.randomBytes(12).toString('hex')
  const dest = path.join(UPLOAD_DIR, id)
  const out = fs.createWriteStream(dest)
  let size = 0
  let failed = false
  const fail = (status, msg) => {
    if (failed) return
    failed = true
    out.destroy()
    fs.rm(dest, { force: true }, () => {})
    sendText(res, status, msg)
  }

  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_FILE) {
      fail(413, 'File is larger than 50 MB')
      req.destroy()
    }
  })
  req.on('error', () => fail(400, 'Upload interrupted'))
  out.on('error', () => fail(500, 'Could not save file'))
  out.on('finish', () => {
    if (failed) return
    const room = getRoom(roomName)
    const file = {
      id,
      name,
      type: (req.headers['content-type'] || 'application/octet-stream').split(';')[0],
      size,
      expiresAt: Date.now() + ttl * 1000,
    }
    room.files.push(file)
    scheduleSave()
    broadcast(room, { type: 'files', files: room.files })
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(file))
  })
  req.pipe(out)
}

function serve(res, file, download) {
  const inline = !download && INLINE.test(file.type)
  res.writeHead(200, {
    'Content-Type': file.type,
    'Content-Length': file.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=60',
  })
  fs.createReadStream(path.join(UPLOAD_DIR, file.id)).pipe(res)
}

// ---- auth API ----------------------------------------------------------------
// Each socket sends a random connection id (`cid`) when it connects. The auth calls below
// name it, so the server can sign that live socket in while setting the cookie.
const sockets = new Map() // cid -> ws

function readJson(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 10_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch {
        resolve({})
      }
    })
  })
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim()
}

//   POST /api/auth   { room, passkey, cid, remember }  enter the passkey of a locked room
//   POST /api/lock   { room, passkey, cid, remember }  set or change the passkey (cid must be signed in)
//   POST /api/logout { room }                           forget this browser's access
async function handleAuth(req, res, action) {
  // Requiring JSON blocks plain cross-site form posts.
  if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) {
    return sendText(res, 400, 'Bad request')
  }
  const { room: name, passkey, cid, remember } = await readJson(req)
  if (typeof name !== 'string' || !rooms.has(name)) return sendJson(res, 404, { error: 'No such page' })
  const room = rooms.get(name)
  const ws = sockets.get(cid)
  const sameRoom = ws?.roomName === name

  if (action === 'logout') {
    setTokenCookie(req, res, room, '', false)
    return sendJson(res, 200, {})
  }

  if (action === 'auth') {
    if (!room.lock) return sendJson(res, 200, {})
    const error = checkPasskey(room, passkey, clientIp(req))
    if (error) return sendJson(res, 403, { error })
    setTokenCookie(req, res, room, tokenFor(room), remember)
    if (sameRoom && !ws.authed) join(ws, room)
    return sendJson(res, 200, {})
  }

  // lock: only someone already inside the room may set or change its passkey.
  if (!sameRoom || !ws.authed) return sendJson(res, 403, { error: 'Not allowed' })
  if (typeof passkey !== 'string' || passkey.length < 4 || passkey.length > 200) {
    return sendJson(res, 400, { error: 'Passkey must be 4–200 characters' })
  }
  const salt = crypto.randomBytes(16).toString('hex')
  room.lock = { salt, hash: hashPasskey(passkey, salt) }
  scheduleSave()
  setTokenCookie(req, res, room, tokenFor(room), remember)
  // A new passkey signs everyone else out.
  for (const c of room.clients) {
    if (c === ws) continue
    c.authed = false
    room.clients.delete(c)
    c.send(JSON.stringify({ type: 'locked' }))
  }
  ws.send(JSON.stringify({ type: 'lock', locked: true }))
  broadcastUsers(room)
  sendJson(res, 200, {})
}

// Handles /api/* requests. Returns false for any other path.
// Files in a locked room need the room's access cookie.
//   POST   /api/files?room=&ttl=&name=   body = raw file bytes
//   GET    /api/files/<id>[?download=1]
//   DELETE /api/files/<id>
export function handleApiRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const action = url.pathname.match(/^\/api\/(auth|lock|logout)$/)?.[1]
  if (action) {
    handleAuth(req, res, action)
    return true
  }
  if (url.pathname !== '/api/files' && !url.pathname.startsWith('/api/files/')) return false

  if (url.pathname === '/api/files') {
    if (req.method === 'POST') upload(req, res, url)
    else sendText(res, 405, 'Method not allowed')
    return true
  }

  const { room, file } = findFile(url.pathname.slice('/api/files/'.length))
  if (!file || file.expiresAt <= Date.now()) sendText(res, 404, 'This file has expired or does not exist')
  else if (!canAccess(room, req)) sendText(res, 403, 'This page is locked')
  else if (req.method === 'GET') serve(res, file, url.searchParams.has('download'))
  else if (req.method === 'DELETE') {
    removeFile(room, file.id)
    res.writeHead(204).end()
  } else sendText(res, 405, 'Method not allowed')
  return true
}

// ---- WebSocket ---------------------------------------------------------------
// A socket for a locked room gets { type:'locked' } and nothing else until /api/auth signs it in.
//   client -> server: text, unlock (remove the passkey)
//   server -> client: init, text, users, files, locked, lock { locked }
function join(ws, room) {
  ws.authed = true
  room.clients.add(ws)
  ws.send(JSON.stringify({ type: 'init', text: room.text, files: room.files, locked: !!room.lock }))
  broadcastUsers(room)
}

// Attach a /ws endpoint to an existing http server (Vite dev, preview or our own).
export function attachRoomServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIZE })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== '/ws') return // leave Vite's HMR socket alone
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url.searchParams.get('room') || 'default', url.searchParams.get('cid'))
    })
  })

  wss.on('connection', (ws, req, name, cid) => {
    const room = getRoom(name)
    ws.roomName = name
    if (cid && cid.length >= 16 && !sockets.has(cid)) {
      ws.cid = cid
      sockets.set(cid, ws)
    }
    if (canAccess(room, req)) join(ws, room)
    else ws.send(JSON.stringify({ type: 'locked' }))

    ws.on('message', (data) => {
      if (!ws.authed) return
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.type === 'text' && typeof msg.text === 'string') {
        room.text = msg.text
        scheduleSave()
        const out = JSON.stringify({ type: 'text', text: msg.text })
        for (const c of room.clients) if (c !== ws && c.readyState === 1) c.send(out)
      } else if (msg.type === 'unlock' && room.lock) {
        room.lock = null
        scheduleSave()
        broadcast(room, { type: 'lock', locked: false })
      }
    })

    ws.on('close', () => {
      if (ws.cid) sockets.delete(ws.cid)
      if (room.clients.delete(ws)) broadcastUsers(room)
    })
  })
}
