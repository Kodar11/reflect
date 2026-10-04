import path from 'path';
import { app } from 'electron';
import { isDev } from './util.js';

export function getPreloadPath() {
  return path.join(
    app.getAppPath(),
    isDev() ? '.' : '..',
    '/dist-electron/electron/preload.cjs'
  );
}

/** The floating widget has its own, much smaller preload: it exposes only `window.widget`. */
export function getWidgetPreloadPath() {
  return path.join(
    app.getAppPath(),
    isDev() ? '.' : '..',
    '/dist-electron/electron/widgetPreload.cjs'
  );
}

export function getUIPath() {
  return path.join(app.getAppPath(), '/dist-react/index.html');
}

export function getWidgetUIPath() {
  return path.join(app.getAppPath(), '/dist-react/widget.html');
}
