// Production server: serves the built app (dist/) and the /ws room relay.
import http from 'node:http'
import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachRoomServer, handleApiRequest } from './rooms.js'

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }

const server = http.createServer((req, res) => {
  if (handleApiRequest(req, res)) return
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = path.join(dist, path.normalize(urlPath))
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(dist, 'index.html') // SPA fallback: /any-room
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

attachRoomServer(server)
const port = process.env.PORT || 3000
server.listen(port, () => console.log(`GetCodeSnap on http://localhost:${port}`))
