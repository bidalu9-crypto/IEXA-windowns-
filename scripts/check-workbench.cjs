/* Hidden Electron visual regression runner. No production API or user data.
   Use: electron scripts/check-workbench.cjs; screenshots go to the active artifact directory. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const renderer = path.join(root, 'src/renderer');
const out = fs.readFileSync(path.join(root, '.iexa-artifacts/active-workbench-upgrade.txt'), 'utf8').trim();
let window, server;
const diagnostics = [];
app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    let name = decodeURIComponent(u.pathname).replace(/^\//, '') || 'index.html';
    const baseline = name.startsWith('baseline/'); if (baseline) name = name.slice(9) || 'index.html';
    let file = path.resolve(renderer, name);
    if (!file.startsWith(renderer + path.sep)) { res.writeHead(403).end(); return; }
    if (baseline && ['index.html','styles.css'].includes(name)) file = path.join(out,'original/src/renderer',name);
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    const type = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png'}[path.extname(file)] || 'application/octet-stream';
    res.setHeader('Content-Type', type + (type.startsWith('text') ? '; charset=utf-8' : ''));
    if (name === 'index.html') {
      // Real markup/styles; disable production scripts so this test never calls tools or APIs.
      let html = fs.readFileSync(file,'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
      html = html.replace('<head>', '<head><base href="/">');
      if (baseline) html = html.replace('href="styles.css"', 'href="/baseline/styles.css"');
      res.end(html);
    } else res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  window = new BrowserWindow({ width:1440,height:960,show:false, useContentSize:true, webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false} });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cases = [['before',1440,960,'light',true],['light',1440,960,'light'],['dark',1440,960,'dark'],['narrow',1024,768,'light'],['mobile',390,844,'light']];
  for (const [name,width,height,theme,baseline] of cases) {
    window.setContentSize(width,height);
    await window.loadURL(origin + (baseline ? '/baseline/index.html' : '/index.html'));
    await window.webContents.executeJavaScript(`
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      document.getElementById('modelSelectorLabel').textContent = '已配置模型';
      document.getElementById('sessionsList').innerHTML = '<div class="session-item active"><div class="session-item-info"><span class="session-item-title">构建项目工作台</span><span class="session-item-time">刚刚</span></div></div><div class="session-item"><div class="session-item-info"><span class="session-item-title">检查测试与代码质量</span><span class="session-item-time">10 分钟前</span></div></div>';
      document.getElementById('filesPanelTitle').textContent='IEXA-WIN';
      document.getElementById('filesList').innerHTML='<div class="files-item"><span class="files-item-icon">▸</span><span class="files-item-name">src</span></div><div class="files-item"><span class="files-item-icon">▸</span><span class="files-item-name">tests</span></div><div class="files-item"><span class="files-item-icon">▸</span><span class="files-item-name">docs</span></div><div class="files-item"><span class="files-item-name">package.json</span></div><div class="files-item"><span class="files-item-name">AGENTS.md</span></div>';
    `);
    if (!baseline) await window.webContents.executeJavaScript(fs.readFileSync(path.join(renderer,'services/WorkbenchShell.js'),'utf8'));
    await new Promise(resolve => setTimeout(resolve,300));
    const measurements = await window.webContents.executeJavaScript(`(() => {
      const rect = id => {const r = document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
      const b=rect('sendBtn'), r=document.querySelector('#sendBtn .send-icon').getBoundingClientRect();
      return {viewport:[innerWidth,innerHeight],scrollWidth:document.documentElement.scrollWidth,button:b,icon:{x:r.x,y:r.y,w:r.width,h:r.height}, input:rect('chatInput'),theme:getComputedStyle(document.body).backgroundColor};
    })()`);
    diagnostics.push({name,...measurements});
    if (!baseline) {
      assert.ok(measurements.scrollWidth <= width, `${name}: horizontal overflow`);
      const b=measurements.button, i=measurements.icon;
      assert.ok(i.x >= b.x && i.y >= b.y && i.x+i.w <= b.right && i.y+i.h <= b.bottom, `${name}: send icon clipped`);
      assert.ok(b.bottom <= height, `${name}: composer off screen`);
      assert.ok(measurements.input.w >= 70, `${name}: input collapsed`);
      // Simulate real mouse hover, verify transform still includes absolute centering.
      window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(b.x+b.w/2),y:Math.round(b.y+b.h/2)});
      await new Promise(resolve => setTimeout(resolve,180));
      const transform=await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('#sendBtn .send-icon')).transform");
      assert.equal(transform,'matrix(1, 0, 0, 1, -10.44, -9)', `${name}: hover changed centering`);
    }
    fs.writeFileSync(path.join(out,`workbench-${name}.png`),(await window.webContents.capturePage()).toPNG());
    if (!baseline) {
      const menuVisible = await window.webContents.executeJavaScript(`(() => {
        const menu=document.getElementById('modelSelectorMenu');
        menu.innerHTML='<button class="model-selector-option">测试模型选项</button>'; menu.style.display='flex';
        const r=menu.getBoundingClientRect();
        return r.top >= 0 && r.right <= innerWidth && menu.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
      })()`);
      assert.ok(menuVisible, `${name}: model menu clipped`);
      await window.webContents.executeJavaScript("document.getElementById('modelSelectorMenu').style.display='none'");
    }
    if (name === 'light') {
      await window.webContents.executeJavaScript(`
        document.getElementById('sidebarMore').open=true;
        document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view==='settings'));
        document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id==='view-settings'));
      `);
      await new Promise(r=>setTimeout(r,200));
      fs.writeFileSync(path.join(out,'workbench-settings.png'),(await window.webContents.capturePage()).toPNG());
    }

  }
  fs.writeFileSync(path.join(out,'visual-checks.json'),JSON.stringify(diagnostics,null,2));
  console.log('PASS: five viewports/themes captured; overflow, input width, send containment, hover alignment and model menu visibility verified; settings captured.');
  console.log(out);
}).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{window?.destroy();server?.close();app.exit(process.exitCode||0);});
