// Tray icons for the CRM client. The monitor's tray is a traffic light; this
// app uses a single blue dot, dimmed to grey when the API connection is down.
//
// Drawn procedurally into a raw premultiplied-BGRA bitmap and handed to
// nativeImage.createFromBitmap — no PNG encoder and no headless browser needed,
// so it works at build time on any platform.
import { nativeImage } from 'electron';

const SIZE = 32;            // bitmap pixels
const SCALE = 2;            // → 16px logical tray icon (crisp on HiDPI)

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Build a glossy filled circle in the given [r,g,b] (0-255) on a transparent
// field. `dim` desaturates/darkens it for the disconnected state.
function makeDot([r, g, b], dim = false) {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const cx = (SIZE - 1) / 2;
  const cy = (SIZE - 1) / 2;
  const radius = SIZE * 0.42;            // leaves a little breathing room
  // Highlight centre (upper-left) for the LED sheen.
  const hx = cx - radius * 0.34;
  const hy = cy - radius * 0.40;
  const hr = radius * 0.95;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Anti-aliased disc coverage (1px soft edge).
      const cover = clamp01(radius - dist + 0.5);
      if (cover <= 0) continue;

      // Vertical shade: top a touch lighter, bottom a touch darker.
      const shade = 1 + (cy - y) / SIZE * 0.45;
      // Specular highlight falloff.
      const hdist = Math.sqrt((x - hx) * (x - hx) + (y - hy) * (y - hy));
      const spec = clamp01(1 - hdist / hr) ** 2 * 0.55;

      let rr = r * shade + (255 - r) * spec;
      let gg = g * shade + (255 - g) * spec;
      let bb = b * shade + (255 - b) * spec;
      if (dim) { rr = rr * 0.45 + 60; gg = gg * 0.45 + 64; bb = bb * 0.45 + 70; }

      const a = Math.round(cover * 255);
      // Premultiplied BGRA (the format nativeImage bitmaps use).
      const i = (y * SIZE + x) * 4;
      buf[i + 0] = Math.round(clamp01(bb / 255) * a);
      buf[i + 1] = Math.round(clamp01(gg / 255) * a);
      buf[i + 2] = Math.round(clamp01(rr / 255) * a);
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE, scaleFactor: SCALE });
}

const BLUE = [59, 130, 246]; // #3b82f6

export const icons = {
  blue: makeDot(BLUE),
  grey: makeDot(BLUE, true),
  // Aliases so shared shell code that asks for a status colour still resolves.
  green: makeDot(BLUE),
  yellow: makeDot(BLUE),
  red: makeDot(BLUE),
  black: makeDot(BLUE, true),
};
