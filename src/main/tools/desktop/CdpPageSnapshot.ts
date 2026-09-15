/** Executed only in a CDP isolated world. The returned remote object holds actual
 * nodes: a replacement at the same CSS path is never considered the same target.
 * No methods or references are installed in the page's JavaScript world. */
export const CREATE_PAGE_SNAPSHOT = String.raw`(function(token) {
  const documentAtCapture = document;
  const url = location.href;
  const viewport = () => [innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY];
  const initialViewport = JSON.stringify(viewport());
  const visible = e => {
    const r = e.getBoundingClientRect(), style = getComputedStyle(e);
    return e.isConnected && r.width > 1 && r.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const role = e => {
    const explicit = e.getAttribute('role');
    if (explicit) return explicit.toLowerCase() === 'textbox' ? 'edit' : explicit.toLowerCase();
    if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e.isContentEditable) return 'edit';
    if (e instanceof HTMLSelectElement) return 'combobox';
    if (e instanceof HTMLButtonElement) return 'button';
    if (e instanceof HTMLAnchorElement) return 'link';
    return 'text';
  };
  const name = e => e.getAttribute('aria-label') ||
    (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ').trim() ||
    Array.from(e.labels || []).map(label => label.textContent || '').join(' ').trim() ||
    e.getAttribute('name') || (e.textContent || '').trim().slice(0, 500);
  const describe = e => {
    const r = e.getBoundingClientRect();
    const password = e instanceof HTMLInputElement && e.type === 'password';
    return { role: role(e), name: name(e), value: password ? '[redacted]' : ('value' in e ? String(e.value) : ''),
      automationId: e.id || '', enabled: !e.matches(':disabled') && e.getAttribute('aria-disabled') !== 'true',
      readOnly: !!e.readOnly, type:e.getAttribute('type'),href:e.getAttribute('href'), bounds: {left:r.left, top:r.top, width:r.width, height:r.height} };
  };
  const nodes = Array.from(document.querySelectorAll('button,input,textarea,select,a,[role],[contenteditable="true"]')).filter(visible).slice(0, 180);
  const baseline = nodes.map(describe);
  const privateValues = nodes.map(e => 'value' in e ? e.value : undefined);
  const documentText = (document.body?.innerText || '').slice(0, 16000);
  let consumed = false;
  const valid = () => !consumed && document === documentAtCapture && url === location.href &&
    initialViewport === JSON.stringify(viewport()) && documentText === (document.body?.innerText || '').slice(0, 16000) && nodes.every((node,i) => privateValues[i] === ('value' in node ? node.value : undefined) && visible(node) && JSON.stringify(describe(node)) === JSON.stringify(baseline[i]));
  const elements = baseline.map((value, i) => ({id: token + '_' + i, role:value.role, text:value.value || value.name,
    enabled:value.enabled, source:'chromium-cdp', bounds:value.bounds,
    selector:{automationId:value.automationId, controlType:value.role, name:value.name, backend:'chromium-cdp'}}));
  // Read-only document evidence has no selector and is never an input capability.
  elements.push({id:token+'_document',role:'document',text:documentText,
    enabled:true, source:'chromium-cdp',bounds:{left:0,top:0,width:innerWidth,height:innerHeight}});
  return {
    info: {title:document.title,url,elements,width:innerWidth,height:innerHeight},
    valid,
    apply: (id, action, text, replace) => {
      if (!valid()) throw new Error('Observation is stale: node, document, value or geometry changed.');
      const index = elements.findIndex(e => e.id === id);
      const e = nodes[index];
      if (!e || !baseline[index].enabled) throw new Error('Input target is absent or disabled.');
      if (action === 'click_element') {
        if (!['button','link','checkbox','radio','tab','menuitem'].includes(role(e))) throw new Error('Target is not an actionable click control.');
        consumed = true;
        HTMLElement.prototype.click.call(e);
        return {method:'cdp_dom_click'};
      }
      if (action !== 'type_element') throw new Error('Unsupported semantic input action.');
      if (baseline[index].readOnly) throw new Error('Target is read-only.');
      let setter;
      if (e instanceof HTMLTextAreaElement) setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      if (e instanceof HTMLInputElement && ['text','search','email','url','tel','password','number'].includes(e.type))
        setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      if (!setter) throw new Error('Target is not a writable input/textarea; no textContent fallback.');
      const next = replace ? text : e.value + text;
      consumed = true;
      setter.call(e, next);
      e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
      return {method:'cdp_dom_value'};
    }
  };
})`;
