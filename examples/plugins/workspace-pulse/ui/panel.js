'use strict';
const $ = id => document.getElementById(id); let revision = 0, active;
function theme(value) { if (value) document.documentElement.dataset.theme = value.theme; }
IexaPlugin.subscribe((event, value) => { if (event === 'context.changed') theme(value); });
async function refresh() {
  if (active) return; active = new AbortController(); $('refresh').disabled = true; $('cancel').hidden = false; $('status').textContent = '正在读取工作区…';
  try {
    const result = await IexaPlugin.invoke('inspect', { limit: Number($('limit').value) }, { signal: active.signal });
    if (!result.success) throw new Error(result.output); const card = result.pluginUI.card;
    $('metrics').replaceChildren(); for (const field of card.fields) { const el = document.createElement('div'); el.className = 'metric'; const label = document.createElement('small'), value = document.createElement('strong'); label.textContent = field.label; value.textContent = field.value; el.append(label, value); $('metrics').append(el); }
    $('rows').replaceChildren(); for (const row of card.table.rows) { const tr = document.createElement('tr'); for (const cell of row) { const td = document.createElement('td'); td.textContent = cell; tr.append(td); } $('rows').append(tr); }
    $('status').textContent = '快照已更新';
  } catch (error) { $('status').textContent = error.message; }
  finally { active = undefined; $('refresh').disabled = false; $('cancel').hidden = true; }
}
$('refresh').addEventListener('click', refresh); $('cancel').addEventListener('click', () => active?.abort());
$('save').addEventListener('click', async () => {
  $('save').disabled = true;
  try { const state = await IexaPlugin.state.set({ limit: Number($('limit').value) }, revision); revision = state.revision; $('status').textContent = '偏好已保存，重开面板仍保留'; }
  catch (error) { $('status').textContent = error.message; try { revision = (await IexaPlugin.state.get()).revision; } catch {} }
  finally { $('save').disabled = false; }
});
IexaPlugin.ready.then(async context => {
  theme(context); const state = await IexaPlugin.state.get(); revision = state.revision;
  if (Number.isInteger(state.value?.limit) && state.value.limit >= 1 && state.value.limit <= 50) $('limit').value = state.value.limit;
  $('refresh').disabled = $('save').disabled = false; await refresh();
}).catch(error => { $('status').textContent = error.message; });
