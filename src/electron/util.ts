import { ipcMain, WebContents, WebFrameMain } from 'electron';
import { getUIPath, getWidgetUIPath } from './pathResolver.js';
import { pathToFileURL } from 'url';

export function isDev(): boolean {
  // NODE_ENV is the primary signal (set by `cross-env` in `npm run dev`),
  // but UAC elevation doesn't reliably forward env vars to the new process,
  // so we also accept an explicit `--dev` argv flag that the elevated
  // relaunch path adds. Without this, the admin instance flips to
  // file://dist-react which is empty/stale → black window.
  return process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
}

/**
 * Wrap ipcMain.handle with frame validation. Handler may take an optional
 * payload arg. Return type is the matching key in EventPayloadMapping or a
 * Promise of it.
 */
export function ipcMainHandle(
  key: string,
  handler: (payload?: any) => any,
) {
  ipcMain.handle(key, async (event, payload) => {
    validateEventFrame(event.senderFrame);
    return await handler(payload);
  });
}

export function ipcMainOn(
  key: string,
  handler: (payload: any) => void,
) {
  ipcMain.on(key, (event, payload) => {
    validateEventFrame(event.senderFrame);
    return handler(payload);
  });
}

export function ipcWebContentsSend(
  key: string,
  webContents: WebContents,
  payload: any,
) {
  webContents.send(key, payload);
}

const DEV_HOST = 'localhost:5123';
const DEV_WIDGET_PATH = '/widget.html';

/** Accept IPC only from the main window's page. */
export function validateEventFrame(frame: WebFrameMain | null) {
  if (!frame) return;
  if (isDev()) {
    const url = new URL(frame.url);
    if (url.host === DEV_HOST && url.pathname !== DEV_WIDGET_PATH) return;
  }
  if (frame.url !== pathToFileURL(getUIPath()).toString()) {
    throw new Error('Malicious event');
  }
}

/**
 * Accept IPC only from the floating widget's page. The widget has its own
 * channels and may use nothing else: a `widget:*` handler refuses the main
 * page, and every other handler refuses the widget.
 */
export function validateWidgetFrame(frame: WebFrameMain | null) {
  if (!frame) return;
  if (isDev()) {
    const url = new URL(frame.url);
    if (url.host === DEV_HOST && url.pathname === DEV_WIDGET_PATH) return;
  }
  if (frame.url !== pathToFileURL(getWidgetUIPath()).toString()) {
    throw new Error('Malicious event');
  }
}

export function widgetIpcHandle(key: string, handler: (payload?: any) => any) {
  ipcMain.handle(key, async (event, payload) => {
    validateWidgetFrame(event.senderFrame);
    return await handler(payload);
  });
}

export function widgetIpcOn(key: string, handler: (payload: any) => void) {
  ipcMain.on(key, (event, payload) => {
    validateWidgetFrame(event.senderFrame);
    return handler(payload);
  });
}
