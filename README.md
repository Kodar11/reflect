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
