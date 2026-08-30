import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import sharp from 'sharp';

const projectFile = (path: string): URL => new URL(`../${path}`, import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(projectFile(path), 'utf8');
}

test('the supplied Splendide artwork is the tracked icon master', async () => {
  const master = await readFile(projectFile('resources/splendide-icon-source.png'));
  assert.equal(
    createHash('sha256').update(master).digest('hex'),
    '51d257be6d867d0843c203ce3f1fc3464e4111d4b8433bbc00fad4f092b715eb',
  );
  const metadata = await sharp(master).metadata();
  assert.equal(metadata.width, 1254);
  assert.equal(metadata.height, 1254);
  assert.equal(metadata.hasAlpha, true);
});

test('web, store, and native raster icons have platform-safe dimensions', async () => {
  const expected = [
    ['public/favicon.png', 48, 48, true],
    ['public/icons/icon-192.png', 192, 192, true],
    ['public/icons/icon-256.png', 256, 256, true],
    ['public/icons/icon-512.png', 512, 512, true],
    ['public/icons/icon-maskable-512.png', 512, 512, false],
    ['public/icons/apple-touch-icon.png', 180, 180, false],
    ['public/icons/notification-badge-96.png', 96, 96, true],
    ['build/icon.png', 512, 512, true],
    ['resources/play-store-icon.png', 512, 512, false],
    ['ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024, 1024, false],
    ['android/app/src/main/res/drawable-nodpi/ic_notification_splendide.png', 256, 256, true],
    ['android/app/src/main/res/drawable-port-xxxhdpi/splash.png', 1280, 1920, false],
    ['android/app/src/main/res/drawable-port-night-xxxhdpi/splash.png', 1280, 1920, false],
    ['ios/App/App/Assets.xcassets/Splash.imageset/Default@3x~universal~anyany.png', 2732, 2732, false],
    ['ios/App/App/Assets.xcassets/Splash.imageset/Default@3x~universal~anyany-dark.png', 2732, 2732, false],
  ] as const;

  for (const [path, width, height, hasAlpha] of expected) {
    const metadata = await sharp(await readFile(projectFile(path))).metadata();
    assert.equal(metadata.width, width, `${path} width`);
    assert.equal(metadata.height, height, `${path} height`);
    assert.equal(metadata.hasAlpha, hasAlpha, `${path} alpha`);
  }
});

test('every runtime points at the generated Splendide icon family', async () => {
  const [html, manifestSource, worker, capacitor, electron, androidManifest] = await Promise.all([
    source('src/index.html'),
    source('public/site.webmanifest'),
    source('public/push-sw.js'),
    source('capacitor.config.ts'),
    source('electron/main.ts'),
    source('android/app/src/main/AndroidManifest.xml'),
  ]);
  const manifest = JSON.parse(manifestSource) as { icons: Array<{ src: string; purpose: string }> };

  assert.match(html, /favicon\.png\?v=3/);
  assert.match(html, /apple-touch-icon\.png\?v=3/);
  assert.deepEqual(
    manifest.icons.map(({ src, purpose }) => [src, purpose]),
    [
      ['/icons/icon-192.png', 'any'],
      ['/icons/icon-512.png', 'any'],
      ['/icons/icon-maskable-512.png', 'maskable'],
    ],
  );
  assert.match(worker, /icon: '\/icons\/icon-192\.png'/);
  assert.match(worker, /badge: '\/icons\/notification-badge-96\.png'/);
  assert.match(capacitor, /smallIcon: 'ic_stat_splendide'/);
  assert.match(electron, /icons', 'icon-256\.png'/);
  assert.match(androidManifest, /com\.google\.firebase\.messaging\.default_notification_icon/);
});
