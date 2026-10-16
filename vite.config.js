import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { attachRoomServer } from './server/rooms.js'

// Runs the room relay inside `vite` / `vite preview` so one command is enough.
const rooms = () => ({
  name: 'getcodesnap-rooms',
  configureServer: (s) => attachRoomServer(s.httpServer),
  configurePreviewServer: (s) => attachRoomServer(s.httpServer),
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), rooms()],
})
