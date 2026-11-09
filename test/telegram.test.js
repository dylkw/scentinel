import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramApi, TelegramUpdateRetry } from '../src/telegram.js';

test('Telegram errors retain conflict and server retry metadata', async () => {
  const api = createTelegramApi('test', async () => Response.json({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, { status: 409 }));
  await assert.rejects(api('getUpdates'), (error) => error.status === 409 && error.errorCode === 409 && /Conflict/.test(error.message));
  const limited = createTelegramApi('test', async () => Response.json({ ok: false, error_code: 429, description: 'Too many requests', parameters: { retry_after: 120 } }, { status: 429 }));
  await assert.rejects(limited('getUpdates'), (error) => error.errorCode === 429 && error.retryAfterMs === 120_000);
});

test('conflicts back off and stay quiet across immediate successful polls', () => {
  const retry = new TelegramUpdateRetry();
  const error = Object.assign(new Error('Telegram getUpdates: Conflict'), { errorCode: 409 });
  assert.deepEqual(retry.failure(error), { delay: 30_000, log: true, conflict: true });
  retry.success(100);
  assert.deepEqual(retry.failure(error), { delay: 60_000, log: false, conflict: true });
  retry.success(100);
  assert.equal(retry.failure(error).delay, 60_000);
  retry.success(50_000);
  assert.deepEqual(retry.failure(error), { delay: 30_000, log: true, conflict: true });
});

test('transient failures back off and honor Telegram rate limits', () => {
  const retry = new TelegramUpdateRetry();
  const error = new Error('network failed');
  assert.equal(retry.failure(error).delay, 500);
  assert.equal(retry.failure(error).delay, 1000);
  assert.equal(retry.failure(error).delay, 2000);
  const rateLimit = Object.assign(new Error('rate limited'), { errorCode: 429, retryAfterMs: 120_000 });
  assert.equal(retry.failure(rateLimit).delay, 120_000);
  retry.success(50_000);
  assert.equal(retry.failure(error).delay, 500);
});
