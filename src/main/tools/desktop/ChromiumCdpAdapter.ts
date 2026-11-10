import { createHash, randomUUID } from 'crypto';
import { ToolExecutionResult } from '../../providers/types';
import { CREATE_PAGE_SNAPSHOT } from './CdpPageSnapshot';

interface CdpTarget { id: string; title: string; url: string; webSocketDebuggerUrl?: string; type: string; }
interface PageInfo { title: string; url: string; elements: any[]; width: number; height: number; truncated?: boolean; candidateCount?: number; }
interface Snapshot { targetId: string; handle: number; token: string; objectId: string; capturedAt: number; info: PageInfo; frame: Buffer; valid: boolean; }
interface Socket { send(data: string): void; close(): void; addEventListener(type: string, listener: (event: any) => void): void; }
interface Pending { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout; }
const TIMEOUT = 8000;
const handleOf = (target: CdpTarget) => -Number.parseInt(createHash('sha256').update(target.id).digest('hex').slice(0, 12), 16) || -1;
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('Desktop action cancelled.'); };
const INPUT_ACTIONS = new Set(['click_element','type_element','select_option','set_value','scroll','insert_text','key','hotkey','drag','move']);
const MODIFIERS: Record<string, number> = {ALT:1,CTRL:2,CONTROL:2,META:4,CMD:4,COMMAND:4,WIN:4,SHIFT:8};
function rendererKey(raw: string): { key: string; code: string; windowsVirtualKeyCode: number; text?: string } {
  const name = raw.toUpperCase().replace(/[ _-]/g,'');
  const known: Record<string, [string,string,number]> = {
    ENTER:['Enter','Enter',13],RETURN:['Enter','Enter',13],TAB:['Tab','Tab',9],ESC:['Escape','Escape',27],ESCAPE:['Escape','Escape',27],
    BACKSPACE:['Backspace','Backspace',8],DELETE:['Delete','Delete',46],DEL:['Delete','Delete',46],INSERT:['Insert','Insert',45],
    LEFT:['ArrowLeft','ArrowLeft',37],ARROWLEFT:['ArrowLeft','ArrowLeft',37],RIGHT:['ArrowRight','ArrowRight',39],ARROWRIGHT:['ArrowRight','ArrowRight',39],
    UP:['ArrowUp','ArrowUp',38],ARROWUP:['ArrowUp','ArrowUp',38],DOWN:['ArrowDown','ArrowDown',40],ARROWDOWN:['ArrowDown','ArrowDown',40],
    HOME:['Home','Home',36],END:['End','End',35],PAGEUP:['PageUp','PageUp',33],PAGEDOWN:['PageDown','PageDown',34],
    SPACE:[' ','Space',32],CTRL:['Control','ControlLeft',17],CONTROL:['Control','ControlLeft',17],ALT:['Alt','AltLeft',18],SHIFT:['Shift','ShiftLeft',16],
    META:['Meta','MetaLeft',91],CMD:['Meta','MetaLeft',91],COMMAND:['Meta','MetaLeft',91],WIN:['Meta','MetaLeft',91],
  };
  const item = known[name];
  if (item) return {key:item[0],code:item[1],windowsVirtualKeyCode:item[2],...(item[0] === 'Enter' ? {text:'\r'} : item[0] === ' ' ? {text:' '} : {})};
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(name)) return {key:name,code:name,windowsVirtualKeyCode:111+Number(name.slice(1))};
  if (raw.length === 1) return {key:raw,code:/[a-z]/i.test(raw)?`Key${raw.toUpperCase()}`:/[0-9]/.test(raw)?`Digit${raw}`:'',windowsVirtualKeyCode:raw.toUpperCase().charCodeAt(0),text:raw};
  throw new Error(`Unsupported renderer key: ${raw}`);
}

/** A DOM automation backend, not a universal no-focus guarantee: page handlers may
 * open windows or request focus. Business and foreground oracles remain separate. */
