import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOpenModelBanner } from '../src/ui/banner.mjs';

test('renders only the OPENMODEL banner without the previous secondary label', () => {
  const banner = renderOpenModelBanner({ color: false });
  assert.match(banner, /██████/);
  assert.doesNotMatch(banner, /2D|RETRO/i);
  assert.equal(banner.trimEnd().split('\n').length, 6);
});

test('renders a blue ANSI gradient when color is enabled', () => {
  const banner = renderOpenModelBanner({ color: true });
  assert.match(banner, /\u001B\[38;2;37;99;235m/);
  assert.match(banner, /\u001B\[0m/);
});
