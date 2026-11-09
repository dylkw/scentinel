export function createTelegramApi(token, fetchImpl) {
  return async (method, body = {}, timeoutMs = 20_000) => {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, timeoutMs);
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`Telegram ${method}: invalid response (${response.status})`); }
    if (!response.ok || !data.ok) {
      const error = new Error(`Telegram ${method}: ${data.description || response.status}`);
      error.status = response.status;
      error.errorCode = data.error_code || response.status;
      error.retryAfterMs = Math.max(0, Number(data.parameters?.retry_after) || 0) * 1000;
      throw error;
    }
    return data.result;
  };
}

export class TelegramUpdateRetry {
  constructor() { this.backoffMs = 500; this.lastError = ''; }
  success(durationMs) {
    // Competing getUpdates calls can alternate failures with immediate empty
    // successes. Only a sustained successful poll proves the conflict is gone.
    if (durationMs >= 30_000) { this.backoffMs = 500; this.lastError = ''; }
  }
  failure(error) {
    const conflict = error.errorCode === 409 || error.status === 409;
    const delay = Math.max(this.backoffMs, conflict ? 30_000 : 500, error.retryAfterMs || 0);
    this.backoffMs = Math.min(delay * 2, 60_000);
    const log = error.message !== this.lastError;
    this.lastError = error.message;
    return { delay, log, conflict };
  }
}
