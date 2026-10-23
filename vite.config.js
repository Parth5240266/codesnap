import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { attachRoomServer, handleApiRequest } from './server/rooms.js'

// Runs the room relay and file API inside `vite` / `vite preview` so one command is enough.
const attach = (s) => {
  attachRoomServer(s.httpServer)
  s.middlewares.use((req, res, next) => handleApiRequest(req, res) || next())
}
const rooms = () => ({
  name: 'getcodesnap-rooms',
  configureServer: attach,
  configurePreviewServer: attach,
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), rooms()],
})
