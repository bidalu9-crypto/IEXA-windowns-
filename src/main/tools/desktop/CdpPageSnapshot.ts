/** Runs in a CDP isolated world. Actual nodes remain private; selectors and
 * serialized screenshots never grant input without the current node/token. */
export const CREATE_PAGE_SNAPSHOT = String.raw`(function(token) {
  const documentAtCapture=document,url=location.href;
  const viewport=()=>[innerWidth,innerHeight,devicePixelRatio,scrollX,scrollY],initialViewport=JSON.stringify(viewport());
  const rectOf=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};};
  const visible=e=>{
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    if(!e.isConnected||r.width<=1||r.height<=1||s.visibility==='hidden'||s.display==='none'||e.closest('[hidden],[inert]'))return false;
    let l=Math.max(0,r.left),t=Math.max(0,r.top),right=Math.min(innerWidth,r.left+r.width),bottom=Math.min(innerHeight,r.top+r.height);
    for(let p=e.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(s.display==='none'||s.visibility==='hidden')return false;if(/hidden|clip|scroll|auto/.test(s.overflowX||s.overflow)){l=Math.max(l,b.left);right=Math.min(right,b.left+b.width);}if(/hidden|clip|scroll|auto/.test(s.overflowY||s.overflow)){t=Math.max(t,b.top);bottom=Math.min(bottom,b.top+b.height);}}
    return right>l&&bottom>t;
  };
  const enabled=e=>!e.matches(':disabled')&&!e.closest('[aria-disabled="true"],[inert]');
  const editorSurface=e=>e.matches('.monaco-editor,.xterm');
  const role=e=>{
    if(e instanceof HTMLInputElement){if(['checkbox','radio'].includes(e.type))return e.type;if(e.type==='range')return 'slider';if(['button','submit','reset'].includes(e.type))return 'button';return 'edit';}
    if(e instanceof HTMLTextAreaElement||e.isContentEditable)return 'edit';if(e instanceof HTMLSelectElement)return 'combobox';if(e.matches('summary'))return 'button';
    const explicit=e.getAttribute('role');if(explicit)return explicit.toLowerCase()==='textbox'?'edit':explicit.toLowerCase();
    if(e instanceof HTMLButtonElement)return 'button';if(e instanceof HTMLAnchorElement)return 'link';if(editorSurface(e))return e.matches('.xterm')?'terminal':'editor';
    return getComputedStyle(e).cursor==='pointer'||e.hasAttribute('onclick')||typeof e.onclick==='function'||e.matches('[data-ui-action],[data-action]')?'button':'region';
  };
  const name=e=>e.getAttribute('aria-label')||(e.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim()||Array.from(e.labels||[]).map(l=>l.textContent||'').join(' ').trim()||e.getAttribute('name')||e.getAttribute('title')||e.getAttribute('placeholder')||(editorSurface(e)?e.matches('.xterm')?'Terminal':'Editor':e===document.scrollingElement?'Page scroll':e===document.body?'Page keyboard':(e.textContent||'').trim().slice(0,500));
  const scrollable=e=>{const s=getComputedStyle(e);return(e.scrollHeight>e.clientHeight+1&&(/auto|scroll/.test(s.overflowY||s.overflow)||e===document.scrollingElement))||(e.scrollWidth>e.clientWidth+1&&(/auto|scroll/.test(s.overflowX||s.overflow)||e===document.scrollingElement));};
  const marked=e=>e.matches('button,input,textarea,select,a[href],summary,label[for],[contenteditable="true"],[tabindex],[onclick],[data-ui-action],[data-action]')||e instanceof HTMLLabelElement&&!!e.control||!!e.getAttribute('role')&&!['none','presentation'].includes(e.getAttribute('role').toLowerCase())||typeof e.onclick==='function'||editorSurface(e);
  const distinctControl=e=>{
    // A cursor inherited from a button does not make its caption/icon another
    // actionable button. Explicit child semantics/actions remain independent.
    if(marked(e)||scrollable(e)||e.matches('canvas')||e===document.body&&e===document.activeElement)return true;
    if(e.namespaceURI==='http://www.w3.org/2000/svg'||e.closest('[aria-hidden="true"]'))return false;
    const r=rectOf(e);
    for(let p=e.parentElement;p;p=p.parentElement){
      if(marked(p)&&capabilities(p).includes('invoke'))return false;
      if(getComputedStyle(p).cursor==='pointer'){const b=rectOf(p);if(['left','top','width','height'].every(key=>Math.abs(b[key]-r[key])<1))return false;}
    }
    return true;
  };
  const capabilities=e=>{
    const a=[],r=role(e);
    if(e instanceof HTMLElement&&(e.matches('button,a[href],summary,label[for],input[type=checkbox],input[type=radio],input[type=button],input[type=submit],input[type=reset],[data-ui-action],[data-action]')||['button','link','checkbox','radio','tab','menuitem','menuitemcheckbox','menuitemradio','treeitem','option','switch'].includes(r)||e.hasAttribute('onclick')||typeof e.onclick==='function'||getComputedStyle(e).cursor==='pointer'))a.push('invoke');
    if(e instanceof HTMLSelectElement)a.push('select');if(e instanceof HTMLInputElement&&['range','number','color','date','time','datetime-local'].includes(e.type))a.push('setValue');
    if((e instanceof HTMLTextAreaElement||e instanceof HTMLInputElement&&['text','search','email','url','tel','password','number'].includes(e.type))&&!e.readOnly)a.push('textValue');
    if(editorSurface(e)||e.isContentEditable)a.push('textInput');if(e.matches('button,input,textarea,select,a[href],[tabindex],[contenteditable],summary')||editorSurface(e)||e===document.body&&e===document.activeElement)a.push('keyInput');
    if(scrollable(e))a.push('scroll');if(a.length||e.matches('canvas,[role=separator],[data-ui-action],[data-action]')||getComputedStyle(e).cursor==='pointer')a.push('rendererPointer');return a;
  };
  const describe=e=>({role:role(e),name:name(e),value:e instanceof HTMLInputElement&&e.type==='password'?'[redacted]':('value'in e?String(e.value):''),automationId:e.id||'',enabled:enabled(e),readOnly:!!e.readOnly,type:e.getAttribute('type'),href:e.getAttribute('href'),actions:Array.from(e.attributes).filter(a=>a.name==='onclick'||a.name.startsWith('data-')).map(a=>[a.name,a.value]).sort((a,b)=>a[0].localeCompare(b[0])),bounds:rectOf(e),capabilities:capabilities(e),focused:e===document.activeElement||editorSurface(e)&&e.contains(document.activeElement),checked:'checked'in e?!!e.checked:undefined,expanded:e.matches('summary')?!!e.parentElement?.open:e.getAttribute('aria-expanded'),min:e.getAttribute('min'),max:e.getAttribute('max'),step:e.getAttribute('step'),options:e instanceof HTMLSelectElement?Array.from(e.options).slice(0,200).map(o=>({value:o.value,label:o.label,disabled:o.disabled||!!o.closest('optgroup[disabled]'),selected:o.selected})):undefined,scroll:scrollable(e)?{top:e.scrollTop,left:e.scrollLeft,width:e.scrollWidth,height:e.scrollHeight,clientWidth:e.clientWidth,clientHeight:e.clientHeight}:undefined});
  const candidates=Array.from(document.querySelectorAll('button,input,textarea,select,a[href],summary,label[for],[role],[contenteditable="true"],[tabindex],[onclick],[data-ui-action],[data-action],.monaco-editor,.xterm'));
  // Bound discovery of listener-based pointer controls and nested scroll regions.
  for(const e of Array.from(document.querySelectorAll('*')).slice(0,6000)){if(visible(e)&&(scrollable(e)||getComputedStyle(e).cursor==='pointer'||typeof e.onclick==='function'||e.matches('canvas,[data-ui-action],[data-action]')))candidates.push(e);}
  if(document.scrollingElement&&scrollable(document.scrollingElement))candidates.push(document.scrollingElement);
  if(document.activeElement===document.body)candidates.push(document.body);
  const usable=Array.from(new Set(candidates)).filter(visible).filter(distinctControl).filter(e=>capabilities(e).length),nodes=usable.slice(0,400),baseline=nodes.map(describe),privateValues=nodes.map(e=>'value'in e?e.value:undefined),privateClickHandlers=nodes.map(e=>e.onclick);
  const keyboardNode=e=>editorSurface(e)?e.querySelector('textarea,[contenteditable="true"],[tabindex="0"]'):e;
  const privateKeyboardNodes=nodes.map(keyboardNode),privateKeyboardValues=privateKeyboardNodes.map(e=>e&&'value'in e?e.value:undefined);
  const documentText=(document.body?.innerText||'').slice(0,16000);let consumed=false;
  const contextValid=()=>!consumed&&document===documentAtCapture&&url===location.href&&initialViewport===JSON.stringify(viewport());
  const nodeValid=i=>{const e=nodes[i];return !!e&&e.ownerDocument===documentAtCapture&&privateClickHandlers[i]===e.onclick&&privateValues[i]===('value'in e?e.value:undefined)&&visible(e)&&JSON.stringify(describe(e))===JSON.stringify(baseline[i]);};
  // Timers/streaming text elsewhere can change between DOM evidence and a
  // screenshot. They do not revoke a stable target. Every actual input still
  // revalidates its exact captured node and state immediately before dispatch.
  const valid=id=>contextValid()&&(id===undefined||nodeValid(elements.findIndex(e=>e.id===id)));
  const elements=baseline.map((v,i)=>({id:token+'_'+i,role:v.role,text:v.value||v.name,enabled:v.enabled,source:'chromium-cdp',bounds:v.bounds,capabilities:v.capabilities,focused:v.focused,checked:v.checked,expanded:v.expanded,options:v.options,scroll:v.scroll,min:v.min,max:v.max,step:v.step,selector:{automationId:v.automationId,controlType:v.role,name:v.name,backend:'chromium-cdp'}}));
  elements.push({id:token+'_document',role:'document',text:documentText,enabled:true,source:'chromium-cdp',bounds:{left:0,top:0,width:innerWidth,height:innerHeight}});
  const requireNode=(id,capability)=>{if(!contextValid())throw Error('Observation is stale: document or viewport changed.');const i=elements.findIndex(e=>e.id===id),e=nodes[i];if(!e||!baseline[i].enabled)throw Error('Input target is absent or disabled.');if(!nodeValid(i))throw Error('Input target is stale: node, value, action, visibility or geometry changed.');if(capability&&!baseline[i].capabilities.includes(capability))throw Error('Target does not expose '+capability+' capability.');return {e,index:i};};
  const exposed=(e,point)=>{if(typeof document.elementFromPoint!=='function')return;const r=rectOf(e),x=point?.x??(Math.max(0,r.left)+Math.min(innerWidth,r.left+r.width))/2,y=point?.y??(Math.max(0,r.top)+Math.min(innerHeight,r.top+r.height))/2,hit=document.elementFromPoint(x,y);if(!hit||hit!==e&&!e.contains(hit))throw Error('Input target is covered by another control.');};
  const emitValue=e=>{e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));e.dispatchEvent(new Event('change',{bubbles:true}));};
  let preparedPaste;
  return {info:{title:document.title,url,elements,width:innerWidth,height:innerHeight,truncated:usable.length>nodes.length,candidateCount:usable.length},valid,
    paste:(id,text)=>{
      const prepared=preparedPaste;preparedPaste=undefined;
      if(!prepared||prepared.id!==id||document!==documentAtCapture||location.href!==url||!prepared.e.isConnected||!prepared.input.isConnected||keyboardNode(prepared.e)!==prepared.input||document.activeElement!==prepared.input||!enabled(prepared.input)||prepared.input.readOnly)throw Error('Prepared editor paste target is stale or no longer focused.');
      if(typeof text!=='string'||typeof DataTransfer!=='function'||typeof ClipboardEvent!=='function')throw Error('Editor paste event is unavailable.');
      exposed(prepared.e);
      const transfer=new DataTransfer();transfer.setData('text/plain',text);
      const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true,composed:true});
      prepared.input.dispatchEvent(event);
      if(!event.defaultPrevented)throw Error('Editor did not acknowledge the paste event; observe before further input.');
      return {method:'cdp_editor_paste',inputMechanism:'cdp-dom-paste',eventConsumed:true};
    },
    apply:(id,action,text,replace,options={})=>{
      const {e,index}=requireNode(id);
      exposed(e);
      if(action==='click_element'){if(!baseline[index].capabilities.includes('invoke'))throw Error('Target is not an actionable click control.');consumed=true;HTMLElement.prototype.click.call(e);return {method:'cdp_dom_click',inputMechanism:'cdp-dom'};}
      if(action==='select_option'){
        if(!(e instanceof HTMLSelectElement))throw Error('Target is not a select control.');const matches=Array.from(e.options).filter(o=>options.value!==undefined?o.value===String(options.value):o.label===text);
        if(matches.length!==1||matches[0].disabled||matches[0].closest('optgroup[disabled]'))throw Error('Select option is absent, disabled or ambiguous.');consumed=true;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,matches[0].value);emitValue(e);return {method:'cdp_dom_select',inputMechanism:'cdp-dom',value:e.value,label:matches[0].label};
      }
      if(action==='set_value'){
        if(!baseline[index].capabilities.includes('setValue')||e.readOnly)throw Error('Target is not a writable value control.');const raw=options.value!==undefined?String(options.value):text;
        if(e.type==='range'||e.type==='number'){const n=Number(raw),min=e.min===''?(e.type==='range'?0:-Infinity):Number(e.min),max=e.max===''?(e.type==='range'?100:Infinity):Number(e.max),step=e.step==='any'?0:Number(e.step||1),base=Number.isFinite(min)?min:0;if(!raw.trim()||!Number.isFinite(n)||n<min||n>max||step>0&&Math.abs((n-base)/step-Math.round((n-base)/step))>1e-7)throw Error('Value does not satisfy min/max/step.');}
        consumed=true;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,raw);emitValue(e);return {method:'cdp_dom_value',inputMechanism:'cdp-dom',value:e.value};
      }
      if(action==='scroll'){
        if(!baseline[index].capabilities.includes('scroll'))throw Error('Target is not a scrollable region.');const dx=Number(options.deltaX||0),dy=options.deltaY!==undefined?Number(options.deltaY):-Number(options.delta||0)*100;
        if(!Number.isFinite(dx)||!Number.isFinite(dy)||Math.abs(dx)>10000||Math.abs(dy)>10000)throw Error('Scroll delta is invalid.');consumed=true;e.scrollBy({left:dx,top:dy,behavior:'instant'});return {method:'cdp_dom_scroll',inputMechanism:'cdp-dom',scrollTop:e.scrollTop,scrollLeft:e.scrollLeft};
      }
      if(action!=='type_element')throw Error('Unsupported semantic input action.');if(baseline[index].readOnly)throw Error('Target is read-only.');let setter;
      if(e instanceof HTMLTextAreaElement)setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;if(e instanceof HTMLInputElement&&['text','search','email','url','tel','password','number'].includes(e.type))setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      if(!setter)throw Error('Target is not a writable input/textarea; no textContent fallback.');consumed=true;setter.call(e,replace?text:e.value+text);e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));e.dispatchEvent(new Event('change',{bubbles:true}));return {method:'cdp_dom_value',inputMechanism:'cdp-dom'};
    },
    prepare:(id,capability,point)=>{
      const {e,index}=requireNode(id,capability),bounds=baseline[index].bounds;
      if(point){if(point.x<bounds.left||point.y<bounds.top||point.x>=bounds.left+bounds.width||point.y>=bounds.top+bounds.height||point.x<0||point.y<0||point.x>=innerWidth||point.y>=innerHeight)throw Error('Renderer pointer start is outside its observed target.');}exposed(e,point);
      consumed=true;
      if(capability==='keyInput'||capability==='textInput'){const input=privateKeyboardNodes[index];if(!input||input!==keyboardNode(e)||!input.isConnected||!enabled(input)||privateKeyboardValues[index]!==('value'in input?input.value:undefined)||capability==='textInput'&&input.readOnly)throw Error('Editor keyboard input surface is absent, stale or not writable.');input.focus({preventScroll:true});if(document.activeElement!==input&&!input.contains(document.activeElement))throw Error('Keyboard target did not accept DOM focus.');}
      if(capability==='textInput'&&e.matches('.monaco-editor'))preparedPaste={id,e,input:privateKeyboardNodes[index]};
      return {bounds,width:innerWidth,height:innerHeight,role:baseline[index].role,editorPaste:!!preparedPaste};
    }
  };
})`;
