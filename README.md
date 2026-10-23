# GetCodeSnap

**Capture. Share. Code.**

GetCodeSnap is a shared code pad that runs in the browser. Open a page, paste or type code, and send the link to someone. Everyone in the same room sees edits in real time. You don't need an account or a sign-up.

## Features

- **Shareable rooms**: every URL path is a room (for example `/my-team`). Opening `/` creates a random room.
- **Live sync**: edits reach everyone in the room over WebSockets. The toolbar shows how many people are online.
- **Rooms are saved**: the server stores room text in `rooms.json`, and your browser also keeps a copy in `localStorage`.
- **Editor tools**: line numbers, find & replace (with a case-sensitive option), select line, move line up/down, and Tab to indent.
- **File sharing**: click **Files** to upload images, PDFs or any file (up to 50 MB) to the room. You choose how long each file stays: 10 minutes, 1 hour, 1 day, 7 days or 30 days. After that, it is deleted. Uploads are stored in `uploads/` inside `DATA_DIR`.
- **Private pages**: click **Lock** to protect a page with a passkey. Anyone who opens it then has to enter the passkey before they see the text or files. The server keeps only a salted scrypt hash. Access is kept in an HttpOnly, SameSite=Strict cookie (Secure on HTTPS), so page scripts can never read it, and private pages are never cached in the browser. Tick "Remember this device" to stay signed in for 30 days; otherwise access ends when the browser closes. After 10 wrong attempts from the same IP, that IP is blocked for 15 minutes. Changing the passkey signs everyone else out. A forgotten passkey can't be recovered.
- **Download**: the **Download** button saves the current text as a `.txt` file named after the room.
- **Light & dark theme**: switch with the ☀ / ☾ button in the toolbar. It starts from your system setting and remembers your choice.
- **Auto-reconnect**: if the connection drops, the app keeps trying to reconnect.

## How to use

1. Open the app. You land in a new random room, such as `/k3j9x2ab`.
2. Type or paste your code into the editor.
3. Click **Copy link** and send the link to anyone you want to share with.
4. Everyone who opens that link edits the same text together.
5. Click **Download** to save the code as a `.txt` file.
6. Click **New** to start a fresh room.

To get a room with an easy name, type it into the URL yourself, for example `https://your-site.com/interview-42`.

> Anyone with the link can read and edit a room unless it is locked with a passkey. Even then, avoid pasting secrets such as passwords or API keys.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + F` or `Ctrl/Cmd + H` | Open Find / Replace |
| `Enter` / `Shift + Enter` (in the find box) | Next / previous match |
| `Esc` (in the find box) | Close Find / Replace |
| `Ctrl/Cmd + L` | Select the current line (press again to extend) |
| `Alt + ↑` / `Alt + ↓` | Move the line or selection up / down |
| `Tab` | Insert two spaces |
| `Ctrl/Cmd + Z` | Undo |

## Run it locally

You need [Node.js](https://nodejs.org/) 20.19 or newer (Vite needs it).

```bash
npm install
npm run dev
```

Then open the URL that Vite prints (usually http://localhost:5173). The room server runs inside the Vite dev server, so this one command is enough.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the dev server with hot reload and live rooms |
| `npm run build` | Builds the app into `dist/` |
| `npm run preview` | Serves the built app with Vite (rooms work here too) |
| `npm start` | Starts the production server (`server/index.js`) and serves `dist/` |
| `npm run lint` | Runs ESLint |

### Production build

```bash
npm run build
npm start
```

The app runs on http://localhost:3000. Set `PORT` to use a different port.

## Deploy to Render

The repo includes a `render.yaml` blueprint:

1. Push the repo to GitHub.
2. In Render, choose **New → Blueprint** and select the repo.
3. Render runs `npm install && npm run build`, then `npm start`.

On Render's free plan the file system is wiped on every restart or deploy, so saved rooms are lost. To keep them, attach a persistent disk and set `DATA_DIR` to its mount path (for example `/var/data`).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port for the production server |
| `DATA_DIR` | project root | Folder where `rooms.json` is saved |

## Project structure

```
├── index.html          # HTML entry
├── src/
│   ├── App.jsx         # Editor UI, shortcuts, WebSocket sync
│   ├── App.css         # Editor styles
│   └── main.jsx        # React entry
├── server/
│   ├── index.js        # Production server (static files + /ws)
│   └── rooms.js        # Room relay over WebSockets, saves rooms.json
├── vite.config.js      # Vite config; runs the room relay in dev/preview
└── render.yaml         # Render deployment blueprint
```

## How sync works

Each browser opens a WebSocket to `/ws?room=<name>`. When you join, the server sends the room's current text. Each edit sends the whole document to the server, and the server forwards it to everyone else in the room. The newest edit wins. This works well for pair coding and sharing snippets. Two people typing on the same line at the same moment can overwrite each other.

## Tech stack

React 19, Vite, and Node.js with [`ws`](https://github.com/websockets/ws).
