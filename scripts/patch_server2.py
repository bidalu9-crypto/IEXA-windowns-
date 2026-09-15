import re
import os

base = r'C:\Users\Administrator\Desktop\iEXA-WIN'
server_ts = os.path.join(base, 'src', 'main', 'server.ts')

with open(server_ts, 'r', encoding='utf-8') as f:
    content = f.read()

# Use normalize to handle mixed line endings
def detect_eol(text):
    if '\r\n' in text:
        return '\r\n'
    return '\n'

eol = detect_eol(content)
print(f'Detected EOL: {repr(eol)}')

# ---- Patch 1: fetch-models endpoint ----
# Replace the old fetch-models logic to extract context_window from API response
old_fetch_models = '''    if (url.pathname === '/api/profiles/fetch-models' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { baseURL, apiKey } = JSON.parse(body);
        if (!baseURL || !apiKey) {
          jsonReply(res, 400, { error: '请输入接口地址和 API 密钥。' });
          return;
        }
        let modelsUrl = baseURL.replace(/\/+$/, '');
        if (!modelsUrl.includes('/v1')) {
          modelsUrl = modelsUrl + '/v1';
        }
        modelsUrl += '/models';
        const endpoint = new URL(modelsUrl);
        const requestModule = endpoint.protocol === 'https:' ? https : http;
        requestModule.get(endpoint, {
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
          timeout: 20000,
        }, (r: http.IncomingMessage) => {
          let data = '';
          r.on('data', (c: Buffer) => data += c);
          r.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              let list: string[] = [];
              if (Array.isArray(parsed.data)) {
                list = parsed.data.map((m: any) => m.id).filter(Boolean);
              } else if (Array.isArray(parsed)) {
                list = parsed.map((m: any) => m.id).filter(Boolean);
              }
              if (list.length === 0) {
                jsonReply(res, 404, { error: '未找到可用模型。' });
                return;
              }
              jsonReply(res, 200, { models: list });
            } catch { jsonReply(res, 500, { error: '无法解析模型列表。' }); }
          });
        }).on('error', (e: Error) => jsonReply(res, 500, { error: `请求失败：${e.message}` }));
      } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
      return;
    }'''

new_fetch_models = '''    if (url.pathname === '/api/profiles/fetch-models' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { baseURL, apiKey } = JSON.parse(body);
        if (!baseURL || !apiKey) {
          jsonReply(res, 400, { error: '请输入接口地址和 API 密钥。' });
          return;
        }
        let modelsUrl = baseURL.replace(/\/+$/, '');
        if (!modelsUrl.includes('/v1')) {
          modelsUrl = modelsUrl + '/v1';
        }
        modelsUrl += '/models';
        const endpoint = new URL(modelsUrl);
        const requestModule = endpoint.protocol === 'https:' ? https : http;
        requestModule.get(endpoint, {
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
          timeout: 20000,
        }, (r: http.IncomingMessage) => {
          let data = '';
          r.on('data', (c: Buffer) => data += c);
          r.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              // Extract model id + context_window from the API response.
              // OpenAI-compatible endpoints return data: [{ id, context_window, max_completion_tokens, ... }]
              let models: Array<{ id: string; contextWindow?: number; maxOutputTokens?: number }> = [];
              const rawItems = Array.isArray(parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
              for (const item of rawItems) {
                if (!item?.id) continue;
                const ctx = typeof item.context_window === 'number' && item.context_window > 0
                  ? item.context_window : undefined;
                const maxOut = typeof item.max_completion_tokens === 'number' && item.max_completion_tokens > 0
                  ? item.max_completion_tokens : undefined;
                models.push({ id: item.id, contextWindow: ctx, maxOutputTokens: maxOut });
              }
              if (models.length === 0) {
                jsonReply(res, 404, { error: '未找到可用模型。' });
                return;
              }
              jsonReply(res, 200, { models });
            } catch { jsonReply(res, 500, { error: '无法解析模型列表。' }); }
          });
        }).on('error', (e: Error) => jsonReply(res, 500, { error: `请求失败：${e.message}` }));
      } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
      return;
    }'''

count = content.count(old_fetch_models)
print(f'old_fetch_models occurrences: {count}')
if count > 0:
    content = content.replace(old_fetch_models, new_fetch_models, 1)
    print('Patched fetch-models endpoint')
else:
    print('WARNING: old_fetch_models not found, trying fuzzy match')
    # Try with CRLF
    count2 = content.count(old_fetch_models.replace('\n', '\r\n'))
    print(f'CRLF occurrences: {count2}')
    if count2 > 0:
        content = content.replace(old_fetch_models.replace('\n', '\r\n'), new_fetch_models.replace('\n', '\r\n'), 1)
        print('Patched fetch-models (CRLF)')

# ---- Patch 2: Profile save (POST) - accept contextWindow ----
# Add contextWindow validation/cleanup when saving profile
old_profile_post = '''          const profile: ModelProfile = JSON.parse(body);
          if (!profile.id) profile.id = 'p_' + Date.now();
          if (!profile.name) profile.name = profile.model || '未命名';
          const s = loadSettings();'''

new_profile_post = '''          const profile: ModelProfile = JSON.parse(body);
          if (!profile.id) profile.id = 'p_' + Date.now();
          if (!profile.name) profile.name = profile.model || '未命名';
          // Accept contextWindow from the model list fetch; clamp to positive integer
          if (profile.contextWindow != null) {
            const cw = Number(profile.contextWindow);
            profile.contextWindow = Number.isFinite(cw) && cw > 0 ? Math.floor(cw) : undefined;
          }
          if (profile.maxOutputTokens != null) {
            const mo = Number(profile.maxOutputTokens);
            profile.maxOutputTokens = Number.isFinite(mo) && mo > 0 ? Math.floor(mo) : undefined;
          }
          const s = loadSettings();'''

# We'll add maxOutputTokens to the interface too
old_profile2 = 'interface ModelProfile {\n  id: string;\n  name: string;\n  provider: string;\n  model: string;\n  apiKey: string;\n  baseURL?: string;\n  /** API-reported context window from /v1/models (if available). */\n  contextWindow?: number;\n}'
new_profile2 = 'interface ModelProfile {\n  id: string;\n  name: string;\n  provider: string;\n  model: string;\n  apiKey: string;\n  baseURL?: string;\n  /** API-reported context window from /v1/models (if available). */\n  contextWindow?: number;\n  /** API-reported max output tokens from /v1/models (if available). */\n  maxOutputTokens?: number;\n}'
count3 = content.count(old_profile2)
print(f'old_profile2 occurrences: {count3}')
if count3 > 0:
    content = content.replace(old_profile2, new_profile2, 1)
    print('Updated ModelProfile with maxOutputTokens')

count4 = content.count(old_profile_post)
print(f'old_profile_post occurrences: {count4}')
if count4 > 0:
    content = content.replace(old_profile_post, new_profile_post, 1)
    print('Patched profile POST handler')

with open(server_ts, 'w', encoding='utf-8') as f:
    f.write(content)

print('All patches applied')