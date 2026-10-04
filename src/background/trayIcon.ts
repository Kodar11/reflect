/**
 * The tray icon, drawn in code: a filled disc with a light centre while
 * tracking, a grey disc with two bars while tracking is paused. No image
 * files to package, and the paused state is visible at a glance.
 *
 * Returns raw 32-bit pixels (BGRA, premultiplied) — what Electron's
 * `nativeImage.createFromBitmap` takes on Windows.
 */

export const TRAY_ICON_SIZE = 32;

const RUNNING: [number, number, number] = [0x23, 0x82, 0xe2]; // --accent
const PAUSED: [number, number, number] = [0x8a, 0x8a, 0x86];
const MARK: [number, number, number] = [0xff, 0xff, 0xff];

/** Coverage of a pixel by a disc of `radius` around the centre, anti-aliased over ~1px. */
const disc = (distance: number, radius: number) => Math.min(1, Math.max(0, radius - distance + 0.5));

export function renderTrayIcon(paused: boolean, size: number = TRAY_ICON_SIZE): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const outer = size / 2 - 1;
  const fill = paused ? PAUSED : RUNNING;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const alpha = disc(Math.hypot(dx, dy), outer);
      if (alpha === 0) continue;

      // The mark on top of the disc: a centre dot, or two pause bars.
      const mark = paused
        ? Math.abs(dy) <= size * 0.2 && Math.abs(Math.abs(dx) - size * 0.11) <= size * 0.055
          ? 1
          : 0
        : disc(Math.hypot(dx, dy), size * 0.17);

      const i = (y * size + x) * 4;
      const channel = (c: number) => Math.round((fill[c] * (1 - mark) + MARK[c] * mark) * alpha);
      pixels[i] = channel(2); // B
      pixels[i + 1] = channel(1); // G
      pixels[i + 2] = channel(0); // R
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}
