// =============================================================================
// IEXA - Desktop pet page
//
// Upload an image, cut the subject out with u2netp (onnxruntime-web, fully
// local), then hand the PNG to the server and let the Electron host show it.
// The page owns no window: it only writes the sprite and the behaviour config.
// =============================================================================
const petView = {
  snapshot: null,
  busy: false,
  session: null,
  sessionPromise: null,
  ortPromise: null,
};

const PET_INPUT_SIZE = 320;
const PET_ALPHA_CUTOFF = 0.45;

function petEl(id) { return document.getElementById(id); }

async function loadPetSnapshot() {
  const response = await fetch(API_BASE + '/api/pet');
  if (!response.ok) throw new Error('无法读取桌宠状态');
  petView.snapshot = await response.json();
  return petView.snapshot;
}

// ---- segmentation ---------------------------------------------------------

/** Load the ESM build once. A plain <script> cannot resolve its .mjs imports. */
function ensureOrtRuntime() {
  if (window.ort) return Promise.resolve(window.ort);
  if (petView.ortPromise) return petView.ortPromise;
  petView.ortPromise = (async () => {
    const module = await import(new URL('vendor/ort.wasm.min.mjs', location.href).href);
    const ort = module.default || module;
    // The glue module and the wasm binary sit next to this file; without an
    // explicit path the runtime looks for them on a CDN and fails offline.
    ort.env.wasm.wasmPaths = new URL('vendor/', location.href).href;
    ort.env.wasm.numThreads = 1;
    window.ort = ort;
    return ort;
  })().catch((error) => { petView.ortPromise = null; throw error; });
  return petView.ortPromise;
}

async function ensurePetSession() {
  if (petView.session) return petView.session;
  if (petView.sessionPromise) return petView.sessionPromise;
  petView.sessionPromise = (async () => {
    const ort = await ensureOrtRuntime();
    const response = await fetch(API_BASE + '/api/pet/model');
    if (!response.ok) throw new Error('缺少抠图模型，请重新安装');
    const model = await response.arrayBuffer();
    petView.session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    return petView.session;
  })().catch((error) => { petView.sessionPromise = null; throw error; });
  return petView.sessionPromise;
}

/** Does this image already carry a real alpha channel? */
function hasAlphaChannel(bitmap) {
  const canvas = document.createElement('canvas');
  const size = 64;
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 200) transparent++;
  return transparent > size * size * 0.08;
}

async function segmentImage(bitmap) {
  const ort = await ensureOrtRuntime();
  const session = await ensurePetSession();
  const size = PET_INPUT_SIZE;

  // Preprocess: cover-fit into a square, NCHW, ImageNet normalisation.
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const drawW = bitmap.width * scale;
  const drawH = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - drawW) / 2, (size - drawH) / 2, drawW, drawH);
  const { data } = ctx.getImageData(0, 0, size, size);

  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * size * size);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) input[c * size * size + i] = (data[i * 4 + c] / 255 - mean[c]) / std[c];
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
  const results = await session.run({ [session.inputNames[0]]: tensor });
  const mask = results[session.outputNames[0]].data;

  // The mask arrives at 320×320; scale it to the source and use it as alpha.
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = size; maskCanvas.height = size;
  const maskCtx = maskCanvas.getContext('2d');
  const maskImage = maskCtx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const value = Math.max(0, Math.min(1, mask[i] || 0));
    maskImage.data[i * 4] = 255;
    maskImage.data[i * 4 + 1] = 255;
    maskImage.data[i * 4 + 2] = 255;
    maskImage.data[i * 4 + 3] = Math.round(value * 255);
  }
  maskCtx.putImageData(maskImage, 0, 0);

  const out = document.createElement('canvas');
  out.width = bitmap.width;
  out.height = bitmap.height;
  const outCtx = out.getContext('2d');
  outCtx.drawImage(bitmap, 0, 0);
  const full = outCtx.getImageData(0, 0, out.width, out.height);

  const scaledMask = document.createElement('canvas');
  scaledMask.width = out.width;
  scaledMask.height = out.height;
  const scaledCtx = scaledMask.getContext('2d');
  // The model saw a cover-fit square; map it back to the same box.
  const offsetX = (size - drawW) / 2;
  const offsetY = (size - drawH) / 2;
  scaledCtx.drawImage(maskCanvas, offsetX, offsetY, drawW, drawH, 0, 0, out.width, out.height);
  const alpha = scaledCtx.getImageData(0, 0, out.width, out.height).data;

  for (let i = 0; i < full.data.length; i += 4) full.data[i + 3] = alpha[i + 3];
  outCtx.putImageData(full, 0, 0);

  // Feather the cut: a hard mask edge reads as a sticker, a soft one as a sprite.
  const feathered = document.createElement('canvas');
  feathered.width = out.width;
  feathered.height = out.height;
  const featherCtx = feathered.getContext('2d');
  featherCtx.filter = 'blur(0.6px)';
  featherCtx.drawImage(out, 0, 0);
  featherCtx.filter = 'none';

  return cropToContent(feathered);
}

/** Trim fully transparent margins so the window hugs the character. */
function cropToContent(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > PET_ALPHA_CUTOFF * 255) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return canvas;
  const pad = 4;
  const cropX = Math.max(0, minX - pad);
  const cropY = Math.max(0, minY - pad);
  const cropW = Math.min(width, maxX + pad + 1) - cropX;
  const cropH = Math.min(height, maxY + pad + 1) - cropY;
  if (cropW === width && cropH === height) return canvas;

  const out = document.createElement('canvas');
  out.width = cropW;
  out.height = cropH;
  out.getContext('2d').drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return out;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('无法生成 PNG'))), 'image/png');
  });
}