export class ChromiumCdpAdapter {
  private readonly endpoint: URL;
  private socket?: Socket;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private target?: CdpTarget;
  private snapshot?: Snapshot;
  private uncertain = false;
  private closed = false;

  constructor(endpoint: string) {
    this.endpoint = new URL(endpoint);
    if (!['http:', 'https:'].includes(this.endpoint.protocol) || !['127.0.0.1', '[::1]'].includes(this.endpoint.hostname) ||
        this.endpoint.username || this.endpoint.password || this.endpoint.pathname !== '/' || this.endpoint.search || this.endpoint.hash)
      throw new Error('CDP endpoint must be a literal loopback HTTP origin without credentials, path, query or fragment.');
  }

  close(): void {
    this.closed = true;
    this.invalidate();
    const socket = this.socket; this.socket = undefined;
    socket?.close();
    this.rejectPending(new Error('Chromium adapter closed; fresh observation required.'));
  }
  private invalidate(): void { if (this.snapshot) this.snapshot.valid = false; }
  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  private websocketUrl(target: CdpTarget): string {
    if (!target.webSocketDebuggerUrl) throw new Error('Selected page has no debugger WebSocket.');
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== (this.endpoint.protocol === 'https:' ? 'wss:' : 'ws:') || url.host !== this.endpoint.host ||
        url.username || url.password || url.hash || url.search || !url.pathname.startsWith('/devtools/page/'))
      throw new Error('Debugger WebSocket must remain on the selected loopback origin.');
    return url.href;
  }
  private async targets(signal?: AbortSignal): Promise<CdpTarget[]> {
    cancelled(signal);
    const response = await fetch(new URL('/json/list', this.endpoint), {redirect:'error', signal:AbortSignal.timeout(1500)});
    cancelled(signal);
    if (!response.ok) throw new Error(`CDP target listing failed (${response.status}).`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid CDP target list.');
    return rows.filter((row): row is CdpTarget => row?.type === 'page' && typeof row.id === 'string' && typeof row.url === 'string');
  }
  private select(rows: CdpTarget[], args: Record<string, unknown>): CdpTarget {
    const explicit = ['handle','window','cdpTargetId'].some(key => args[key] !== undefined && args[key] !== '');
    const matches = rows.filter(row => (!args.cdpTargetId || row.id === args.cdpTargetId) &&
      (!args.handle || handleOf(row) === Number(args.handle)) && (!args.window || row.title.toLowerCase().includes(String(args.window).toLowerCase())) &&
      (explicit || !this.target || row.id === this.target.id));
    if (matches.length !== 1) throw new Error(`Chromium page ${matches.length ? 'selection is ambiguous' : 'target not found'}; list_windows and specify an exact handle or cdpTargetId. No first-tab fallback.`);
    return matches[0];
  }
  private async connect(target: CdpTarget, signal?: AbortSignal): Promise<void> {
    const url = this.websocketUrl(target);
    if (this.socket && this.target?.id === target.id) return;
    const old = this.socket; this.socket = undefined; old?.close(); this.invalidate();
    const WebSocketCtor = (globalThis as any).WebSocket;
    if (!WebSocketCtor) throw new Error('Runtime WebSocket unavailable.');
    const socket: Socket = new WebSocketCtor(url); this.socket = socket; this.target = target;
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.method === 'Runtime.executionContextsCleared' || message.method === 'Page.frameNavigated') this.invalidate();
        const item = this.pending.get(message.id); if (!item) return;
        this.pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message || 'CDP command failed.')); else item.resolve(message.result);
      } catch { /* Non-response messages do not settle commands. */ }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined; this.invalidate(); this.rejectPending(new Error('CDP connection closed; observe again.'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timeout.')), TIMEOUT);
        socket.addEventListener('open', () => {clearTimeout(timer); resolve();});
        socket.addEventListener('error', () => {clearTimeout(timer); reject(new Error('CDP WebSocket connection failed.'));});
      });
      cancelled(signal);
      await this.command('Page.enable', {}, signal);
      await this.command('Runtime.enable', {}, signal);
    } catch (error) { if (this.socket === socket) this.socket = undefined; socket.close(); throw error; }
  }
  private async command(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    cancelled(signal);
    if (!this.socket) throw new Error('CDP connection unavailable.');
    const socket = this.socket, id = ++this.sequence;
    // On cancellation, wait for a dispatched command to settle before releasing
    // the scheduler lease. A timeout quarantines this adapter; no blind replay.
    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.uncertain = true; this.invalidate();
        this.rejectPending(new Error(`CDP ${method} timed out; execution may be pending. Adapter quarantined.`));
        this.socket = undefined; socket.close();
      }, TIMEOUT);
      this.pending.set(id, {resolve, reject, timer});
      try { socket.send(JSON.stringify({id, method, params})); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
    cancelled(signal);
    return response;
  }
  private value(result: any): any {
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'CDP evaluation failed.');
    return result?.result?.value;
  }
  private async call(objectId: string, fn: string, args: unknown[], signal?: AbortSignal): Promise<any> {
    return this.value(await this.command('Runtime.callFunctionOn', {objectId, functionDeclaration:fn, arguments:args.map(value=>({value})), returnByValue:true, awaitPromise:true, userGesture:false}, signal));
  }
  private requireSnapshot(args: Record<string, unknown>): Snapshot {
    const s = this.snapshot;
    if (!s || !s.valid || (args.handle && Number(args.handle) !== s.handle) || (args.observationToken && args.observationToken !== s.token))
      throw new Error('Chromium observation is stale or missing; observe again.');
    return s;
  }
  private async valid(signal?: AbortSignal): Promise<boolean> {
    const s = this.snapshot;
    if (!s?.valid) return false;
    try {
      const valid = await this.call(s.objectId, 'function(){return this.valid();}', [], signal);
      if (!valid) this.invalidate(); return valid === true;
    } catch (error) { this.invalidate(); cancelled(signal); return false; }
  }
  private async observe(signal?: AbortSignal): Promise<Snapshot> {
    const previous = this.snapshot; this.snapshot = undefined;
    if (previous) { try { await this.command('Runtime.releaseObject', {objectId:previous.objectId}, signal); } catch { cancelled(signal); } }
    const tree = await this.command('Page.getFrameTree', {}, signal);
    const world = await this.command('Page.createIsolatedWorld', {frameId:tree.frameTree.frame.id, worldName:'IEXA snapshot', grantUniveralAccess:false}, signal);
    const token = randomUUID();
    const remote = await this.command('Runtime.evaluate', {expression:`${CREATE_PAGE_SNAPSHOT}(${JSON.stringify(token)})`, contextId:world.executionContextId, returnByValue:false, userGesture:false}, signal);
    if (remote.exceptionDetails || !remote.result?.objectId) throw new Error('Chromium observation context was not created.');
    const objectId = remote.result.objectId;
    try {
    const info: PageInfo = await this.call(objectId, 'function(){return this.info;}', [], signal);
    const shot = await this.command('Page.captureScreenshot', {format:'png', fromSurface:true}, signal);
    // Capture checks document/viewport continuity. Individual controls are
    // revalidated in the isolated world immediately before their own input;
    // unrelated streaming text must not make the entire page unobservable.
    if (!shot.data || !await this.call(objectId, 'function(){return this.valid();}', [], signal))
      throw new Error('Chromium page changed during capture; observe again.');
    const frame = Buffer.from(shot.data,'base64');
    if (frame.length < 24 || frame.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid Chromium screenshot.');
    const snapshot: Snapshot = {targetId:this.target!.id, handle:handleOf(this.target!), token, objectId, capturedAt:Date.now(), info, frame, valid:true};
    this.snapshot = snapshot; return snapshot;
    } catch (error) {
      if (this.socket && !this.uncertain) { try { await this.command('Runtime.releaseObject', {objectId}); } catch {} }
      throw error;
    }
  }
  private async keyboard(keys: string[], count: number, signal?: AbortSignal): Promise<void> {
    const mapped = keys.map(rendererKey);
    for (let repeat=0;repeat<count;repeat++) {
      let modifiers = 0; const pressed: typeof mapped = [];
      try {
        for (let i=0;i<mapped.length;i++) {
          const key=mapped[i], bit=MODIFIERS[keys[i].toUpperCase()]; if (bit) modifiers |= bit;
          pressed.push(key);
          const text = !(modifiers & 7) ? key.text : undefined;
          await this.command('Input.dispatchKeyEvent',{type:text?'keyDown':'rawKeyDown',key:key.key,code:key.code,windowsVirtualKeyCode:key.windowsVirtualKeyCode,modifiers,...(text?{text,unmodifiedText:key.text}:{})},signal);
        }
      } finally {
        for (const key of pressed.reverse()) {
          const bit = key.key==='Alt'?1:key.key==='Control'?2:key.key==='Meta'?4:key.key==='Shift'?8:0; modifiers &= ~bit;
          if (this.socket && !this.uncertain) await this.command('Input.dispatchKeyEvent',{type:'keyUp',key:key.key,code:key.code,windowsVirtualKeyCode:key.windowsVirtualKeyCode,modifiers});
        }
      }
    }
  }
  private async rendererInput(s: Snapshot, element: any, action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    if (!element?.id) throw new Error('Renderer input needs an observed enabled target; key/hotkey may use an observed focused control.');
    const count = args.count === undefined ? 1 : Number(args.count);
    if (!Number.isInteger(count)||count<1||count>50) throw new Error('Renderer repeat count must be from 1 to 50.');
    if (['key','hotkey'].includes(action)) {
      const keys = action==='key' ? [args.key] : args.keys;
      if (!Array.isArray(keys)||!keys.length||keys.some(key=>typeof key!=='string'||!key)) throw new Error('Renderer keys must be a nonempty string array.');
      keys.forEach(key=>rendererKey(String(key)));
      const names = keys.map(key=>String(key).toUpperCase());
      if (args.allowClose!==true && (names.includes('ALT')&&names.includes('F4') || names.some(key=>['CTRL','CONTROL','META','CMD','COMMAND','WIN'].includes(key))&&names.includes('W')))
        throw new Error('Closing hotkeys require allowClose=true.');
      await this.call(s.objectId,'function(id){return this.prepare(id,"keyInput");}',[element.id],signal);
      await this.keyboard(keys as string[],count,signal);
    } else if (action==='insert_text'||action==='type_element') {
      if (typeof args.text!=='string') throw new Error('Renderer text input requires text.');
      const capability = element.capabilities?.includes('textInput') ? 'textInput' : 'keyInput';
      if (!element.capabilities?.some((cap:string)=>['textInput','textValue'].includes(cap))) throw new Error('Observed target is not a writable text input.');
      const prepared = await this.call(s.objectId,'function(id,cap){return this.prepare(id,cap);}',[element.id,capability],signal);
      if (action==='type_element' ? args.replace!==false : args.replace===true) await this.keyboard(['CTRL','a'],1,signal);
      // Monaco interprets insertText character by character, adding paired
      // brackets and splitting undo groups. Let its own paste handler consume
      // bulk text; this changes neither editor models nor the system clipboard.
      if (prepared.editorPaste === true && args.text.length > 1) {
        return this.call(s.objectId,'function(id,text){return this.paste(id,text);}',[element.id,args.text],signal);
      }
      await this.command('Input.insertText',{text:args.text},signal);
    } else {
      const b=element.bounds;
      if (!b) throw new Error('Renderer pointer target has no observed bounds.');
      const point=(x:unknown,y:unknown,defaultX:number,defaultY:number)=>({x:x===undefined?defaultX:Number(x),y:y===undefined?defaultY:Number(y)});
      const start=point(args.relativeX??args.x,args.relativeY??args.y,b.left+b.width/2,b.top+b.height/2);
      const end=action==='drag'?point(args.toRelativeX??args.toX,args.toRelativeY??args.toY,NaN,NaN):start;
      if (![start.x,start.y,end.x,end.y].every(Number.isFinite)||end.x<0||end.y<0||end.x>=s.info.width||end.y>=s.info.height) throw new Error('Renderer pointer coordinates must be inside the observed viewport.');
      const button=String(args.button||'left');if(!['left','right','middle'].includes(button))throw new Error('Invalid renderer mouse button.');
      await this.call(s.objectId,'function(id,point){return this.prepare(id,"rendererPointer",point);}',[element.id,start],signal);
      await this.command('Input.dispatchMouseEvent',{type:'mouseMoved',...start,button:'none'},signal);
      if (action!=='move') {
        const buttons=button==='left'?1:button==='right'?2:4;let pressed=false;
        try {
          for(let click=1;click<=(action==='drag'?1:count);click++) {
            pressed=true;await this.command('Input.dispatchMouseEvent',{type:'mousePressed',...start,button,buttons,clickCount:click},signal);
            if(action==='drag') {
              for(let i=1;i<=8;i++)await this.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+(end.x-start.x)*i/8,y:start.y+(end.y-start.y)*i/8,button,buttons},signal);
            }
            await this.command('Input.dispatchMouseEvent',{type:'mouseReleased',...end,button,buttons:0,clickCount:click},signal);pressed=false;
          }
        } finally {
          if(pressed&&this.socket&&!this.uncertain)await this.command('Input.dispatchMouseEvent',{type:'mouseReleased',...end,button,buttons:0,clickCount:1});
        }
      }
    }
    return {method:`cdp_renderer_${action}`,inputMechanism:'cdp-renderer'};
  }
  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const started = Date.now(), action = String(args.action || 'observe');
    try {
      cancelled(signal);
      if (this.closed || this.uncertain) throw new Error('CDP adapter is closed/quarantined; pending effects require external verification.');
      const rows = await this.targets(signal);
      if (action === 'list_windows') return this.result(action, {windows:rows.map(t=>({handle:handleOf(t),pid:0,title:t.title,process:'chromium',cdpTargetId:t.id,url:t.url}))}, started);
      const target = this.select(rows, args);
      if (this.target && target.id !== this.target.id && !['observe','bind_window'].includes(action)) throw new Error('CDP target changed; explicitly observe the new target.');
      await this.connect(target, signal);
      if (action === 'bind_window') {
        this.invalidate();
        return this.result(action, {window:{handle:handleOf(target),pid:0,title:target.title,process:'chromium'}}, started);
      }
      if (action === 'observe') {
        const s = await this.observe(signal);
        return this.result(action, {session:{handle:s.handle,observationToken:s.token,foreground:false},foreground:{handle:s.handle,title:s.info.title,process:'chromium',pid:0},
          frame:{hash:createHash('sha256').update(s.frame).digest('hex'),width:s.frame.readUInt32BE(16),height:s.frame.readUInt32BE(20),capturedAt:s.capturedAt,foreground:false,trust:'background-window-rendered'},elements:s.info.elements,truncated:s.info.truncated,candidateCount:s.info.candidateCount}, started, s.frame);
      }
      if (action === 'session_state') {
        const valid = await this.valid(signal);
        return this.result(action,{bound:true,handle:handleOf(target),pid:0,foreground:false,observationToken:valid ? this.snapshot?.token : '',geometryChanged:!valid},started);
      }
      const s = this.requireSnapshot(args);
      if (!await this.valid(signal)) throw new Error('Chromium observation is stale: node, document, value or geometry changed.');
      if (action === 'frame') return this.result(action,{bytes:s.frame.length,observationToken:s.token,capturedAt:s.capturedAt},started,s.frame);
      if (action === 'find_element') return this.result(action,{elements:s.info.elements.filter(e=>(!args.text||e.text.includes(String(args.text)))&&(!args.role||e.role===args.role)&&(!args.elementId||e.id===args.elementId))},started);
      if (action === 'wait') {
        const deadline = Date.now() + Math.max(100, Math.min(60000, Number(args.timeoutMs)||5000));
        while (Date.now() < deadline) {
          cancelled(signal);
          const tree = await this.command('Page.getFrameTree',{},signal);
          const world = await this.command('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'IEXA snapshot'},signal);
          const found = this.value(await this.command('Runtime.evaluate',{expression:`document.body?.innerText?.includes(${JSON.stringify(String(args.text||''))})`,contextId:world.executionContextId,returnByValue:true},signal));
          if (found) return this.result(action,{found:true},started);
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        return {...this.result(action,{found:false},started),success:false};
      }
      if (!INPUT_ACTIONS.has(action) || args.background !== true || args.forcePointer === true || args.autoActivate === true)
        throw new Error('CDP input requires background observed-node input; no physical or activation fallback.');
      if (args.observationToken !== s.token) throw new Error('CDP input needs the current observation token.');
      if (args.rendererInput !== undefined && typeof args.rendererInput !== 'boolean') throw new Error('rendererInput must be a boolean.');
      if (args.rendererInput === true && action !== 'click_element') throw new Error('rendererInput is an explicit CDP click option.');
      let element = s.info.elements.find(e=>e.id===String(args.elementId||''));
      if (!element && !args.elementId && ['key','hotkey'].includes(action)) {
        const focused=s.info.elements.filter(e=>e.focused&&e.capabilities?.includes('keyInput'));
        // A wrapper and its focused textarea represent the same keyboard surface.
        element=focused.find(e=>['edit','combobox'].includes(e.role)) || (focused.length===1?focused[0]:undefined);
      }
      if (!element && !args.elementId && action==='scroll') {
        const scrollers=s.info.elements.filter(e=>e.capabilities?.includes('scroll')&&e.selector?.name==='Page scroll');
        if(scrollers.length===1)element=scrollers[0];
      }
      if (!element || element.enabled===false || !element.selector) throw new Error('CDP input requires an observed enabled actual-node target.');
      this.invalidate();
      const renderer=['key','hotkey','insert_text','drag','move'].includes(action) || action==='type_element'&&element.capabilities?.includes('textInput') || action==='click_element'&&(args.rendererInput===true||!element.capabilities?.includes('invoke')||args.button&&args.button!=='left'||Number(args.count||1)!==1);
      const result = renderer ? await this.rendererInput(s,element,action,args,signal)
        : await this.call(s.objectId,'function(id,action,text,replace,options){return this.apply(id,action,text,replace,options);}',[element.id,action,String(args.text||''),args.replace!==false,{value:args.value,delta:args.delta,deltaX:args.deltaX,deltaY:args.deltaY}],signal);
      // Verification observes asynchronous effects, never resends the action.
      if (args.verifyText) {
        const deadline = Date.now() + Math.max(100,Math.min(5000,Number(args.timeoutMs)||1500));
        while (Date.now()<deadline) {
          const verified = await this.call(s.objectId, 'function(text){return document.body?.innerText?.includes(text) || Array.from(document.querySelectorAll("input:not([type=password]),textarea")).some(e=>e.value.includes(text));}', [String(args.verifyText)], signal);
          if (verified) break;
          await new Promise(resolve=>setTimeout(resolve,50));
        }
      }
      return this.result(action,{...result,backgroundApplied:true,foregroundVerified:false},started);
    } catch (error) {
      this.invalidate();
      return {output:(error as Error).message,success:false,cancelled:signal?.aborted||undefined,durationMs:Date.now()-started,metadata:{backend:'chromium-cdp',action}};
    }
  }
  private result(action:string,data:unknown,started:number,frame?:Buffer):ToolExecutionResult {
    return {output:JSON.stringify({ok:true,action,data}),success:true,durationMs:Date.now()-started,...(frame?{imageData:frame,imageMimeType:'image/png'}:{}),metadata:{backend:'chromium-cdp',action,cdpTargetId:this.target?.id}};
  }
}
