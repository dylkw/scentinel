import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';

// The store is single-writer: claim it before loading data or starting any polls.
export function acquireInstanceLock(storeFile) {
  const file = `${resolve(storeFile)}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const owner = { pid: process.pid, host: hostname(), id: crypto.randomUUID() };
  const recoveryFile = `${file}.recovery.lock`;
  let recoveryDescriptor;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      let descriptor;
      try {
        descriptor = openSync(file, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let existing;
        try { existing = JSON.parse(readFileSync(file, 'utf8')); }
        catch (readError) {
          if (readError.code === 'ENOENT') continue;
          throw new Error(`Cannot verify the Scentinel instance lock at ${file}. Check for a running worker before removing it.`);
        }
        if (!existing || existing.host !== owner.host || !Number.isInteger(existing.pid) || existing.pid <= 0 || typeof existing.id !== 'string') {
          throw new Error(`Cannot verify the Scentinel instance lock at ${file}. Check for a running worker before removing it.`);
        }
        try {
          process.kill(existing.pid, 0);
        } catch (probeError) {
          if (probeError.code === 'ESRCH') {
            // Serialize stale-file removal: two simultaneous restarts must not
            // remove the live lock created by one another.
            if (recoveryDescriptor === undefined) {
              try { recoveryDescriptor = openSync(recoveryFile, 'wx', 0o600); }
              catch (error) {
                if (error.code !== 'EEXIST') throw error;
                throw new Error(`Scentinel lock recovery is already in progress. If no worker is starting, check ${recoveryFile} before removing it.`);
              }
              writeFileSync(recoveryDescriptor, JSON.stringify(owner));
            }
            // Recheck ownership while holding the recovery claim.
            try {
              if (JSON.parse(readFileSync(file, 'utf8')).id === existing.id) unlinkSync(file);
            } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
            continue;
          }
          if (probeError.code !== 'EPERM') throw probeError;
        }
        throw new Error(`Scentinel is already running (PID ${existing.pid}). Stop that worker before starting another; only one worker may use this store and Telegram bot.`);
      }
      try { writeFileSync(descriptor, JSON.stringify(owner)); }
      catch (error) { unlinkSync(file); throw error; }
      finally { closeSync(descriptor); }
      let released = false;
      return () => {
        if (released) return;
        try {
          if (JSON.parse(readFileSync(file, 'utf8')).id === owner.id) unlinkSync(file);
          released = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    }
    throw new Error('The Scentinel instance lock changed during startup. Try again after stopping other workers.');
  } finally {
    if (recoveryDescriptor !== undefined) {
      closeSync(recoveryDescriptor);
      unlinkSync(recoveryFile);
    }
  }
}
