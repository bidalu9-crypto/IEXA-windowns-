from pathlib import Path
root = Path(__file__).resolve().parents[1]
for name in ['AnthropicProvider.ts', 'GeminiProvider.ts', 'OpenAIProvider.ts']:
    p = root / 'src/main/providers' / name
    s = p.read_text(encoding='utf-8')
    s = s.replace("private thinkingLevel: 'off' | 'low' | 'medium' | 'high';", "private thinkingLevel: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';")
    p.write_text(s, encoding='utf-8')

# Keep the menu markup in sync with the seven-level catalog, replacing only its option area.
p = root / 'src/renderer/index.html'
s = p.read_text(encoding='utf-8')
start = s.index('                <div class="thinking-level-menu"')
end = s.index('                </div>', start) + len('                </div>')
menu = '''                <div class="thinking-level-menu" id="thinkingLevelMenu" role="listbox" style="display:none;">
                  <button type="button" class="thinking-level-option" data-level="off" role="option"><span class="thinking-level-option-title">关闭</span><span class="thinking-level-option-desc">不启用额外思考</span></button>
                  <button type="button" class="thinking-level-option" data-level="low" role="option"><span class="thinking-level-option-title">低</span><span class="thinking-level-option-desc">快速轻量推理</span></button>
                  <button type="button" class="thinking-level-option" data-level="medium" role="option"><span class="thinking-level-option-title">标准</span><span class="thinking-level-option-desc">平衡速度与深度</span></button>
                  <button type="button" class="thinking-level-option" data-level="high" role="option"><span class="thinking-level-option-title">高</span><span class="thinking-level-option-desc">更深入的长思考</span></button>
                  <button type="button" class="thinking-level-option" data-level="xhigh" role="option"><span class="thinking-level-option-title">超高</span><span class="thinking-level-option-desc">最大化推理深度</span></button>
                  <button type="button" class="thinking-level-option" data-level="max" role="option"><span class="thinking-level-option-title">最大</span><span class="thinking-level-option-desc">使用模型允许的最大思考</span></button>
                  <button type="button" class="thinking-level-option" data-level="ultra" role="option"><span class="thinking-level-option-title">Ultra</span><span class="thinking-level-option-desc">更强的深度推理模式</span></button>
                </div>'''
s = s[:start] + menu + s[end:]
p.write_text(s, encoding='utf-8')
print('fixed provider types and menu')
