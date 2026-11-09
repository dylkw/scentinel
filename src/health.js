export function redditHealth({ source, metrics, state, intervalMs, now = Date.now() }) {
  if (source === 'rss') return { ...metrics, source, ok: Boolean(metrics.lastSuccessAt && now - metrics.lastSuccessAt < intervalMs * 3) };
  const staleAfterMs = source === 'html' ? Math.max(intervalMs * 3, 300_000 + intervalMs) : intervalMs * 3;
  const readFresh = Boolean(state?.lastSuccessfulReadAt && now - state.lastSuccessfulReadAt < staleAfterMs);
  const discoveryFresh = Boolean(state?.lastDiscoveryAt && now - state.lastDiscoveryAt < staleAfterMs);
  return {
    ...metrics, source, ok: readFresh && discoveryFresh,
    queuedPosts: state?.queue.length || 0,
    lastDiscoveryAt: state?.lastDiscoveryAt || null,
    lastSuccessfulReadAt: state?.lastSuccessfulReadAt || null,
    discoveryFresh,
  };
}
