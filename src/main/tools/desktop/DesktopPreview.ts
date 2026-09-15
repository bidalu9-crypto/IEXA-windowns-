/** Passive desktop previews never cause a new target-window capture. */
export async function readDesktopPreview(endpoint: string, signal?: AbortSignal): Promise<Response> {
  const healthResponse = await fetch(`${endpoint}/health`, { signal });
  if (!healthResponse.ok) throw new Error('Desktop health unavailable');
  const health = await healthResponse.json() as { product?: string; paused?: boolean; cachedPreview?: boolean };
  const fail = (status: number, error: string, extra = {}) => new Response(JSON.stringify({ error, ...extra }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (health.product !== 'IEXA Desktop Agent') return fail(409, '预览服务身份不匹配；未请求截图。');
  if (health.paused) return fail(423, '桌面操作与画面采集已暂停。', { paused: true });
  // Capability check matters: legacy helpers silently ignore cached=1.
  if (health.cachedPreview !== true) return fail(409, '桌面执行器需更新后才能使用快照预览；未触发新的截图。');
  const response = await fetch(`${endpoint}/frame?full=0&cached=1&format=jpeg&width=960`, { signal });
  if (response.ok && response.headers.get('x-iexa-frame-mode') !== 'cached-observation') {
    await response.body?.cancel();
    return fail(409, '执行器未返回已缓存的观察画面；未尝试其他截图方式。');
  }
  return response;
}
