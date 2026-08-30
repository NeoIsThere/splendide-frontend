import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import png2icons from 'png2icons';
import sharp from 'sharp';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(projectRoot, 'resources', 'splendide-icon-source.png');

const resolveProjectPath = (...parts) => path.join(projectRoot, ...parts);

async function ensureParent(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function save(filePath, data) {
  await ensureParent(filePath);
  await writeFile(filePath, data);
}

async function cleanedMaster() {
  const { data, info } = await sharp(await readFile(sourcePath))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // The supplied master contains a few almost-transparent export speckles at
  // the canvas edge. Remove only those imperceptible pixels while preserving
  // the anti-aliased artwork itself.
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 8) data[index] = 0;
  }

  return sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  }).png({ compressionLevel: 9 }).toBuffer();
}

function gradientSvg(size) {
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <defs>
        <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fff3df"/>
          <stop offset="0.48" stop-color="#eef1eb"/>
          <stop offset="1" stop-color="#a7d4f1"/>
        </linearGradient>
        <radialGradient id="glow" cx="0.62" cy="0.12" r="0.84">
          <stop offset="0" stop-color="#fff9ed" stop-opacity="0.72"/>
          <stop offset="1" stop-color="#fff9ed" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${size}" height="${size}" fill="url(#base)"/>
      <rect width="${size}" height="${size}" fill="url(#glow)"/>
    </svg>
  `);
}

function splashBackgroundSvg(width, height, dark) {
  const colors = dark
    ? ['#263744', '#18242d', '#0d1419']
    : ['#edf2f4', '#cbd8e1', '#a5bac9'];
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="splash" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${colors[0]}"/>
          <stop offset="0.54" stop-color="${colors[1]}"/>
          <stop offset="1" stop-color="${colors[2]}"/>
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#splash)"/>
    </svg>
  `);
}

async function resizeIcon(master, size) {
  return sharp(master)
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function opaqueIcon(master, size) {
  const icon = await resizeIcon(master, size);
  return sharp(gradientSvg(size))
    .composite([{ input: icon }])
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function roundIcon(master, size) {
  const icon = await resizeIcon(master, size);
  const mask = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/>
    </svg>
  `);
  return sharp(icon)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function splashImage(master, width, height, dark = false) {
  const iconSize = Math.round(Math.min(width, height) * 0.22);
  const icon = await resizeIcon(master, iconSize);
  return sharp(splashBackgroundSvg(width, height, dark))
    .composite([{
      input: icon,
      left: Math.round((width - iconSize) / 2),
      top: Math.round((height - iconSize) / 2),
    }])
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function notificationBadge(size) {
  const stroke = Math.max(8, Math.round(size * 0.13));
  return sharp(Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96">
      <path d="M22 50 L40 68 L75 31" fill="none" stroke="#000" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `)).png({ compressionLevel: 9 }).toBuffer();
}

