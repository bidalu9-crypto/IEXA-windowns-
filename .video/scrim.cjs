// Caption backdrop: a soft bottom band plus a wide elliptical spotlight centred
// on the caption line. A uniform band dark enough to beat bright cards would
// also swallow the whole lower third; concentrating the falloff where the text
// actually sits keeps the UI readable and the caption clean.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const W = 1920;
const H = 1080;

const BAND_TOP = 700;
const BAND_MAX = 0.55;

const CX = 960;
const CY = 950;
const RX = 780;
const RY = 165;
const ELLIPSE_MAX = 0.66;

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

(async () => {
  const raw = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    const band = y >= BAND_TOP ? BAND_MAX * smoothstep((y - BAND_TOP) / (H - BAND_TOP)) : 0;
    for (let x = 0; x < W; x += 1) {
      const nx = (x - CX) / RX;
      const ny = (y - CY) / RY;
      const r2 = nx * nx + ny * ny;
      const ellipse = r2 >= 1 ? 0 : ELLIPSE_MAX * Math.pow(1 - r2, 1.5);
      // screen-composite the two masks so they never stack past 1
      const a = 1 - (1 - band) * (1 - ellipse);
      const o = (y * W + x) * 4;
      raw[o] = 9;
      raw[o + 1] = 9;
      raw[o + 2] = 13;
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const out = path.resolve('.video', 'scrim.png');
  await sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toFile(out);
  console.log('scrim', out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
})();
