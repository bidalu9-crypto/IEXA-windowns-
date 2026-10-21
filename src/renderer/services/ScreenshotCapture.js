// =============================================================================
// Screenshot capture and annotation
//
// Click the camera → the browser asks which surface to share → the frozen frame
// opens in a full-screen canvas. Drag to select a region, then annotate it with
// a rectangle, an arrow or a freehand pen in one of six colours. Confirm crops
// the selection, bakes the annotations into a PNG and drops it into the composer
// as a normal image attachment.
//
// Classic script: exposes window.IexaScreenshot and runs nothing at load time.
// =============================================================================
(() => {
  'use strict';

  const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#f8fafc'];
  const STROKE = 3;
  const MIN_SELECTION = 12;

  let session = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Draw one arrow from a to b with a solid head that scales with its length. */
  function drawArrow(ctx, from, to) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const head = Math.max(8, Math.min(18, length * 0.34));
    const shaftEnd = {
      x: to.x - Math.cos(angle) * head * 0.72,
      y: to.y - Math.sin(angle) * head * 0.72,
    };
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(shaftEnd.x, shaftEnd.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - Math.cos(angle - 0.42) * head, to.y - Math.sin(angle - 0.42) * head);
    ctx.lineTo(to.x - Math.cos(angle + 0.42) * head, to.y - Math.sin(angle + 0.42) * head);
    ctx.closePath();
    ctx.fill();
  }

  function drawOps(ctx, ops) {
    for (const op of ops) {
      ctx.strokeStyle = op.color;
      ctx.fillStyle = op.color;
      ctx.lineWidth = STROKE;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (op.type === 'rect') {
        ctx.strokeRect(op.x, op.y, op.w, op.h);
      } else if (op.type === 'arrow') {
        drawArrow(ctx, op.from, op.to);
      } else if (op.type === 'pen' && op.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(op.points[0].x, op.points[0].y);
        for (let i = 1; i < op.points.length; i++) ctx.lineTo(op.points[i].x, op.points[i].y);
        ctx.stroke();
      }
    }
  }

  /** Keep the captured frame centred and fully visible without distortion. */
  function fitInside(imageWidth, imageHeight, viewWidth, viewHeight) {
    const scale = Math.min(viewWidth / imageWidth, viewHeight / imageHeight);
    const w = imageWidth * scale;
    const h = imageHeight * scale;
    return { x: (viewWidth - w) / 2, y: (viewHeight - h) / 2, w, h, scale };
  }

  function buildToolbar(state) {
    const bar = el('div', 'shot-toolbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '截图工具');

    const tools = el('div', 'shot-tools');
    const toolDefs = [
      ['select', '框选', 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16'],
      ['rect', '矩形', 'M4.5 6.5h15v11h-15z'],
      ['arrow', '箭头', 'M5 19 19 5M12.5 5H19v6.5'],
      ['pen', '画笔', 'M4 20l3.6-.9L19 7.7a1.9 1.9 0 0 0-2.7-2.7L4.9 16.4Z'],
    ];
    for (const [id, label, path] of toolDefs) {
      const button = el('button', 'shot-tool');
      button.type = 'button';
      button.dataset.tool = id;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(state.tool === id));
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
      button.addEventListener('click', () => {
        state.tool = id;
        bar.querySelectorAll('.shot-tool').forEach((node) => {
          node.setAttribute('aria-pressed', String(node.dataset.tool === id));
        });
      });
      tools.appendChild(button);
    }

    const colors = el('div', 'shot-colors');
    for (const color of COLORS) {
      const dot = el('button', 'shot-color');
      dot.type = 'button';
      dot.dataset.color = color;
      dot.style.setProperty('--shot-color', color);
      dot.title = color;
      dot.setAttribute('aria-label', `颜色 ${color}`);
      dot.setAttribute('aria-pressed', String(state.color === color));
      dot.addEventListener('click', () => {
        state.color = color;
        colors.querySelectorAll('.shot-color').forEach((node) => {
          node.setAttribute('aria-pressed', String(node.dataset.color === color));
        });
      });
      colors.appendChild(dot);
    }

    const actions = el('div', 'shot-actions');
    const undo = el('button', 'shot-action', '撤销');
    undo.type = 'button';
    undo.disabled = true;
    undo.addEventListener('click', () => state.onUndo());
    const reset = el('button', 'shot-action', '重选');
    reset.type = 'button';
    reset.addEventListener('click', () => state.onReset());
    const cancel = el('button', 'shot-action', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => state.onCancel());
    const confirmButton = el('button', 'shot-action shot-primary', '完成');
    confirmButton.type = 'button';
    confirmButton.addEventListener('click', () => state.onConfirm());
    actions.append(undo, reset, cancel, confirmButton);

    bar.append(tools, colors, actions);
    bar.undoButton = undo;
    return bar;
  }

  function close() {
    if (!session) return;
    const current = session;
    session = null;
    current.root.remove();
    document.removeEventListener('keydown', current.onKey, true);
    if (document.fullscreenElement === current.root) document.exitFullscreen?.().catch(() => {});
  }

  function mountOverlay(image) {
    const root = el('div', 'shot-overlay');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '截图标注');
    const canvas = document.createElement('canvas');
    canvas.className = 'shot-canvas';
    // One static line: a pill whose text changes and resizes can leave a stale
    // raster behind on some compositors, and the instructions never differ.
    const hint = el('div', 'shot-hint', '拖拽框选 · 选后可标注 · Enter 完成 · Esc 取消');
    const bar = el('div', 'shot-bar');
    root.append(canvas, hint, bar);
    document.body.appendChild(root);

    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let viewWidth = 0;
    let viewHeight = 0;
    let fit = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
    let selection = null;
    let draft = null;
    let ops = [];
    let tool = 'select';
    let color = COLORS[0];
    let dragging = null;

    const state = {
      get tool() { return tool; },
      set tool(value) { tool = value; },
      get color() { return color; },
      set color(value) { color = value; },
      onUndo: () => { ops.pop(); syncBar(); redraw(); },
      onReset: () => { ops = []; selection = null; draft = null; syncBar(); redraw(); },
      onCancel: () => close(),
      onConfirm: () => commitCapture(),
    };

    const toolbar = buildToolbar(state);
    bar.appendChild(toolbar);

    function syncBar() {
      toolbar.undoButton.disabled = ops.length === 0;
      root.classList.toggle('has-selection', !!selection);
    }

    function redraw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewWidth, viewHeight);
      ctx.drawImage(image, fit.x, fit.y, fit.w, fit.h);
      const box = selection || draft;
      if (box) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, viewWidth, viewHeight);
        ctx.rect(box.x, box.y, box.w, box.h);
        ctx.fillStyle = 'rgba(8, 10, 14, 0.58)';
        ctx.fill('evenodd');
        ctx.restore();
        if (selection) drawOps(ctx, ops);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
        ctx.restore();
      }
    }

    function resize() {
      viewWidth = window.innerWidth;
      viewHeight = window.innerHeight;
      canvas.width = Math.round(viewWidth * dpr);
      canvas.height = Math.round(viewHeight * dpr);
      canvas.style.width = viewWidth + 'px';
      canvas.style.height = viewHeight + 'px';
      fit = fitInside(image.width, image.height, viewWidth, viewHeight);
      redraw();
    }

    function point(event) {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function clampToImage(p) {
      return {
        x: Math.min(fit.x + fit.w, Math.max(fit.x, p.x)),
        y: Math.min(fit.y + fit.h, Math.max(fit.y, p.y)),
      };
    }

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const p = clampToImage(point(event));
      try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
      if (!selection) {
        dragging = { mode: 'select', start: p };
        draft = { x: p.x, y: p.y, w: 0, h: 0 };
        redraw();
        return;
      }
      if (tool === 'select') {
        dragging = { mode: 'select', start: p };
        draft = { x: p.x, y: p.y, w: 0, h: 0 };
        redraw();
        return;
      }
      if (tool === 'rect') {
        dragging = { mode: 'rect', op: { type: 'rect', x: p.x, y: p.y, w: 0, h: 0, color } };
      } else if (tool === 'arrow') {
        dragging = { mode: 'arrow', op: { type: 'arrow', from: p, to: p, color } };
      } else {
        dragging = { mode: 'pen', op: { type: 'pen', points: [p], color } };
      }
      redraw();
      drawOps(ctx, [dragging.op]);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const p = clampToImage(point(event));
      if (dragging.mode === 'select') {
        draft = {
          x: Math.min(dragging.start.x, p.x),
          y: Math.min(dragging.start.y, p.y),
          w: Math.abs(p.x - dragging.start.x),
          h: Math.abs(p.y - dragging.start.y),
        };
        redraw();
        return;
      }
      const op = dragging.op;
      if (op.type === 'rect') {
        op.x = Math.min(op.x, p.x);
        op.y = Math.min(op.y, p.y);
        op.w = Math.abs(p.x - op.x);
        op.h = Math.abs(p.y - op.y);
      } else if (op.type === 'arrow') {
        op.to = p;
      } else if (op.type === 'pen') {
        op.points.push(p);
      }
      redraw();
      drawOps(ctx, ops.concat([op]));
    });

    function finishDrag() {
      if (!dragging) return;
      const finished = dragging;
      dragging = null;
      if (finished.mode === 'select') {
        if (draft && draft.w >= MIN_SELECTION && draft.h >= MIN_SELECTION) {
          selection = draft;
        }
        draft = null;
        syncBar();
        redraw();
        return;
      }
      ops.push(finished.op);
      syncBar();
      redraw();
    }

    canvas.addEventListener('pointerup', finishDrag);
    canvas.addEventListener('pointercancel', finishDrag);

    function commitCapture() {
      if (!selection) return;
      const scale = fit.scale;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(selection.w / scale));
      out.height = Math.max(1, Math.round(selection.h / scale));
      const octx = out.getContext('2d');
      octx.drawImage(
        image,
        (selection.x - fit.x) / scale, (selection.y - fit.y) / scale,
        selection.w / scale, selection.h / scale,
        0, 0, out.width, out.height,
      );
      octx.save();
      octx.scale(1 / scale, 1 / scale);
      octx.translate(-selection.x, -selection.y);
      drawOps(octx, ops);
      octx.restore();
      out.toBlob((blob) => {
        if (!blob) { close(); return; }
        const stamp = new Date();
        const name = `截图 ${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}.png`;
        const file = new File([blob], name, { type: 'image/png' });
        close();
        if (typeof window.addFiles === 'function') window.addFiles([file]);
        else if (typeof addFiles === 'function') addFiles([file]);
      }, 'image/png');
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Enter' && selection) {
        event.preventDefault();
        event.stopPropagation();
        commitCapture();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.stopPropagation();
        ops.pop();
        syncBar();
        redraw();
      }
    }

    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', resize);
    session = { root, onKey, cleanup: () => window.removeEventListener('resize', resize) };

    resize();
    syncBar();
    requestAnimationFrame(() => root.classList.add('is-ready'));
  }

  async function start() {
    if (session) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      if (typeof addError === 'function') addError('当前环境不支持截图，请使用桌面版或新版浏览器。');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
    } catch (error) {
      // Dismissing the picker is a normal outcome, not an error to report.
      if (error && error.name === 'NotAllowedError') return;
      if (typeof addError === 'function') addError(`无法开始截图：${error?.message || error}`);
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      // A capture stream only emits a frame when the shared surface changes, so
      // play() can stay pending on a static screen. Never block the capture on
      // it: race the handshake and fall back to whatever frame is available.
      await Promise.race([
        video.play().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 900)),
      ]);
      if (!video.videoWidth) {
        await new Promise((resolve) => {
          const done = () => resolve();
          video.addEventListener('loadeddata', done, { once: true });
          video.addEventListener('canplay', done, { once: true });
          setTimeout(done, 900);
        });
      }
      if (!video.videoWidth) throw new Error('没有拿到画面，请重试');
      const frame = document.createElement('canvas');
      frame.width = video.videoWidth;
      frame.height = video.videoHeight;
      frame.getContext('2d').drawImage(video, 0, 0);
      const bitmap = await createImageBitmap(frame);
      mountOverlay(bitmap);
    } catch (error) {
      if (typeof addError === 'function') addError(`截图失败：${error?.message || error}`);
    } finally {
      for (const track of stream.getTracks()) track.stop();
    }
  }

  window.IexaScreenshot = Object.freeze({ start, close: () => close() });
})();
