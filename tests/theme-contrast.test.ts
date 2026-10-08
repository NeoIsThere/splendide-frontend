import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function luminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map(value => Number.parseInt(value, 16) / 255) ?? [];
  const linear = channels.map(value => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function modeTokens(styles: string, dark: boolean): string {
  const pattern = dark ? /:root\.dark,\s*body\.dark\s*\{([^}]+)\}/ : /:root\s*\{([^}]+)\}/;
  const match = styles.match(pattern);
  assert.ok(match, `${dark ? 'dark' : 'light'} mode is missing`);
  return match[1];
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*(#[a-f\\d]{3,6});`, 'i'));
  assert.ok(match, `${name} must be a solid color`);
  const color = match[1];
  return color.length === 4 ? `#${[...color.slice(1)].map(value => value + value).join('')}` : color;
}

test('neutral uses solid light and dark backgrounds matching browser chrome', async () => {
  const source = await readFile(new URL('../src/app/services/theme.service.ts', import.meta.url), 'utf8');
  const neutral = source.match(/id: 'neutral',([^}]+)/)?.[1];
  assert.ok(neutral);
  assert.match(neutral, /lightGradient: '#fafafa'/);
  assert.match(neutral, /darkGradient: '#111111'/);
  assert.match(neutral, /lightChromeColor: '#fafafa'/);
  assert.match(neutral, /darkChromeColor: '#111111'/);
  assert.doesNotMatch(neutral, /gradient\(/);
});

test('active light and dark surfaces keep softened text and checkboxes readable', async () => {
  const styles = await readFile(new URL('../src/styles.scss', import.meta.url), 'utf8');
  for (const dark of [false, true]) {
    const block = modeTokens(styles, dark);
    for (const surface of ['app-background', 'bg', 'card']) {
      const background = token(block, surface);
      for (const role of ['text-primary', 'text', 'text-muted', 'text-secondary', 'text-muted-secondary', 'link']) {
        const foreground = token(block, role);
        assert.ok(contrast(background, foreground) >= 4.5, `${role} must remain readable on ${surface}`);
        assert.notEqual(foreground, dark ? '#ffffff' : '#000000', 'text should be softer than pure black/white');
      }
      assert.ok(contrast(background, token(block, 'accent')) >= 3, `checkboxes must remain visible on ${surface}`);
    }
  }
});

