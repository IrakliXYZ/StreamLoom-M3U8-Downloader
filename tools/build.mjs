import { context } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'extension-src');
const distDir = path.join(rootDir, 'StreamLoom');
const watch = process.argv.includes('--watch');

const copyFile = async (from, to) => {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
};

const copyDir = async (fromDir, toDir) => {
  await fs.mkdir(toDir, { recursive: true });
  const entries = await fs.readdir(fromDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (e) => {
      const from = path.join(fromDir, e.name);
      const to = path.join(toDir, e.name);
      if (e.isDirectory()) return copyDir(from, to);
      return copyFile(from, to);
    }),
  );
};

const emptyDir = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir);
  await Promise.all(entries.map((e) => fs.rm(path.join(dir, e), { recursive: true, force: true })));
};

const resolveFfmpegCoreFiles = async () => {
  const corePkgJson = path.join(rootDir, 'node_modules', '@ffmpeg', 'core', 'package.json');
  const coreDir = path.dirname(corePkgJson);

  const candidates = [
    path.join(coreDir, 'dist', 'esm'),
    path.join(coreDir, 'dist', 'umd'),
  ];

  for (const dir of candidates) {
    try {
      const entries = await fs.readdir(dir);
      const hasCoreJs = entries.some((e) => e === 'ffmpeg-core.js');
      const hasWasm = entries.some((e) => e === 'ffmpeg-core.wasm');
      if (hasCoreJs && hasWasm) {
        const worker = entries.find((e) => e.includes('ffmpeg-core.worker') && e.endsWith('.js'));
        return {
          dir,
          worker: worker ? path.join(dir, worker) : null,
        };
      }
    } catch {}
  }

  throw new Error('Unable to locate @ffmpeg/core distribution files.');
};

const crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32Table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const crcVal = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
};

const encodePngRGBA = (width, height, rgba) => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.subarray(y * stride, y * stride + stride)).copy(raw, y * (stride + 1) + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const hexToRgb = (h) => {
  const s = h.replace('#', '');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const gradientColor = (stops, t) => {
  const x = ((t % 1) + 1) % 1;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (x >= a.t && x <= b.t) {
      const u = (x - a.t) / (b.t - a.t || 1);
      return lerp3(a.rgb, b.rgb, u);
    }
  }
  return stops[stops.length - 1].rgb;
};

const distToRoundedRect = (x, y, w, h, r) => {
  const cx = x < r ? r : x > w - r ? w - r : x;
  const cy = y < r ? r : y > h - r ? h - r : y;
  const dx = x - cx;
  const dy = y - cy;
  const outside = Math.hypot(dx, dy) - r;
  if (x >= r && x <= w - r && y >= 0 && y <= h) return Math.max(0, -Math.min(y, h - y));
  if (x >= 0 && x <= w && y >= r && y <= h - r) return Math.max(0, -Math.min(x, w - x));
  return outside;
};

const iconGlyphs = {
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
};

const blendPixel = (rgba, size, x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  const dstA = rgba[i + 3] / 255;
  if (dstA <= 0) return;
  const srcA = a;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  rgba[i] = Math.round((r * srcA + rgba[i] * dstA * (1 - srcA)) / outA);
  rgba[i + 1] = Math.round((g * srcA + rgba[i + 1] * dstA * (1 - srcA)) / outA);
  rgba[i + 2] = Math.round((b * srcA + rgba[i + 2] * dstA * (1 - srcA)) / outA);
  rgba[i + 3] = Math.round(outA * 255);
};

const drawIconText = (rgba, size, bx, by, bw, bh) => {
  const glyphW = 5;
  const glyphH = 7;
  const letterGap = 1;
  const lineGap = 2;
  const lines = size <= 32 ? [['M', '3']] : [['M', '3'], ['U', '8']];
  const baseW = glyphW * 2 + letterGap;
  const baseH = lines.length === 1 ? glyphH : glyphH * 2 + lineGap;

  const scaleW = Math.floor((bw * 0.78) / baseW);
  const scaleH = Math.floor((bh * 0.78) / baseH);
  const s = Math.max(1, Math.min(scaleW, scaleH));

  const drawChar = (ch, ox, oy, color, alpha, bold = 0) => {
    const rows = iconGlyphs[ch];
    if (!rows) return;
    for (let gy = 0; gy < rows.length; gy++) {
      const row = rows[gy];
      for (let gx = 0; gx < row.length; gx++) {
        if (row[gx] !== '1') continue;
        const px = ox + gx * s;
        const py = oy + gy * s;
        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) {
            blendPixel(rgba, size, px + dx, py + dy, color[0], color[1], color[2], alpha);
          }
        }
        if (bold) {
          for (let dy = 0; dy < s; dy++) {
            blendPixel(rgba, size, px + s, py + dy, color[0], color[1], color[2], alpha * 0.95);
          }
        }
      }
    }
  };

  const totalW = baseW * s;
  const totalH = baseH * s;
  const startX = Math.round(bx + (bw - totalW) / 2);
  const startY = Math.round(by + (bh - totalH) / 2);

  const xLeft = startX;
  const xRight = startX + (glyphW + letterGap) * s;
  const yTop = startY;
  const yBottom = startY + (glyphH + lineGap) * s;

  const shadowOff = Math.max(1, Math.round(s * 0.35));
  const bold = s >= 2 ? 1 : 0;

  const shadow = [0, 0, 0];
  const white = [255, 255, 255];

  drawChar('M', xLeft + shadowOff, yTop + shadowOff, shadow, 0.35, bold);
  drawChar('3', xRight + shadowOff, yTop + shadowOff, shadow, 0.35, bold);
  if (lines.length === 2) {
    drawChar('U', xLeft + shadowOff, yBottom + shadowOff, shadow, 0.35, bold);
    drawChar('8', xRight + shadowOff, yBottom + shadowOff, shadow, 0.35, bold);
  }

  drawChar('M', xLeft, yTop, white, 0.92, bold);
  drawChar('3', xRight, yTop, white, 0.92, bold);
  if (lines.length === 2) {
    drawChar('U', xLeft, yBottom, white, 0.92, bold);
    drawChar('8', xRight, yBottom, white, 0.92, bold);
  }
};

