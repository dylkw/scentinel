import test from 'node:test';
import assert from 'node:assert/strict';
import { redditHealth } from '../src/health.js';

const now = 1700001000000;
const options = { source: 'json', metrics: { lastSuccessAt: now }, intervalMs: 90000, now };

test('successful detail refreshes cannot hide stale or absent discovery', () => {
  for (const lastDiscoveryAt of [0, now - 6 * 86400000]) {
    const health = redditHealth({ ...options, state: { lastSuccessfulReadAt: now, lastDiscoveryAt, queue: [] } });
    assert.equal(health.ok, false);
    assert.equal(health.discoveryFresh, false);
  }
  assert.equal(redditHealth(options).ok, false);
});

test('session health requires both recent discovery and recent readable posts', () => {
  const state = { lastDiscoveryAt: now - 180000, lastSuccessfulReadAt: now - 90000, queue: [] };
  assert.equal(redditHealth({ ...options, state }).ok, true);
  assert.equal(redditHealth({ ...options, state: { ...state, lastSuccessfulReadAt: now - 270000 } }).ok, false);
  assert.equal(redditHealth({ ...options, source: 'html', state: { ...state, lastDiscoveryAt: now - 360000 } }).ok, true);
  assert.equal(redditHealth({ ...options, source: 'html', state: { ...state, lastDiscoveryAt: now - 390000 } }).ok, false);
});

test('RSS health continues to use the last successful poll', () => {
  assert.equal(redditHealth({ ...options, source: 'rss' }).ok, true);
  assert.equal(redditHealth({ ...options, source: 'rss', metrics: { lastSuccessAt: now - 270000 } }).ok, false);
});