async function socialPreview(master) {
  const icon = await resizeIcon(master, 118);
  const iconData = icon.toString('base64');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc">
  <title id="title">Splendide preview</title>
  <desc id="desc">A minimalist collaborative to-do list interface preview.</desc>
  <defs>
    <linearGradient id="page" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#d5e3ed"/>
      <stop offset="0.52" stop-color="#b9cbd9"/>
      <stop offset="1" stop-color="#8fa8bc"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#page)"/>
  <rect x="70" y="70" width="1060" height="490" rx="28" fill="#ffffff" fill-opacity="0.92" stroke="#60778a" stroke-width="2"/>
  <image x="962" y="92" width="118" height="118" href="data:image/png;base64,${iconData}"/>
  <text x="116" y="158" fill="#111111" font-family="Inter, Arial, sans-serif" font-size="64" font-weight="700">splendide.</text>
  <text x="116" y="218" fill="#3f3f46" font-family="Inter, Arial, sans-serif" font-size="30">A minimalist collaborative to-do list</text>
  <g transform="translate(116 282)">
    <text x="0" y="0" fill="#111111" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="700">weekend plan</text>
    <rect x="0" y="26" width="924" height="58" rx="12" fill="#f4f4f5" stroke="#d4d4d8"/>
    <circle cx="31" cy="55" r="10" fill="none" stroke="#111111" stroke-width="3"/>
    <text x="58" y="64" fill="#18181b" font-family="Inter, Arial, sans-serif" font-size="24">pick up flowers</text>
    <rect x="0" y="102" width="924" height="58" rx="12" fill="#f4f4f5" stroke="#d4d4d8"/>
    <path d="M23 131 l7 7 l16 -18" fill="none" stroke="#111111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="58" y="140" fill="#52525b" font-family="Inter, Arial, sans-serif" font-size="24" text-decoration="line-through">share the packing list</text>
  </g>
  <text x="116" y="505" fill="#52525b" font-family="Inter, Arial, sans-serif" font-size="24">deadlines · sync · shareable pages</text>
</svg>\n`);
}

const master = await cleanedMaster();
const icon1024 = await resizeIcon(master, 1024);
const opaque1024 = await opaqueIcon(master, 1024);

const webIcons = new Map([
  ['public/favicon.png', await resizeIcon(master, 48)],
  ['public/icons/icon-192.png', await resizeIcon(master, 192)],
  ['public/icons/icon-256.png', await resizeIcon(master, 256)],
  ['public/icons/icon-512.png', await resizeIcon(master, 512)],
  ['public/icons/icon-maskable-512.png', await opaqueIcon(master, 512)],
  ['public/icons/apple-touch-icon.png', await opaqueIcon(master, 180)],
  ['public/icons/notification-badge-96.png', await notificationBadge(96)],
]);
for (const [filePath, data] of webIcons) await save(resolveProjectPath(filePath), data);

const faviconIco = png2icons.createICO(icon1024, png2icons.BICUBIC2, 0, true, false);
const executableIco = png2icons.createICO(icon1024, png2icons.BICUBIC2, 0, false, true);
const macIcns = png2icons.createICNS(icon1024, png2icons.BICUBIC2, 0);
if (!faviconIco || !executableIco || !macIcns) throw new Error('Could not generate desktop icon containers.');

await save(resolveProjectPath('public', 'favicon.ico'), faviconIco);
await save(resolveProjectPath('build', 'icon.png'), await resizeIcon(master, 512));
await save(resolveProjectPath('build', 'icon.ico'), executableIco);
await save(resolveProjectPath('build', 'icon.icns'), macIcns);
await save(resolveProjectPath('resources', 'play-store-icon.png'), await opaqueIcon(master, 512));
await save(
  resolveProjectPath('ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png'),
  opaque1024,
);

const androidDensities = [
  ['ldpi', 36, 81],
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];
for (const [density, legacySize, adaptiveSize] of androidDensities) {
  const directory = resolveProjectPath('android', 'app', 'src', 'main', 'res', `mipmap-${density}`);
  await save(path.join(directory, 'ic_launcher.png'), await resizeIcon(master, legacySize));
  await save(path.join(directory, 'ic_launcher_round.png'), await roundIcon(master, legacySize));
  await save(path.join(directory, 'ic_launcher_foreground.png'), await resizeIcon(master, adaptiveSize));
  await save(path.join(directory, 'ic_launcher_background.png'), await sharp(gradientSvg(adaptiveSize)).png({ compressionLevel: 9 }).toBuffer());
}

const androidSplashDimensions = [
  ['drawable/splash.png', 320, 480, false],
  ['drawable-night/splash.png', 320, 240, true],
  ['drawable-land-ldpi/splash.png', 320, 240, false],
  ['drawable-land-mdpi/splash.png', 480, 320, false],
  ['drawable-land-hdpi/splash.png', 800, 480, false],
  ['drawable-land-xhdpi/splash.png', 1280, 720, false],
  ['drawable-land-xxhdpi/splash.png', 1600, 960, false],
  ['drawable-land-xxxhdpi/splash.png', 1920, 1280, false],
  ['drawable-land-night-ldpi/splash.png', 320, 240, true],
  ['drawable-land-night-mdpi/splash.png', 480, 320, true],
  ['drawable-land-night-hdpi/splash.png', 800, 480, true],
  ['drawable-land-night-xhdpi/splash.png', 1280, 720, true],
  ['drawable-land-night-xxhdpi/splash.png', 1600, 960, true],
  ['drawable-land-night-xxxhdpi/splash.png', 1920, 1280, true],
  ['drawable-port-ldpi/splash.png', 240, 320, false],
  ['drawable-port-mdpi/splash.png', 320, 480, false],
  ['drawable-port-hdpi/splash.png', 480, 800, false],
  ['drawable-port-xhdpi/splash.png', 720, 1280, false],
  ['drawable-port-xxhdpi/splash.png', 960, 1600, false],
  ['drawable-port-xxxhdpi/splash.png', 1280, 1920, false],
  ['drawable-port-night-ldpi/splash.png', 240, 320, true],
  ['drawable-port-night-mdpi/splash.png', 320, 480, true],
  ['drawable-port-night-hdpi/splash.png', 480, 800, true],
  ['drawable-port-night-xhdpi/splash.png', 720, 1280, true],
  ['drawable-port-night-xxhdpi/splash.png', 960, 1600, true],
  ['drawable-port-night-xxxhdpi/splash.png', 1280, 1920, true],
];
for (const [relativePath, width, height, dark] of androidSplashDimensions) {
  await save(
    resolveProjectPath('android', 'app', 'src', 'main', 'res', relativePath),
    await splashImage(master, width, height, dark),
  );
}

const iosSplashDirectory = resolveProjectPath(
  'ios', 'App', 'App', 'Assets.xcassets', 'Splash.imageset',
);
for (const name of [
  'Default@1x~universal~anyany.png',
  'Default@2x~universal~anyany.png',
  'Default@3x~universal~anyany.png',
  'splash-2732x2732.png',
  'splash-2732x2732-1.png',
  'splash-2732x2732-2.png',
]) {
  await save(path.join(iosSplashDirectory, name), await splashImage(master, 2732, 2732));
}
for (const name of [
  'Default@1x~universal~anyany-dark.png',
  'Default@2x~universal~anyany-dark.png',
  'Default@3x~universal~anyany-dark.png',
]) {
  await save(path.join(iosSplashDirectory, name), await splashImage(master, 2732, 2732, true));
}

await save(
  resolveProjectPath('android', 'app', 'src', 'main', 'res', 'drawable-nodpi', 'ic_notification_splendide.png'),
  await resizeIcon(master, 256),
);
await save(resolveProjectPath('public', 'og-image.svg'), await socialPreview(master));

console.log('Generated Splendide web, desktop, Android, iOS, notification, and store icon assets.');