const makeIconRgba = (size) => {
  const colors = ['#7c5cff', '#19d3ff', '#29f5a6', '#7c5cff'].map(hexToRgb);
  const stops = [
    { t: 0, rgb: colors[0] },
    { t: 0.33, rgb: colors[1] },
    { t: 0.66, rgb: colors[2] },
    { t: 1, rgb: colors[3] },
  ];

  const rgba = new Uint8Array(size * size * 4);
  const pad = Math.max(1, Math.round(size * 0.08));
  const r = Math.max(2, Math.round(size * 0.32));
  const bx = pad;
  const by = pad;
  const bw = size - pad * 2;
  const bh = size - pad * 2;
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const angleOffset = (190 * Math.PI) / 180;
  const border = Math.max(1, Math.round(size * 0.06));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const rx = x - bx;
      const ry = y - by;
      if (rx < 0 || ry < 0 || rx >= bw || ry >= bh) {
        rgba[idx + 3] = 0;
        continue;
      }

      const d = distToRoundedRect(rx, ry, bw, bh, r);
      if (d > 0) {
        rgba[idx + 3] = 0;
        continue;
      }

      const ang = Math.atan2(y - cy, x - cx) + Math.PI;
      const t = ((ang - angleOffset) / (Math.PI * 2) + 1) % 1;
      let [rr, gg, bb] = gradientColor(stops, t);

      const topH = Math.max(1, Math.round(size * 0.28));
      if (y < by + topH) {
        const k = 0.08;
        rr = rr + (255 - rr) * k;
        gg = gg + (255 - gg) * k;
        bb = bb + (255 - bb) * k;
      }

      const edge = Math.min(rx, bw - 1 - rx, ry, bh - 1 - ry);
      if (edge < border) {
        const k = 0.18;
        rr = rr + (255 - rr) * k;
        gg = gg + (255 - gg) * k;
        bb = bb + (255 - bb) * k;
      }

      rgba[idx] = Math.round(rr);
      rgba[idx + 1] = Math.round(gg);
      rgba[idx + 2] = Math.round(bb);
      rgba[idx + 3] = 255;
    }
  }

  drawIconText(rgba, size, bx, by, bw, bh);
  return rgba;
};

const writeIcons = async () => {
  const iconDir = path.join(distDir, 'icons');
  await fs.mkdir(iconDir, { recursive: true });
  const sizes = [16, 32, 48, 128];
  await Promise.all(
    sizes.map(async (s) => {
      const rgba = makeIconRgba(s);
      const png = encodePngRGBA(s, s, rgba);
      await fs.writeFile(path.join(iconDir, `icon${s}.png`), png);
    }),
  );
};

const doBuild = async () => {
  await emptyDir(distDir);

  await copyFile(path.join(srcDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
  await copyFile(path.join(srcDir, 'popup.html'), path.join(distDir, 'popup.html'));
  await copyFile(path.join(srcDir, 'popup.css'), path.join(distDir, 'popup.css'));
  await copyFile(path.join(srcDir, 'offscreen.html'), path.join(distDir, 'offscreen.html'));
  await copyDir(path.join(srcDir, 'assets'), path.join(distDir, 'assets')).catch(() => {});
  await writeIcons();

  const core = await resolveFfmpegCoreFiles();
  await fs.mkdir(path.join(distDir, 'vendor'), { recursive: true });
  await copyFile(path.join(core.dir, 'ffmpeg-core.js'), path.join(distDir, 'vendor', 'ffmpeg-core.js'));
  await copyFile(path.join(core.dir, 'ffmpeg-core.wasm'), path.join(distDir, 'vendor', 'ffmpeg-core.wasm'));
  if (core.worker) {
    await copyFile(core.worker, path.join(distDir, 'vendor', path.basename(core.worker)));
  }
  await copyFile(
    path.join(rootDir, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', 'worker.js'),
    path.join(distDir, 'worker.js'),
  );
  await copyFile(
    path.join(rootDir, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', 'const.js'),
    path.join(distDir, 'const.js'),
  );
  await copyFile(
    path.join(rootDir, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', 'errors.js'),
    path.join(distDir, 'errors.js'),
  );

  const entryPoints = {
    background: path.join(srcDir, 'background.js'),
    popup: path.join(srcDir, 'popup.js'),
    offscreen: path.join(srcDir, 'offscreen.js'),
  };

  const ctx = await context({
    entryPoints,
    outdir: distDir,
    bundle: true,
    format: 'esm',
    target: 'chrome110',
    sourcemap: watch,
    minify: !watch,
    define: {
      __FFMPEG_CORE_URL__: JSON.stringify('vendor/ffmpeg-core.js'),
      __FFMPEG_WASM_URL__: JSON.stringify('vendor/ffmpeg-core.wasm'),
      __FFMPEG_WORKER_FILENAME__: JSON.stringify(core.worker ? path.basename(core.worker) : ''),
    },
  });

  if (watch) {
    await ctx.watch();
    console.log('watching');
    return;
  }

  await ctx.rebuild();
  await ctx.dispose();
};

await doBuild();
