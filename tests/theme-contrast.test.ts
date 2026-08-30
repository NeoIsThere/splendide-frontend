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

test('every stronger light gradient keeps text and links at AA contrast', async () => {
  const source = await readFile(
    new URL('../src/app/services/theme.service.ts', import.meta.url),
    'utf8',
  );
  const gradients = [...source.matchAll(/lightGradient: '[^']*(#[a-f\d]{6}) 100%\)'/gi)];
  assert.equal(gradients.length, 6);

  for (const match of gradients) {
    const darkestEndpoint = match[1];
    assert.ok(
      contrast(darkestEndpoint, '#202020') >= 4.5,
      `${darkestEndpoint} must remain readable with secondary text`,
    );
    assert.ok(
      contrast(darkestEndpoint, '#21134d') >= 4.5,
      `${darkestEndpoint} must remain readable with links`,
    );
  }
});
