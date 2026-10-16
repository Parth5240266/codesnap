import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { WebSocketServer } from 'ws'

// Set DATA_DIR to a persistent disk path in production to keep rooms across restarts.
const DATA_FILE = path.join(process.env.DATA_DIR || new URL('..', import.meta.url).pathname, 'rooms.json')
const MAX_SIZE = 5 * 1024 * 1024

const rooms = new Map() // name -> { text, clients:Set }

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  for (const [name, text] of Object.entries(saved)) rooms.set(name, { text, clients: new Set() })
} catch {
  /* no saved rooms yet */
}

let saveTimer
function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const out = {}
    for (const [name, r] of rooms) if (r.text) out[name] = r.text
    fs.writeFile(DATA_FILE, JSON.stringify(out), () => {})
  }, 500)
}

function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, { text: '', clients: new Set() })
  return rooms.get(name)
}

function broadcastUsers(room) {
  const msg = JSON.stringify({ type: 'users', count: room.clients.size })
  for (const c of room.clients) c.send(msg)
}

// Attach a /ws endpoint to an existing http server (Vite dev, preview or our own).
export function attachRoomServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIZE })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== '/ws') return // leave Vite's HMR socket alone
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, url.searchParams.get('room') || 'default')
    })
  })

  wss.on('connection', (ws, name) => {
    const room = getRoom(name)
    room.clients.add(ws)
    ws.send(JSON.stringify({ type: 'init', text: room.text }))
    broadcastUsers(room)

    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.type !== 'text' || typeof msg.text !== 'string') return
      room.text = msg.text
      scheduleSave()
      const out = JSON.stringify({ type: 'text', text: msg.text })
      for (const c of room.clients) if (c !== ws && c.readyState === 1) c.send(out)
    })

    ws.on('close', () => {
      room.clients.delete(ws)
      broadcastUsers(room)
    })
  })
}
