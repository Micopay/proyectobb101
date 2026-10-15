// Generate Micopay brand assets from the gold mushroom mascot.
// Output:
//   resources/icon.png          1024x1024 PNG on Micopay primary background
//   resources/splash.png        2732x2732 PNG with centered mushroom on bg
//   resources/icon-foreground.png  1024x1024 transparent for adaptive icons
//   resources/icon-background.png  1024x1024 solid brand color
// Pipeline reads from public/mushroom_gold.png.

import sharp from 'sharp';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = resolve(root, 'public/mushroom_gold.png');
const out = resolve(root, 'resources');

const BG = { r: 0, g: 105, b: 76, alpha: 1 }; // #00694C primary brand

await mkdir(out, { recursive: true });

// 1) Square legacy icon — mushroom on solid brand bg, padded
const ICON_SIZE = 1024;
const ICON_PADDING = 160; // mushroom fits in (1024 - 2*160) = 704px
const mushroomIcon = await sharp(src)
  .resize(ICON_SIZE - 2 * ICON_PADDING, ICON_SIZE - 2 * ICON_PADDING, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer();

await sharp({
  create: { width: ICON_SIZE, height: ICON_SIZE, channels: 4, background: BG },
})
  .composite([{ input: mushroomIcon, gravity: 'center' }])
  .png()
  .toFile(resolve(out, 'icon.png'));

// 2) Adaptive icon foreground — mushroom on transparent (safe zone ~66% of 1024)
const FG_SAFE = 432; // half of 864 — fits in inner 864x864 safe zone
const mushroomFg = await sharp(src)
  .resize(FG_SAFE * 2, FG_SAFE * 2, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer();

await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: mushroomFg, gravity: 'center' }])
  .png()
  .toFile(resolve(out, 'icon-foreground.png'));

// 3) Adaptive icon background — solid brand color
await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: BG },
})
  .png()
  .toFile(resolve(out, 'icon-background.png'));

// 4) Splash — 2732x2732, mushroom centered (~30% of canvas)
const SPLASH = 2732;
const SPLASH_MUSHROOM = 820;
const mushroomSplash = await sharp(src)
  .resize(SPLASH_MUSHROOM, SPLASH_MUSHROOM, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer();

await sharp({
  create: { width: SPLASH, height: SPLASH, channels: 4, background: BG },
})
  .composite([{ input: mushroomSplash, gravity: 'center' }])
  .png()
  .toFile(resolve(out, 'splash.png'));

console.log('Generated brand assets in', out);
