# Productivity Coach Starter

<div align="center">

![Productivity Coach](desktopIcon.png)

**Electron + React + TypeScript starter**

[![Windows](https://img.shields.io/badge/platform-Windows-blue?logo=windows)](#installation)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](#license)

</div>

---

## Installation

### Windows

1. Build the installer with `npm run dist:win`.
2. Run the generated installer on Windows.
3. The app opens as a local desktop shell with no legacy service dependencies.

---

## Development

### Prerequisites

- Node.js 18+
- npm 9+

### Setup

```bash
npm install
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Type-check + Vite production build |
| `npm run transpile:electron` | Compile Electron main process |
| `npm run dist:win` | Package Windows installer |

### Gemini API key

Reflections, the Coach and the AI timeline are written with Google Gemini, using your own API key
(create one at <https://aistudio.google.com/apikey>). Tracking and the measured numbers work without it.

The key is resolved in the Electron main process, in this order:

1. **`GEMINI_API_KEY` environment variable.** In development (`npm run dev`) it is also read from a
   git-ignored `.env` in the project root — copy `.env.example` to `.env`. The installed app does not read `.env`.
2. **The key saved in Settings → AI (Gemini).** It is checked with Gemini, then stored in the profile directory
   (`%APPDATA%\productivity-coach\gemini-api-key.bin`) encrypted by Windows for your account (Electron `safeStorage` / DPAPI).
   This is how the installed app is configured. A saved key takes effect immediately, without a restart.

The key is never written to the database, the logs or the renderer. `GEMINI_MODEL` (environment / `.env`)
optionally overrides the default model.

### Architecture

```text
src/
├── electron/          # Main process, preload, path resolution, logging
├── service/           # Generic logging utility
└── ui/                # React renderer (shell, layout, theme, starter pages)
```

---

## Privacy

This starter stores nothing beyond the standard Electron app and browser state.

---

## License

[MIT](LICENSE)