test('neutral overrides keep mode backgrounds and checkbox tones synchronized', async () => {
  const styles = await readFile(new URL('../src/styles.scss', import.meta.url), 'utf8');
  const light = modeTokens(styles, false);
  const dark = modeTokens(styles, true);
  const lightOverride = styles.match(/:root\[data-background-theme='neutral'\]\s*\{([^}]+)\}/)?.[1];
  const darkOverride = styles.match(/body\.dark\[data-background-theme='neutral'\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(lightOverride);
  assert.ok(darkOverride);
  assert.equal(token(lightOverride, 'app-background'), token(light, 'app-background'));
  assert.equal(token(darkOverride, 'app-background'), token(dark, 'app-background'));
  for (const block of [light, dark]) {
    assert.equal(token(block, 'accent'), token(block, 'text'));
  }
});

test('task and native deadline checkboxes use the active text tone', async () => {
  const styles = await readFile(
    new URL('../src/app/pages/home/home.component.scss', import.meta.url),
    'utf8',
  );

  assert.match(styles, /\.check-btn \{[\s\S]*?border: 1\.5px solid var\(--text\);[\s\S]*?color: var\(--text\);/);
  assert.match(styles, /\.deadline-notification-toggle \{[\s\S]*?accent-color: var\(--accent\);/);
  assert.doesNotMatch(styles, /\.task-dots-item-danger/);
});

test('interactive controls stay visible without relying on color alone', async () => {
  const [homeStyles, settingsSource] = await Promise.all([
    readFile(new URL('../src/app/pages/home/home.component.scss', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/pages/settings/settings.component.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(
    settingsSource,
    /\.settings-switch-track \{[\s\S]*?padding: 2px;[\s\S]*?border: 1px solid var\(--accent\);[\s\S]*?background: transparent;/,
  );
  assert.match(
    settingsSource,
    /\.settings-switch input:checked \+ \.settings-switch-track span \{[\s\S]*?background: var\(--card, #fff\);/,
  );
  assert.match(
    homeStyles,
    /\.share-toggle-track \{[\s\S]*?border: 1px solid var\(--accent\);[\s\S]*?background: transparent;/,
  );
  assert.match(homeStyles, /\.task-link \{[\s\S]*?text-decoration: underline;/);
  assert.match(homeStyles, /\.splendide-info-description \{[\s\S]*?text-decoration: underline;/);
  assert.doesNotMatch(homeStyles, /\.done-list \{[^}]*opacity:/);
  assert.doesNotMatch(homeStyles, /&\.done \{[^}]*opacity:/);
});

test('mobile task options are textual and retain compact accessible rows', async () => {
  const [template, homeStyles] = await Promise.all([
    readFile(new URL('../src/app/pages/home/home.component.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/pages/home/home.component.scss', import.meta.url), 'utf8'),
  ]);

  assert.match(template, /\{\{ task\.deadlineAt \? 'edit deadline' : 'add deadline' \}\}/);
  assert.match(template, />\s*add subtask\s*<\/button>/);
  assert.match(template, />\s*move to \.\.\.\s*<\/button>/);
  assert.match(template, />\s*delete task\s*<\/button>/);
  assert.doesNotMatch(template, /task-dots-item-icon-only/);
  assert.match(homeStyles, /\.task-dots-item \{[^}]*min-height: 44px;/);
  assert.match(homeStyles, /\.task-dots-btn \{[\s\S]*?@media \(max-width: 768px\) \{[^}]*width: 44px;[^}]*height: 44px;/);
});

test('task and desktop page spacing use the compact rhythm', async () => {
  const homeStyles = await readFile(
    new URL('../src/app/pages/home/home.component.scss', import.meta.url),
    'utf8',
  );

  assert.match(homeStyles, /\.section-pages-row \{[^}]*padding: 0 0 0 32px;/);
  assert.match(homeStyles, /\.section-page-actions \{[^}]*height: 26px;/);
  assert.match(homeStyles, /\.counter \{[^}]*margin: 2px 0;[^}]*line-height: 1;/);
  assert.match(homeStyles, /\.counter-invisible \{[^}]*display: none;/);
  assert.match(homeStyles, /\.task-item \{[^}]*padding: 10px;/);
  assert.match(homeStyles, /\.add-placeholder \{[\s\S]*?min-height: 44px;[\s\S]*?padding: 10px;[\s\S]*?&::after \{[\s\S]*?display: none;/);
  assert.match(homeStyles, /\.add-subtask-btn \{[\s\S]*?margin-left: 32px;[\s\S]*?display: inline-flex;[\s\S]*?pointer-events: none;/);
  assert.match(homeStyles, /\.add-subtask-btn \{[\s\S]*?@media \(max-width: 768px\) \{[^}]*display: none;/);
  assert.match(homeStyles, /\.add-subtask-btn-form \{[^}]*display: flex;[^}]*pointer-events: auto;/);
  assert.match(homeStyles, /\.done-task-item \{[\s\S]*?@media \(max-width: 768px\) \{[^}]*min-height: 44px;[^}]*padding: 0 8px;[^}]*align-items: flex-start;/);
  assert.match(homeStyles, /\.done-subtask-row \{[\s\S]*?@media \(max-width: 768px\) \{[^}]*min-height: 44px;/);
  assert.doesNotMatch(homeStyles, /\.task-drop-zone > \.add-placeholder \{[^}]*position: sticky;/);
});

test('native tablet task actions and completed rows keep mobile-safe geometry', async () => {
  const styles = await readFile(new URL('../src/styles.scss', import.meta.url), 'utf8');

  assert.match(styles, /html\.native-mobile app-home \.mobile-only \{[^}]*display: revert !important;/);
  assert.match(styles, /html\.native-mobile app-home \.desktop-add-subtask-btn,[\s\S]*?display: none !important;/);
  assert.match(styles, /html\.native-mobile app-home \.task-dots-btn \{[^}]*width: 44px;[^}]*height: 44px;/);
  assert.match(styles, /html\.native-mobile app-home \.done-task-item \{[^}]*min-height: 44px;[^}]*align-items: flex-start;/);
  assert.match(styles, /html\.native-mobile app-home \.done-subtask-row \{[^}]*min-height: 44px;/);
});