// ---- upload flow ----------------------------------------------------------

function petSetBusy(busy, label) {
  petView.busy = busy;
  const drop = petEl('petDrop');
  const text = petEl('petBusyLabel');
  if (drop) drop.classList.toggle('is-busy', busy);
  if (text && label) text.textContent = label;
}

async function petHandleFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { window.IexaDialogs?.alert?.('请选择图片文件'); return; }
  if (file.size > 20 * 1024 * 1024) { window.IexaDialogs?.alert?.('图片不能超过 20 MB'); return; }

  petSetBusy(true, '正在分析图片…');
  try {
    const bitmap = await createImageBitmap(file);
    let canvas;
    if (hasAlphaChannel(bitmap)) {
      // Already cut out: keep the artist's pixels untouched.
      canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      canvas = cropToContent(canvas);
    } else {
      petSetBusy(true, '正在抠图，首次使用需要加载模型…');
      canvas = await segmentImage(bitmap);
    }
    bitmap.close?.();

    petSetBusy(true, '正在保存…');
    const blob = await canvasToBlob(canvas);
    const response = await fetch(API_BASE + '/api/pet/sprite', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '保存失败');
    petView.snapshot = result.snapshot;
    petRender();
    window.IexaDialogs?.toast?.('已生成桌宠形象');
  } catch (error) {
    window.IexaDialogs?.alert?.('抠图失败：' + (error.message || '未知错误'));
  } finally {
    petSetBusy(false);
  }
}

// ---- rendering ------------------------------------------------------------

function petSpriteUrl() {
  const version = petView.snapshot?.spriteVersion || '';
  return `${API_BASE}/api/pet/sprite?v=${encodeURIComponent(version)}`;
}

function petRender() {
  const snapshot = petView.snapshot || { hasSprite: false, config: {} };
  const drop = petEl('petDrop');
  const image = petEl('petPreview');
  const config = snapshot.config || {};

  if (drop) drop.classList.toggle('has-image', !!snapshot.hasSprite);
  if (image && snapshot.hasSprite) image.src = petSpriteUrl();

  const scale = petEl('petScale');
  if (scale) {
    scale.value = String(Math.round((config.scale || 1) * 100));
    petEl('petScaleValue').textContent = Math.round((config.scale || 1) * 100) + '%';
  }
  for (const key of ['alwaysOnTop', 'wander', 'shadow', 'reactions']) {
    const input = petEl('pet-' + key);
    if (input) input.checked = config[key] !== false;
  }

  const summon = petEl('petSummon');
  if (summon) {
    summon.textContent = config.visible ? '收起桌宠' : '召唤桌宠';
    summon.disabled = !snapshot.hasSprite;
  }
  const clear = petEl('petClear');
  if (clear) clear.disabled = !snapshot.hasSprite;
  const hint = petEl('petSizeHint');
  if (hint) {
    if (!snapshot.hasSprite) {
      hint.textContent = '还没有形象';
    } else {
      const scale = config.scale || 1;
      // At 100% the two numbers are identical; show the source size once.
      hint.textContent = Math.abs(scale - 1) < 0.005
        ? `${snapshot.width} × ${snapshot.height} 像素`
        : `${snapshot.width} × ${snapshot.height} 像素 · 显示 ${Math.round(snapshot.width * scale)} × ${Math.round(snapshot.height * scale)}`;
    }
  }
}

async function petPatch(patch) {
  const response = await fetch(API_BASE + '/api/pet', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '保存失败');
  petView.snapshot = result.snapshot;
  petRender();
}

async function petToggleVisible() {
  const visible = !!petView.snapshot?.config?.visible;
  try {
    await petPatch({ visible: !visible });
    window.IexaDialogs?.toast?.(!visible ? '桌宠已召唤' : '桌宠已收起');
  } catch (error) {
    window.IexaDialogs?.alert?.(error.message || '操作失败');
  }
}

async function petClearSprite() {
  const confirmed = await window.IexaDialogs?.confirm?.('删除当前桌宠形象？');
  if (!confirmed) return;
  const response = await fetch(API_BASE + '/api/pet/sprite', { method: 'DELETE' });
  const result = await response.json().catch(() => ({}));
  if (response.ok) {
    petView.snapshot = result.snapshot;
    petRender();
  }
}

function petInit() {
  const drop = petEl('petDrop');
  const input = petEl('petFile');
  if (!drop || !input) return;

  petEl('petPick')?.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    void petHandleFile(file);
  });

  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('is-over');
    void petHandleFile(event.dataTransfer?.files?.[0]);
  });

  petEl('petSummon')?.addEventListener('click', () => void petToggleVisible());
  petEl('petClear')?.addEventListener('click', () => void petClearSprite());

  petEl('petScale')?.addEventListener('input', (event) => {
    petEl('petScaleValue').textContent = (Number(event.target.value) || 100) + '%';
  });
  petEl('petScale')?.addEventListener('change', (event) => {
    void petPatch({ scale: (Number(event.target.value) || 100) / 100 });
  });

  for (const key of ['alwaysOnTop', 'wander', 'shadow', 'reactions']) {
    petEl('pet-' + key)?.addEventListener('change', (event) => {
      void petPatch({ [key]: event.target.checked });
    });
  }

  loadPetSnapshot().then(() => petRender()).catch((error) => {
    window.IexaDialogs?.alert?.(error.message || '无法读取桌宠状态');
  });
}

// Wiring lives in an IIFE: this module must declare, not run, at load time.
(() => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', petInit, { once: true });
  } else {
    petInit();
  }
})();
