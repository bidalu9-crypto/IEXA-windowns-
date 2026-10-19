// =============================================================================
// Image attachment gallery
//
// One dialog for every image in the conversation: arrows, film strip and
// keyboard walk the set in transcript order.
//
// Classic script, extracted verbatim from app.js. Top-level declarations land
// in the global lexical environment, so app.js and the other services keep
// calling these by bare name. index.html fixes the load order; nothing here
// touches the DOM at load time.
// =============================================================================
const imagePreviewOverlay = document.getElementById('imagePreviewOverlay');
const imagePreviewBody = document.getElementById('imagePreviewBody');
const imagePreviewStage = document.getElementById('imagePreviewStage');
const imagePreviewImage = document.getElementById('imagePreviewImage');
const imagePreviewTitle = document.getElementById('imagePreviewTitle');
const imagePreviewCounter = document.getElementById('imagePreviewCounter');
const imagePreviewStrip = document.getElementById('imagePreviewStrip');
const imagePreviewError = document.getElementById('imagePreviewError');
const imagePreviewClose = document.getElementById('imagePreviewClose');
const imagePreviewPrev = document.getElementById('imagePreviewPrev');
const imagePreviewNext = document.getElementById('imagePreviewNext');
const imagePreviewZoomIn = document.getElementById('imagePreviewZoomIn');
const imagePreviewZoomOut = document.getElementById('imagePreviewZoomOut');
const imagePreviewZoomReset = document.getElementById('imagePreviewZoomReset');
const imagePreviewZoomLabel = document.getElementById('imagePreviewZoomLabel');

const IMAGE_PREVIEW_MIN_ZOOM = 1;
const IMAGE_PREVIEW_MAX_ZOOM = 8;
const IMAGE_PREVIEW_STEP = 1.25;
// Hosts whose <img> is a picture the user may want to open. Restricting the
// scan to these keeps avatars, icons and UI chrome out of the film strip.
const IMAGE_PREVIEW_HOSTS = '.message-image-attach, .tool-result-image, .tool-artifact-image, .message-content';

const imagePreviewState = {
  items: [],
  index: 0,
  zoom: 1,
  x: 0,
  y: 0,
  drag: null,
  lastFocus: null,
  open: false,
};

function imagePreviewName(img) {
  const artifactName = img.closest('.tool-artifact-image')?.querySelector('.tool-artifact-name')?.textContent;
  if (artifactName && artifactName.trim()) return artifactName.trim();
  const alt = (img.getAttribute('alt') || '').trim();
  if (alt) return alt;
  try {
    const url = new URL(img.currentSrc || img.src, location.href);
    const raw = url.searchParams.get('path');
    if (raw) return decodeURIComponent(raw).split('/').pop();
  } catch { /* data: URL or opaque source */ }
  return '图片';
}

// Transcript order, so left/right matches what the user sees in the chat.
function collectConversationImages(originImage) {
  const scope = document.getElementById('chatMessages');
  if (!scope || !originImage || !scope.contains(originImage)) return null;
  const items = [];
  for (const img of scope.querySelectorAll('img')) {
    if (!img.isConnected || !img.closest(IMAGE_PREVIEW_HOSTS)) continue;
    const src = img.currentSrc || img.src;
    if (!src) continue;
    // Icons rendered inside markdown are images too, but they are not
    // something the user would want to page through.
    if (img.offsetWidth && img.offsetHeight && img.offsetWidth < 32 && img.offsetHeight < 32) continue;
    items.push({ src, name: imagePreviewName(img), el: img });
  }
  return items;
}

function imagePreviewRatio() {
  return Math.round(imagePreviewState.zoom * 100);
}

