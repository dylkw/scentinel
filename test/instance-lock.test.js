import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from '../src/instance-lock.js';

const moduleUrl = new URL('../src/instance-lock.js', import.meta.url).href;
const startChild = (file) => spawn(process.execPath, ['--input-type=module', '-e', `
  import { acquireInstanceLock } from ${JSON.stringify(moduleUrl)};
  try {
    const release = acquireInstanceLock(process.argv[1]);
    process.once('exit', release);
    console.log('locked');
    process.stdin.resume();
    process.stdin.once('end', () => process.exit(0));
  } catch (error) { console.error(error.message); process.exit(1); }
`, file], { stdio: ['pipe', 'pipe', 'pipe'] });

test('only one worker can claim a store; release permits a later startup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'store.json');
  const release = acquireInstanceLock(file);
  t.after(release);
  assert.throws(() => acquireInstanceLock(file), /already running/);
  const child = startChild(file);
  const exited = once(child, 'exit');
  let error = '';
  child.stderr.on('data', (chunk) => { error += chunk; });
  assert.equal((await exited)[0], 1);
  assert.match(error, new RegExp(`already running \\(PID ${process.pid}\\)`));
  release();
  release();
  acquireInstanceLock(file)();
});

test('a worker killed without cleanup leaves a recoverable lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-stale-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'store.json');
  const child = startChild(file);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  assert.match(String((await once(child.stdout, 'data'))[0]), /locked/);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal(JSON.parse(await readFile(`${file}.lock`, 'utf8')).pid, child.pid);
  const release = acquireInstanceLock(file);
  t.after(release);
  assert.equal(JSON.parse(await readFile(`${file}.lock`, 'utf8')).pid, process.pid);
});

for (const stale of [false, true]) test(`simultaneous startups ${stale ? 'recovering a dead worker' : 'with a fresh store'} leave exactly one owner`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-concurrent-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'store.json');
  if (stale) {
    const old = startChild(file);
    assert.match(String((await once(old.stdout, 'data'))[0]), /locked/);
    const exited = once(old, 'exit');
    old.kill('SIGKILL');
    await exited;
  }
  const children = Array.from({ length: 4 }, () => startChild(file));
  t.after(async () => {
    await Promise.all(children.map((child) => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.stdin.end();
      return exited;
    }));
  });
  const results = await Promise.all(children.map((child) => new Promise((resolve) => {
    child.stdout.once('data', () => resolve('owner'));
    child.once('exit', () => resolve('rejected'));
  })));
  assert.equal(results.filter((result) => result === 'owner').length, 1);
});

test('unverifiable locks fail safely without replacing their contents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-unknown-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'store.json');
  for (const content of ['', 'null', JSON.stringify({ pid: process.pid, host: `${hostname()}-other`, id: 'test' })]) {
    await writeFile(`${file}.lock`, content);
    assert.throws(() => acquireInstanceLock(file), /Cannot verify/);
    assert.equal(await readFile(`${file}.lock`, 'utf8'), content);
  }
});
