"""
Patch server.ts:
1. Add contextWindow to ModelProfile interface
2. Fetch context_window from /v1/models API and return it
3. Accept contextWindow when saving profile
4. Chat handler uses profile.contextWindow as override
"""
import os

server_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\server.ts'

with open(server_ts, 'r', encoding='utf-8') as f:
    content = f.read()

print(f'Original size: {len(content)}')

# --- Patch 1: ModelProfile interface ---
old1 = 'interface ModelProfile {\n  id: string;\n  name: string;\n  provider: string;\n  model: string;\n  apiKey: string;\n  baseURL?: string;\n}'
new1 = 'interface ModelProfile {\n  id: string;\n  name: string;\n  provider: string;\n  model: string;\n  apiKey: string;\n  baseURL?: string;\n  /** API-reported context window from /v1/models. */\n  contextWindow?: number;\n  /** API-reported max output tokens. */\n  maxOutputTokens?: number;\n}'
if old1 in content:
    content = content.replace(old1, new1, 1)
    print('OK: ModelProfile interface')
else:
    print('FAIL: ModelProfile interface not found')

# --- Patch 2: fetch-models endpoint - extract context_window ---
old2_start = "    if (url.pathname === '/api/profiles/fetch-models'"
old2_end = "      return;\n    }\n\n    // =====================================================================\n    // Profiles API (CRUD)"

idx = content.find(old2_start)
if idx < 0:
    print('FAIL: fetch-models start not found')
else:
    # Find the end marker
    end_idx = content.find(old2_end, idx)
    if end_idx < 0:
        print('FAIL: fetch-models end not found')
    else:
        # The end marker includes the closing of the fetch-models block and start of profiles block
        # We want to replace from old2_start to just before the Profiles API comment
        profiles_comment = "    // =====================================================================\n    // Profiles API (CRUD)"
        profiles_idx = content.find(profiles_comment, idx)
        if profiles_idx < 0:
            print('FAIL: profiles comment not found')
        else:
            # Find the "return;" before profiles comment
            return_idx = content.rfind('      return;', idx, profiles_idx)
            if return_idx < 0:
                print('FAIL: return statement not found')
            else:
                # End of fetch-models block is after "      return;" + newline + "    }"
                block_end = content.find('\n    }', return_idx)
                if block_end < 0:
                    print('FAIL: block end not found')
                else:
                    block_end += len('\n    }')
                    old2 = content[idx:block_end]
                    new2 = """    if (url.pathname === '/api/profiles/fetch-models' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { baseURL, apiKey } = JSON.parse(body);
        if (!baseURL || !apiKey) {
          jsonReply(res, 400, { error: '请输入接口地址和 API 密钥。' });
          return;
        }
        let modelsUrl = baseURL.replace(/\\/+$/, '');
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
              // Extract id + context_window + max_completion_tokens from API response.
              const rawItems = Array.isArray(parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
              const models: Array<{ id: string; contextWindow?: number; maxOutputTokens?: number }> = [];
              for (const item of rawItems) {
                if (!item?.id) continue;
                const ctx = typeof item.context_window === 'number' && item.context_window > 0 ? item.context_window : undefined;
                const maxOut = typeof item.max_completion_tokens === 'number' && item.max_completion_tokens > 0 ? item.max_completion_tokens : undefined;
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
    }"""
                    content = content[:idx] + new2 + content[block_end:]
                    print('OK: fetch-models endpoint')

# --- Patch 3: Profile POST handler - accept contextWindow ---
old3 = """          const profile: ModelProfile = JSON.parse(body);
          if (!profile.id) profile.id = 'p_' + Date.now();
          if (!profile.name) profile.name = profile.model || '未命名';
          const s = loadSettings();"""
new3 = """          const profile: ModelProfile = JSON.parse(body);
          if (!profile.id) profile.id = 'p_' + Date.now();
          if (!profile.name) profile.name = profile.model || '未命名';
          if (profile.contextWindow != null) {
            const cw = Number(profile.contextWindow);
            profile.contextWindow = Number.isFinite(cw) && cw > 0 ? Math.floor(cw) : undefined;
          }
          if (profile.maxOutputTokens != null) {
            const mo = Number(profile.maxOutputTokens);
            profile.maxOutputTokens = Number.isFinite(mo) && mo > 0 ? Math.floor(mo) : undefined;
          }
          const s = loadSettings();"""
if old3 in content:
    content = content.replace(old3, new3, 1)
    print('OK: Profile POST handler')
else:
    print('FAIL: Profile POST handler not found')

# --- Patch 4: Chat handler - use profile.contextWindow ---
old4 = """        const contextWindow = contextWindowForModel(profile.model, profile.provider);"""
new4 = """        const contextWindow = profile.contextWindow != null
          ? profile.contextWindow
          : contextWindowForModel(profile.model, profile.provider);"""
count = content.count(old4)
print(f'contextWindowForModel line occurrences: {count}')
if count >= 1:
    content = content.replace(old4, new4, 1)
    print('OK: Chat handler contextWindow')

with open(server_ts, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'New size: {len(content)}')
print('Done')