function applyImagePreviewTransform() {
  const state = imagePreviewState;
  if (imagePreviewImage) {
    // Leaving the transform unset at 1x keeps the fitted image pixel-exact.
    imagePreviewImage.style.transform = state.zoom === 1
      ? ''
      : `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
  }
  if (imagePreviewBody) imagePreviewBody.classList.toggle('is-zoomed', state.zoom > 1);
  if (imagePreviewZoomLabel) imagePreviewZoomLabel.textContent = `${imagePreviewRatio()}%`;
  if (imagePreviewZoomIn) imagePreviewZoomIn.disabled = state.zoom >= IMAGE_PREVIEW_MAX_ZOOM;
  if (imagePreviewZoomOut) imagePreviewZoomOut.disabled = state.zoom <= IMAGE_PREVIEW_MIN_ZOOM;
}

function resetImagePreviewTransform() {
  imagePreviewState.zoom = 1;
  imagePreviewState.x = 0;
  imagePreviewState.y = 0;
  applyImagePreviewTransform();
}

function clampImagePreviewPan() {
  const state = imagePreviewState;
  if (!imagePreviewStage || !imagePreviewImage || state.zoom <= IMAGE_PREVIEW_MIN_ZOOM) {
    state.x = 0;
    state.y = 0;
    return;
  }
  const rect = imagePreviewStage.getBoundingClientRect();
  // offsetWidth/Height are layout sizes and ignore the transform, which is
  // exactly what is needed: the painted size is that times the zoom factor.
  const slackX = Math.max(0, (imagePreviewImage.offsetWidth * state.zoom - rect.width) / 2);
  const slackY = Math.max(0, (imagePreviewImage.offsetHeight * state.zoom - rect.height) / 2);
  state.x = Math.min(slackX, Math.max(-slackX, state.x));
  state.y = Math.min(slackY, Math.max(-slackY, state.y));
}

function setImagePreviewZoom(next, anchor) {
  const state = imagePreviewState;
  const clamped = Math.min(IMAGE_PREVIEW_MAX_ZOOM, Math.max(IMAGE_PREVIEW_MIN_ZOOM, next));
  if (Math.abs(clamped - state.zoom) < 0.0001) return;
  if (clamped <= IMAGE_PREVIEW_MIN_ZOOM) {
    state.zoom = IMAGE_PREVIEW_MIN_ZOOM;
    state.x = 0;
    state.y = 0;
  } else {
    const rect = imagePreviewStage?.getBoundingClientRect();
    if (anchor && rect) {
      // Keep the pixel under the cursor fixed while the scale changes.
      const px = anchor.clientX - (rect.left + rect.width / 2);
      const py = anchor.clientY - (rect.top + rect.height / 2);
      const ratio = clamped / state.zoom;
      state.x = px - (px - state.x) * ratio;
      state.y = py - (py - state.y) * ratio;
    } else if (state.zoom <= IMAGE_PREVIEW_MIN_ZOOM) {
      state.x = 0;
      state.y = 0;
    }
    state.zoom = clamped;
    clampImagePreviewPan();
  }
  applyImagePreviewTransform();
}

function syncImagePreviewStripSelection() {
  if (!imagePreviewStrip) return;
  const thumbs = imagePreviewStrip.children;
  for (let i = 0; i < thumbs.length; i++) {
    const active = i === imagePreviewState.index;
    thumbs[i].classList.toggle('is-active', active);
    thumbs[i].setAttribute('aria-selected', active ? 'true' : 'false');
  }
  const active = thumbs[imagePreviewState.index];
  if (!active || imagePreviewStrip.scrollWidth <= imagePreviewStrip.clientWidth) return;
  // Manual scroll-into-view keeps the dialog itself from being scrolled.
  const left = active.offsetLeft;
  const right = left + active.offsetWidth;
  if (left < imagePreviewStrip.scrollLeft) imagePreviewStrip.scrollLeft = left - 8;
  else if (right > imagePreviewStrip.scrollLeft + imagePreviewStrip.clientWidth) {
    imagePreviewStrip.scrollLeft = right - imagePreviewStrip.clientWidth + 8;
  }
}

function buildImagePreviewStrip() {
  if (!imagePreviewStrip) return;
  imagePreviewStrip.innerHTML = '';
  const items = imagePreviewState.items;
  imagePreviewStrip.hidden = items.length < 2;
  if (items.length < 2) return;
  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'image-preview-thumb';
    thumb.dataset.index = String(index);
    thumb.title = item.name || `图片 ${index + 1}`;
    thumb.setAttribute('role', 'tab');
    thumb.setAttribute('aria-label', `第 ${index + 1} 张：${item.name || '图片'}`);
    const img = document.createElement('img');
    img.src = item.src;
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    thumb.appendChild(img);
    fragment.appendChild(thumb);
  });
  imagePreviewStrip.appendChild(fragment);
}

function preloadImagePreviewNeighbours() {
  const items = imagePreviewState.items;
  if (items.length < 2) return;
  for (const offset of [1, -1]) {
    const item = items[(imagePreviewState.index + offset + items.length) % items.length];
    if (!item) continue;
    const probe = new Image();
    probe.decoding = 'async';
    probe.src = item.src;
  }
}

function showImagePreviewAt(index) {
  const items = imagePreviewState.items;
  if (!items.length || !imagePreviewImage) return;
  const next = ((index % items.length) + items.length) % items.length;
  imagePreviewState.index = next;
  const item = items[next];

  resetImagePreviewTransform();
  if (imagePreviewError) imagePreviewError.hidden = true;
  imagePreviewImage.src = item.src;
  imagePreviewImage.alt = item.name || '图片附件';
  if (imagePreviewTitle) {
    imagePreviewTitle.textContent = item.name || '图片预览';
    imagePreviewTitle.title = item.name || '';
  }

  const multiple = items.length > 1;
  if (imagePreviewCounter) {
    imagePreviewCounter.hidden = !multiple;
    imagePreviewCounter.textContent = `${next + 1} / ${items.length}`;
  }
  for (const button of [imagePreviewPrev, imagePreviewNext]) {
    if (button) button.disabled = !multiple;
  }
  syncImagePreviewStripSelection();
  preloadImagePreviewNeighbours();
}

function stepImagePreview(delta) {
  if (imagePreviewState.items.length < 2) return;
  showImagePreviewAt(imagePreviewState.index + delta);
}

function openImagePreview(src, name, originImage) {
  if (!imagePreviewOverlay || !imagePreviewImage) return;
  const gallery = collectConversationImages(originImage);
  let items = gallery && gallery.length ? gallery : [{ src, name, el: originImage || null }];
  let index = originImage ? items.findIndex(item => item.el === originImage) : -1;
  if (index < 0) index = items.findIndex(item => item.src === src);
  if (index < 0) {
    items = items.concat([{ src, name, el: originImage || null }]);
    index = items.length - 1;
  }

  imagePreviewState.items = items;
  imagePreviewState.index = index;
  imagePreviewState.lastFocus = document.activeElement;
  imagePreviewState.open = true;
  imagePreviewOverlay.style.display = 'flex';
  document.body.classList.add('image-preview-open');
  buildImagePreviewStrip();
  showImagePreviewAt(index);
  if (imagePreviewClose) imagePreviewClose.focus({ preventScroll: true });
}

function closeImagePreview() {
  if (!imagePreviewState.open) return;
  imagePreviewState.open = false;
  imagePreviewState.drag = null;
  if (imagePreviewOverlay) imagePreviewOverlay.style.display = 'none';
  document.body.classList.remove('image-preview-open');
  imagePreviewBody?.classList.remove('is-panning', 'is-zoomed');
  if (imagePreviewImage) {
    imagePreviewImage.removeAttribute('src');
    imagePreviewImage.style.transform = '';
    imagePreviewImage.alt = '';
  }
  if (imagePreviewStrip) {
    imagePreviewStrip.hidden = true;
    imagePreviewStrip.innerHTML = '';
  }
  if (imagePreviewCounter) imagePreviewCounter.hidden = true;
  imagePreviewState.items = [];
  imagePreviewState.index = 0;
  imagePreviewState.zoom = 1;
  imagePreviewState.x = 0;
  imagePreviewState.y = 0;
  const focusTarget = imagePreviewState.lastFocus;
  imagePreviewState.lastFocus = null;
  if (focusTarget && focusTarget.isConnected && typeof focusTarget.focus === 'function') {
    focusTarget.focus({ preventScroll: true });
  }
}

// Pointer, wheel and keyboard wiring for the gallery dialog. Called once from
// app.js init() so evaluating this file has no side effects.
function initImageGallery() {
  if (imagePreviewClose) imagePreviewClose.addEventListener('click', closeImagePreview);
  if (imagePreviewOverlay) {
    imagePreviewOverlay.addEventListener('click', (e) => {
      if (e.target === imagePreviewOverlay) closeImagePreview();
    });
  }
  if (imagePreviewPrev) imagePreviewPrev.addEventListener('click', () => stepImagePreview(-1));
  if (imagePreviewNext) imagePreviewNext.addEventListener('click', () => stepImagePreview(1));
  if (imagePreviewZoomIn) imagePreviewZoomIn.addEventListener('click', () => setImagePreviewZoom(imagePreviewState.zoom * IMAGE_PREVIEW_STEP));
  if (imagePreviewZoomOut) imagePreviewZoomOut.addEventListener('click', () => setImagePreviewZoom(imagePreviewState.zoom / IMAGE_PREVIEW_STEP));
  if (imagePreviewZoomReset) imagePreviewZoomReset.addEventListener('click', () => setImagePreviewZoom(IMAGE_PREVIEW_MIN_ZOOM));
  if (imagePreviewStrip) {
    imagePreviewStrip.addEventListener('click', (event) => {
      const thumb = event.target.closest('.image-preview-thumb');
      if (!thumb) return;
      showImagePreviewAt(Number(thumb.dataset.index || 0));
    });
  }

  if (imagePreviewImage) {
    imagePreviewImage.addEventListener('load', () => applyImagePreviewTransform());
    imagePreviewImage.addEventListener('error', () => {
      if (imagePreviewError) imagePreviewError.hidden = false;
    });
    imagePreviewImage.addEventListener('dragstart', (event) => event.preventDefault());
  }

  if (imagePreviewStage) {
    // Wheel and trackpad pinch both arrive here; anchoring the zoom at the
    // pointer keeps the interesting detail under the cursor.
    imagePreviewStage.addEventListener('wheel', (event) => {
      if (!imagePreviewState.open || !imagePreviewImage?.naturalWidth) return;
      event.preventDefault();
      setImagePreviewZoom(imagePreviewState.zoom * Math.exp(-event.deltaY * 0.0022), event);
    }, { passive: false });

    imagePreviewStage.addEventListener('pointerdown', (event) => {
      if (!imagePreviewState.open || event.button !== 0) return;
      if (event.target === imagePreviewError) return;
      if (imagePreviewState.zoom <= IMAGE_PREVIEW_MIN_ZOOM) return;
      imagePreviewState.drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: imagePreviewState.x,
        originY: imagePreviewState.y,
      };
      imagePreviewBody?.classList.add('is-panning');
      imagePreviewImage?.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    imagePreviewStage.addEventListener('pointermove', (event) => {
      const drag = imagePreviewState.drag;
      if (!drag || drag.id !== event.pointerId) return;
      imagePreviewState.x = drag.originX + (event.clientX - drag.startX);
      imagePreviewState.y = drag.originY + (event.clientY - drag.startY);
      clampImagePreviewPan();
      applyImagePreviewTransform();
    });

    let lastTap = { time: 0, x: 0, y: 0 };
    // Ends a pan gesture. Also wired to window/blur so a pointerup that lands
    // outside the dialog (or a capture the browser cancels) cannot leave the
    // image stuck in the panning state.
    const releaseImagePreviewPan = () => {
      const drag = imagePreviewState.drag;
      if (!drag) return;
      imagePreviewState.drag = null;
      imagePreviewBody?.classList.remove('is-panning');
      if (imagePreviewImage?.hasPointerCapture?.(drag.id)) imagePreviewImage.releasePointerCapture(drag.id);
    };
    const endImagePreviewPan = (event) => {
      const drag = imagePreviewState.drag;
      if (drag && event && event.pointerId !== undefined && drag.id !== event.pointerId) return;
      releaseImagePreviewPan();
      if (!imagePreviewState.open) return;
      // Double click / double tap toggles between fit and 2.5x. Detected here
      // rather than via dblclick so it also works after a pan gesture.
      const now = performance.now();
      if (event && now - lastTap.time < 320
        && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 8) {
        lastTap = { time: 0, x: 0, y: 0 };
        setImagePreviewZoom(imagePreviewState.zoom > 1 ? IMAGE_PREVIEW_MIN_ZOOM : 2.5, event);
      } else if (event) {
        lastTap = { time: now, x: event.clientX, y: event.clientY };
      }
    };
    imagePreviewStage.addEventListener('pointerup', endImagePreviewPan);
    imagePreviewStage.addEventListener('pointercancel', endImagePreviewPan);
    window.addEventListener('pointerup', releaseImagePreviewPan);
    window.addEventListener('pointercancel', releaseImagePreviewPan);
    window.addEventListener('blur', releaseImagePreviewPan);
  }

  document.addEventListener('keydown', (event) => {
    if (!imagePreviewState.open) return;
    switch (event.key) {
      case 'Escape':
        closeImagePreview();
        break;
      case 'ArrowLeft':
        stepImagePreview(-1);
        break;
      case 'ArrowRight':
        stepImagePreview(1);
        break;
      case 'ArrowUp':
      case '+':
      case '=':
        setImagePreviewZoom(imagePreviewState.zoom * IMAGE_PREVIEW_STEP);
        break;
      case 'ArrowDown':
      case '-':
      case '_':
        setImagePreviewZoom(imagePreviewState.zoom / IMAGE_PREVIEW_STEP);
        break;
      case '0':
        setImagePreviewZoom(IMAGE_PREVIEW_MIN_ZOOM);
        break;
      case 'Home':
        showImagePreviewAt(0);
        break;
      case 'End':
        showImagePreviewAt(imagePreviewState.items.length - 1);
        break;
      default:
        return;
    }
    // Handled: keep the shortcut from also driving the chat underneath.
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

