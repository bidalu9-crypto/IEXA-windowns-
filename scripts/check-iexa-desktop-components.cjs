'use strict';
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const { createHarness } = require('./helpers/desktop-component-harness.cjs');
(async () => {
  const baseline = process.argv.includes('--baseline');
  const group = process.argv.find(a=>a.startsWith('--group='))?.slice(8) || (baseline ? 'baseline' : 'navigation');
  const h = await createHarness({ output: process.env.IEXA_COMPONENT_OUTPUT || path.resolve(__dirname, '../.iexa-artifacts/desktop-components-20261109', group + (process.argv.includes('--source-controller') ? '-source-controller' : '-packaged') + '-' + Date.now()), source: process.argv.includes('--source'), denyMicrophone: group === 'media' || group === 'all', controllerRoot: process.argv.includes('--source-controller') ? path.resolve(__dirname, '..') : undefined });
  const only = process.argv.find(a => a.startsWith('--only=')); if (only) h.onlyChecks = only.slice(7).split('|');
  try {
    await Promise.race([h.start(), h.failure]);
    await h.inventory('chat');
    await h.check('Actual IEXA chat input and Send are controlled by DesktopAgent', async () => {
      await h.type('chatInput', 'COMPONENT_DESKTOP_SEND'); await h.click('sendBtn');
      await h.until(() => h.read("!isProcessing&&document.querySelector('.chat-messages').textContent.includes('COMPONENT_REPLY_OK')"), 'Real provider reply');
      assert.ok(h.report.providerRequests.some(r => r.prompt.includes('COMPONENT_DESKTOP_SEND'))); return { reply: 'COMPONENT_REPLY_OK', provider: 'local fixture' };
    });
    await h.check('DesktopAgent opens IEXA settings-and-extensions disclosure', async () => {
      await h.click({ name: '设置与拓展' }); assert.equal(await h.read("document.querySelector('#sidebarMore').open"), true); return { open: true };
    });
    if (!baseline) {
      if (group === 'navigation' || group === 'all') {
        for (const view of ['chat','bots','skills','scheduled','appearance','doc','pet','soul','token-calculator','mcp','plugins','settings','sync','about']) {
          await h.check('Desktop control navigates actual IEXA ' + view + ' page', async () => {
            await h.nav(view); const controls = await h.inventory(view); await h.screenshot('page-' + view); return { controls: controls.length, active: view };
          });
        }
      }
      if (['native','workbench','agent-features','overlays','crud','bots','window','all'].includes(group)) {
        await h.check('Actual IEXA native folder picker cancellation preserves current project', async () => {
          await h.nav('chat'); return h.chooseNativePath(() => h.clickSelector('#shellAddProject'), '', { cancel: true });
        });
        await h.check('Actual IEXA native folder picker opens the fixture project', async () => {
          const evidence = await h.chooseNativePath(() => h.clickSelector('#shellAddProject'), h.report.fixture.project);
          const canonical = fs.realpathSync.native(h.report.fixture.project);
          const actual = await h.until(async () => { const p = await h.read("fetch('/api/project').then(r=>r.json())"); return path.resolve(p.root || p.project?.root || '') === path.resolve(canonical) && p; }, 'Chosen exact project registered');
          const listed = await h.read("fetch('/api/fs/list?path=.').then(async r=>({status:r.status,data:await r.json()}))"); assert.equal(listed.status, 200);
          assert.ok(JSON.stringify(listed.data).includes('note.txt')); return { ...evidence, canonical, actual, listed: listed.status };
        });
      }
      if (group === 'workbench' || group === 'all') await require('./fixtures/iexa-component-workbench.cjs').runWorkbench(h);
      if (group === 'agent-features' || group === 'all') await require('./fixtures/iexa-component-agent-features.cjs').runAgentFeatures(h);
      if (group === 'desktop-live' || group === 'all') await require('./fixtures/iexa-component-desktop-live.cjs').runDesktopLive(h);
      if (group === 'overlays' || group === 'all') await require('./fixtures/iexa-component-overlays.cjs').runOverlays(h);
      if (group === 'crud' || group === 'all') await require('./fixtures/iexa-component-crud.cjs').runCrud(h);
      if (group === 'media' || group === 'all') await require('./fixtures/iexa-component-media.cjs').runMedia(h);
      if (group === 'bots' || group === 'all') await require('./fixtures/iexa-component-bots.cjs').runBots(h);
      if (group === 'window' || group === 'all') await require('./fixtures/iexa-component-window.cjs').runWindow(h);
      if (group === 'pages' || group === 'all') {
        const pages = require('./fixtures/iexa-component-pages.cjs');
        await pages.runPages(h);
        await h.check('Actual native picker installs the component plugin', async () => {
          const f = await pages.prepareFixtures(h); await h.nav('plugins');
          const receipt = await h.chooseNativePath(() => h.clickSelector('#pluginInstallBtn'), f.pluginSource);
          await h.until(() => h.read(`!!document.querySelector('.plugin-card[data-plugin-id="${f.pluginId}"]')`), 'Installed plugin card'); return receipt;
        });
        await pages.runPluginChecks(h);
      }
    }
    await h.screenshot('final-IEXA');
  } catch (e) { h.report.error = e.stack; h.save(); }
  finally { if (group === 'pages' || group === 'all') await require('./fixtures/iexa-component-pages.cjs').cleanupFixtures(h); const report = await h.finish(); console.log(JSON.stringify({ output: h.out, status: report.status, checks: report.checks.length, passed: report.checks.filter(c => c.passed).length })); if (report.status !== 'passed') process.exitCode = 1; }
})().catch(e => { console.error(e); process.exitCode = 1; });
