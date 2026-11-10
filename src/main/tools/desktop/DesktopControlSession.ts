import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ToolExecutionResult } from '../../providers/types';
import { DesktopControlScheduler, desktopControlScheduler } from './DesktopControlScheduler';
import { DesktopElement, DesktopTarget, resolveDesktopTarget, resolveDesktopWindow } from './DesktopTargetResolver';
import { DesktopRecoveryState, readDesktopRecovery, appendDesktopRecoveryEvent } from './DesktopRecoveryJournal';

export type DesktopPhase = 'queued' | 'observe' | 'resolve' | 'action_start' | 'action_end' | 'verify' | 'completed' | 'failed' | 'takeover' | 'cancelled';
export interface DesktopControlStatus { mode: string; backend: string; focusPolicy: string; capability: string; physicalInput: boolean; providerMayChangeFocus: boolean; noForegroundFallback: boolean; }
export interface DesktopEvent { version: 1; operationId: string; sequence: number; phase: DesktopPhase; timestamp: number; action: string; verified?: boolean; step?: number; totalSteps?: number; dispatchedActions?: number; completedSteps?: number; inputMayHaveExecuted?: boolean; control?: DesktopControlStatus; }
export interface DesktopContext { owner: string; operationId?: string; onEvent?: (event: DesktopEvent) => void; }
interface Snapshot { observationToken: string; capturedAt: number; handle: number; elements: DesktopElement[]; nativeInstanceNonce?: string; frameHash?: string; captureTrust?: string; cdpTargetId?: string; }
interface PointerFallbackGrant { observationToken: string; handle: number; elementId: string; }
interface OwnerState { snapshot?: Snapshot; observationLimit?: number; needsObservation: boolean; controlMode?: 'background' | 'foreground'; backendContext?: { backend?: unknown; cdpEndpoint?: unknown; cdpTargetId?: unknown }; focusPolicy?: 'stop' | 'wait' | 'activate'; focusWaitMs?: number; recovered?: DesktopRecoveryState; pointerFallback?: PointerFallbackGrant; identity?: { pid: number; process: string; window: string }; }
type Transport = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolExecutionResult>;
const inputActions = new Set(['move', 'click', 'drag', 'click_element', 'type', 'type_element', 'key', 'hotkey', 'scroll', 'select_option', 'set_value', 'insert_text']);
const cdpOnlyActions = new Set(['select_option', 'set_value', 'insert_text']);
const bindingActions = new Set(['launch', 'activate', 'bind_window']);
const passiveActions = new Set(['list_windows', 'observe', 'frame', 'session_state', 'find_element', 'read_focused', 'wait', 'wait_change']);

// Input already performs a fresh observation. Return a bounded view of that
// same snapshot so the model can act on the resulting UI instead of guessing
// from the pre-action controls or making another identical UIA request.
function postObservationSummary(snapshot: Snapshot, data: Record<string, any>) {
  const priority = (element: DesktopElement) => {
    if (element.focused === true) return 0;
    if (['edit', 'combobox', 'textbox', 'searchbox'].includes(element.role.toLowerCase())) return 1;
    if (['listitem', 'dataitem', 'treeitem', 'tabitem'].includes(element.role.toLowerCase())) return 2;
    if (['button', 'link', 'hyperlink', 'menuitem', 'checkbox', 'radiobutton'].includes(element.role.toLowerCase())) return 3;
    return 4;
  };
  const elements = snapshot.elements.map((element, index) => ({ element, index }))
    .sort((a, b) => priority(a.element) - priority(b.element) || a.index - b.index)
    .slice(0, 40).map(({ element }) => {
      const text = String(element.text || ''), bounds = element.bounds;
      const selectorName = String(element.selector?.name || '');
      return {
        id: element.id, role: element.role, text: text.slice(0, 160),
        ...(text.length > 160 ? { textTruncated: true } : {}),
        enabled: element.enabled, focused: element.focused,
        checked: element.checked, expanded: element.expanded,
        source: element.source, confidence: element.confidence,
        ...(bounds ? { bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
          centerX: bounds.left + bounds.width / 2, centerY: bounds.top + bounds.height / 2 } } : {}),
        // IDs remain exact and address the full current cached selector, including
        // Win32 menu selectors. A shortened display name is never a new selector.
        ...(element.selector ? { selector: { automationId: element.selector.automationId,
          controlType: element.selector.controlType, name: selectorName.slice(0, 160),
          ...(selectorName.length > 160 ? { nameTruncated: true } : {}) } } : {}),
        ...(element.capabilities ? { capabilities: element.capabilities.slice(0, 12) } : {}),
      };
    });
  const foreground = data.foreground;
  return { observationToken: snapshot.observationToken, handle: snapshot.handle, frameHash: snapshot.frameHash,
    capturedAt: snapshot.capturedAt, captureTrust: snapshot.captureTrust,
    ...(Number(foreground?.handle) === snapshot.handle ? { window: { handle: snapshot.handle,
      title: String(foreground.title || '').slice(0, 160), process: String(foreground.process || '').slice(0, 80), pid: foreground.pid } } : {}),
    totalElements: snapshot.elements.length, returnedElements: elements.length,
    truncated: snapshot.elements.length > elements.length, elements,
    guidance: 'These are fresh post-action controls, not proof of business success. Use the exact element id with this observationToken. If the target is absent or text is truncated, observe/read_focused before further input; do not replay the previous action.',
  };
}

function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error('Desktop operation lease revoked.')); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error('Desktop operation lease revoked.')); };
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function hasCoordinatePair(step: Record<string, unknown>, prefix = ''): boolean {
  const x = prefix ? `to${prefix}X` : 'x'; const y = prefix ? `to${prefix}Y` : 'y';
  const relativeX = prefix ? `toRelative${prefix}X` : 'relativeX'; const relativeY = prefix ? `toRelative${prefix}Y` : 'relativeY';
  return (step[x] !== undefined && step[y] !== undefined) || (step[relativeX] !== undefined && step[relativeY] !== undefined);
}

function validateExpectedWindowClose(step: Record<string, unknown>, background: boolean, cdp: boolean, cdpTargetId?: unknown): void {
  if (step.expectWindowClosed !== undefined && typeof step.expectWindowClosed !== 'boolean') throw new Error('expectWindowClosed must be a boolean.');
  if (step.expectWindowClosed !== true) return;
  if ((!cdp&&background) || !['click','click_element','key','hotkey'].includes(String(step.action))) throw new Error('expectWindowClosed requires a foreground native or exact Chromium target click/key/hotkey action.');
  if (cdp && (typeof cdpTargetId!=='string'||!cdpTargetId.trim())) throw new Error('expectWindowClosed requires the exact observed cdpTargetId; observe that target first.');
  if (step.verifyText) throw new Error('Window closure and text verification require separate observations; verify business text after explicitly observing the remaining window.');
}

function validateRendererInput(step: Record<string, unknown>, cdp: boolean): void {
  if (step.rendererInput !== undefined && typeof step.rendererInput !== 'boolean') throw new Error('rendererInput must be a boolean.');
  if (step.rendererInput === true && (!cdp || !['click','click_element'].includes(String(step.action)))) throw new Error('rendererInput requires a chromium-cdp click action; no native physical fallback.');
}

function rejectInternalModalFollow(step: Record<string, unknown>): void {
  if (step.followOwnedModal !== undefined) throw new Error('followOwnedModal is an internal post-action verification field; it cannot be supplied as a desktop action argument.');
  if (step.expectedNativeInstanceNonce !== undefined) throw new Error('expectedNativeInstanceNonce is an internal transport field.');
}

function validateHotkeyCount(step: Record<string, unknown>): void {
  if (step.action !== 'hotkey' || step.count === undefined) return;
  if (typeof step.count !== 'number' || !Number.isInteger(step.count) || step.count < 1 || step.count > 50)
    throw new Error('hotkey count must be an integer from 1 to 50.');
}

function validateBatchStep(step: Record<string, unknown>, inheritedBackground: boolean, cdp = false, cdpTargetId?: unknown): void {
  rejectInternalModalFollow(step);
  validateHotkeyCount(step);
  const action = String(step.action || '');
  if (!inputActions.has(action)) throw new Error('Managed batches accept input actions only; observe/bind separately.');
  if (step.autoActivate === true) throw new Error('Use explicit activate; autoActivate is disabled in managed control.');
  if (step.controlMode !== undefined && step.controlMode !== 'background' && step.controlMode !== 'foreground') throw new Error('controlMode must be background or foreground.');
  if (step.background !== undefined && typeof step.background !== 'boolean') throw new Error('background must be a boolean.');
  if (step.controlMode !== undefined && step.background !== undefined && (step.controlMode === 'background') !== step.background) throw new Error('controlMode and background disagree; no desktop action dispatched.');
  const background = inheritedBackground || step.background === true || step.controlMode === 'background';
  validateExpectedWindowClose(step, background, cdp, cdpTargetId);
  validateRendererInput(step, cdp);
  if (inheritedBackground && (step.background === false || step.controlMode === 'foreground')) throw new Error('A background batch cannot switch to foreground input. Select foreground mode in a separate operation.');
  if (background && step.forcePointer === true) throw new Error('Background mode forbids physical pointer fallback.');
  if (!cdp && cdpOnlyActions.has(action)) throw new Error('This component action requires the chromium-cdp backend.');
  if (background && !cdp && !['click_element', 'type_element', 'click', 'type'].includes(action)) throw new Error('Background mode supports semantic UIA click/type only.');
  if (['move', 'drag'].includes(action) && !hasCoordinatePair(step) && !(cdp && (step.target || step.elementId))) throw new Error(`${action} requires a complete coordinate pair.`);
  if (action === 'drag' && !((step.toX !== undefined && step.toY !== undefined) || (step.toRelativeX !== undefined && step.toRelativeY !== undefined))) throw new Error('drag requires a complete destination coordinate pair.');
  if (['click_element', 'type_element'].includes(action) && !step.target && !step.elementId) throw new Error(`${action} requires target or elementId.`);
  if (['type', 'type_element', 'insert_text'].includes(action) && typeof step.text !== 'string') throw new Error(`${action} requires text.`);
  if (action === 'select_option' && step.value === undefined && typeof step.text !== 'string') throw new Error('select_option requires value or an exact option label in text.');
  if (action === 'set_value' && step.value === undefined && typeof step.text !== 'string') throw new Error('set_value requires value.');
  if (action === 'key' && typeof step.key !== 'string') throw new Error('key requires key.');
  if (action === 'hotkey' && (!Array.isArray(step.keys) || !step.keys.length || step.keys.some(key => typeof key !== 'string'))) throw new Error('hotkey requires a nonempty string keys array.');
  if (background && !step.target && !step.elementId && !(cdp && ['key','hotkey','scroll'].includes(action))) throw new Error('Background input requires a semantic target.');
}

/** Control plane. Snapshots are process-local capabilities, never replayed from disk.
 * Journal stores phases only: no typed text, screenshots, element names or secrets. */
export class DesktopControlSession {
  private owners = new Map<string, OwnerState>();
  /** A new model run gets no reusable input capability. The durable journal remains available for recovery diagnostics. */
  reset(): void { this.owners.clear(); }
  constructor(private readonly transport: Transport, private readonly scheduler: DesktopControlScheduler = desktopControlScheduler, private readonly journalDir?: string) {}
  private journalPath(owner: string): string | undefined {
    return this.journalDir ? path.join(this.journalDir, createHash('sha256').update(owner).digest('hex') + '.jsonl') : undefined;
  }
  private recover(owner: string): OwnerState['recovered'] {
    return readDesktopRecovery(this.journalPath(owner));
  }
  async execute(args: Record<string, unknown>, signal: AbortSignal | undefined, context: DesktopContext): Promise<ToolExecutionResult> {
    const started = Date.now();
    const operationId = context.operationId || randomUUID();
    const action = String(args.action || 'observe');
    const events: DesktopEvent[] = [];
    let phase: DesktopPhase = 'queued'; let verified = false; let verificationMethod = 'not_requested';
    let stepIndex: number | undefined; let completedSteps = 0; let dispatchedActions = 0; let acknowledgedActions = 0; let postObservationError: string | undefined;
    let foregroundRecovery: Record<string, unknown> | undefined;
    let helperRecovery: Record<string, unknown> | undefined;
    let transportActualForeground: unknown;
    const totalSteps = action === 'batch' && Array.isArray(args.actions) ? args.actions.length : undefined;
    let stepAction = action;
    let state = this.owners.get(context.owner);
    if (!state) { state = { needsObservation: true }; this.owners.set(context.owner, state); }
    const owner = state;
    const controlStatus = () => ({
      mode: owner.controlMode ?? 'background',
      backend: typeof owner.backendContext?.backend === 'string' ? owner.backendContext.backend : owner.backendContext?.cdpEndpoint ? 'chromium-cdp' : 'native',
      focusPolicy: owner.focusPolicy ?? 'stop',
      capability: owner.backendContext?.backend === 'native-isolated' ? 'isolated-semantic'
        : owner.backendContext?.backend === 'chromium-cdp' || owner.backendContext?.cdpEndpoint ? 'browser-dom'
        : owner.controlMode === 'foreground' ? 'foreground-input' : 'uia-provider-semantic',
      physicalInput: owner.controlMode === 'foreground',
      providerMayChangeFocus: owner.controlMode !== 'foreground' && owner.backendContext?.backend !== 'native-isolated',
      noForegroundFallback: true,
    });
    const emit = (next: DesktopPhase) => {
      phase = next;
      const event: DesktopEvent = { version: 1, operationId, sequence: events.length + 1, phase, timestamp: Date.now(), action: stepAction, ...(next === 'queued' ? {} : { control: controlStatus() }), dispatchedActions, completedSteps, inputMayHaveExecuted: dispatchedActions > 0, ...(stepIndex ? { step: stepIndex, totalSteps } : {}), ...(phase === 'verify' || phase === 'completed' ? { verified } : {}) };
      // A failed journal write blocks the next action rather than silently losing evidence.
      if (this.journalDir) {
        fs.mkdirSync(this.journalDir, { recursive: true });
        appendDesktopRecoveryEvent(this.journalPath(context.owner)!, event);
      }
      events.push(event);
      try { context.onEvent?.(event); } catch { /* UI observers do not own control. */ }
    };
    let leaseAborted = false;
    try {
      if (!owner.snapshot && !owner.recovered) owner.recovered = this.recover(context.owner);
      emit('queued');
      const result = await this.scheduler.run(context.owner, operationId, signal, async lease => {
        rejectInternalModalFollow(args);
        if (args.controlMode !== undefined && args.controlMode !== 'background' && args.controlMode !== 'foreground') throw new Error('controlMode must be background or foreground.');
        if (args.backend !== undefined && (typeof args.backend !== 'string' || !['native', 'native-isolated', 'chromium-cdp'].includes(args.backend))) throw new Error('Unknown desktop backend; no implicit native fallback.');
        if (args.background !== undefined && typeof args.background !== 'boolean') throw new Error('background must be a boolean.');
        if (args.controlMode !== undefined && args.background !== undefined && (args.controlMode === 'background') !== args.background) throw new Error('controlMode and background disagree; no desktop action dispatched.');
        if (args.focusPolicy !== undefined) {
          if (args.focusPolicy !== 'stop' && args.focusPolicy !== 'wait' && args.focusPolicy !== 'activate') throw new Error('focusPolicy must be stop, wait or activate.');
          owner.focusPolicy = args.focusPolicy;
        }
        if (args.focusWaitMs !== undefined) {
          const waitMs = Number(args.focusWaitMs);
          if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 60_000) throw new Error('focusWaitMs must be an integer from 1 to 60000.');
          owner.focusWaitMs = waitMs;
        }
        if (args.controlMode !== undefined) owner.controlMode = args.controlMode;
        else if (typeof args.background === 'boolean') owner.controlMode = args.background ? 'background' : 'foreground';
        owner.controlMode ??= 'background';
        // A new background app must be launched on its own desktop. Existing
        // windows stay on their current desktop; never move or activate them.
        const launchIsolated = action === 'launch' && owner.controlMode === 'background' && !owner.identity && args.backend === undefined && args.cdpEndpoint === undefined && !owner.backendContext?.backend && !owner.backendContext?.cdpEndpoint;
        if (launchIsolated || args.backend !== undefined || args.cdpEndpoint !== undefined || args.cdpTargetId !== undefined) {
          const next = { ...owner.backendContext, ...(launchIsolated ? {backend:'native-isolated'} : {}), ...(args.backend !== undefined ? {backend:args.backend} : {}), ...(args.cdpEndpoint !== undefined ? {cdpEndpoint:args.cdpEndpoint} : {}), ...(args.cdpTargetId !== undefined ? {cdpTargetId:args.cdpTargetId} : {}) };
          if (next.backend === 'native' || next.backend === 'native-isolated') { delete next.cdpEndpoint; delete next.cdpTargetId; }
          if (JSON.stringify(next) !== JSON.stringify(owner.backendContext)) { owner.snapshot = undefined; owner.identity = undefined; owner.pointerFallback = undefined; owner.needsObservation = true; }
          owner.backendContext = next;
        }
        const transportContext = owner.backendContext || {};
        const cdp = transportContext.backend === 'chromium-cdp' || !!transportContext.cdpEndpoint;
        if (transportContext.backend === 'native-isolated' || transportContext.backend === 'chromium-cdp' || transportContext.cdpEndpoint) {
          if (args.controlMode === 'foreground' || args.background === false) throw new Error('Selected backend requires background operations; no foreground fallback.');
          owner.controlMode = 'background';
        }
        const operationBackground = owner.controlMode === 'background';
        const call = async (payload: Record<string, unknown>, transportSignal = lease.signal): Promise<{ result: ToolExecutionResult; data: any }> => {
          if (lease.signal.aborted) { leaseAborted = true; throw new Error(lease.signal.reason instanceof Error ? lease.signal.reason.message : 'Desktop control cancelled.'); }
          const result = await this.transport({ ...payload, ...transportContext, background: payload.background ?? operationBackground, detail: 'raw' }, transportSignal);
          if (lease.signal.aborted) { leaseAborted = true; throw new Error(lease.signal.reason instanceof Error ? lease.signal.reason.message : 'Desktop control cancelled.'); }
          if (!result.success) {
            if (payload.expectedNativeInstanceNonce && result.metadata?.noInputDispatched === true && result.metadata?.helperRestarted === true)
              dispatchedActions = Math.max(0, dispatchedActions - 1);
            try { const failure = JSON.parse(result.output); transportActualForeground = failure.actualForeground || failure.data?.actualForeground; } catch { /* Preserve original error. */ }
            throw new Error(result.output);
          }
          let body: any; try { body = JSON.parse(result.output); } catch { throw new Error('Desktop transport returned invalid JSON.'); }
          return { result, data: body.data || body };
        };
        const resolveWindow = async (options: Record<string, unknown>) => {
          const target = { handle: options.handle, pid: options.pid, window: options.window, process: options.process };
          const { data } = await call({ action: 'list_windows', ...(target.handle !== undefined ? { handle: target.handle } : {}), window: target.window, process: target.process, pid: target.pid, includeHidden: true, limit: 100 });
          return resolveDesktopWindow(target, (data.windows || []).filter((window: any) => !transportContext.cdpTargetId || window.cdpTargetId === transportContext.cdpTargetId));
        };
        const observe = async (options: Record<string, unknown> = {}) => {
          emit('observe');
          // Native collection and the 40-element display summary have separate
          // budgets. A post-input refresh must not discard previously observed
          // controls just because it omitted the caller's explicit limit.
          if (!cdp) {
            const explicitLimit = options.limit;
            if (explicitLimit !== undefined && (typeof explicitLimit !== 'number' || !Number.isInteger(explicitLimit) || explicitLimit < 1))
              throw new Error('Native observe limit must be a positive integer.');
            const limit = explicitLimit === undefined ? owner.observationLimit ?? 100 : Math.min(200, explicitLimit as number);
            options = { ...options, limit };
            owner.observationLimit = Math.max(owner.observationLimit ?? 100, limit);
          }
          if (options.handle || options.pid || options.window || options.process) {
            const target = await resolveWindow(options);
            options = { ...options, handle: target.handle };
            owner.identity = { pid: target.pid, process: target.process, window: target.title };
          }
          let response: Awaited<ReturnType<typeof call>> | undefined;
          // Screenshot/DOM coherence can race streaming UI updates. Retry only
          // this read operation; input dispatch is outside this loop.
          for (let attempt=0;attempt<(cdp?3:1);attempt++) {
            try { response = await call({ ...options, action: 'observe', captureFrame: options.captureFrame }); break; }
            catch (error) {
              if (!cdp || !/Chromium page changed during capture/i.test((error as Error).message) || attempt===2 || lease.signal.aborted) throw error;
              await delayWithSignal(100, lease.signal);
            }
          }
          if (!response) throw new Error('Desktop observation did not return a snapshot.');
          const data = response.data;
          if (options.handle && Number(data.session?.handle) !== Number(options.handle)) throw new Error('Observed window changed during capture. No input dispatched; observe your target again.');
          if (!data.session?.observationToken || !Number(data.session.handle)) throw new Error('Observation is missing a bound window or token.');
          owner.snapshot = { observationToken: data.session.observationToken, capturedAt: Date.now(), handle: Number(data.session.handle), elements: (data.elements || []).filter((element: DesktopElement) => data.frame?.trust === 'foreground' || element.source !== 'ocr'), frameHash: data.frame?.hash, captureTrust: data.frame?.trust || 'unknown', ...(cdp ? {cdpTargetId:typeof response.result.metadata?.cdpTargetId==='string'?response.result.metadata.cdpTargetId:typeof transportContext.cdpTargetId==='string'?transportContext.cdpTargetId:undefined} : {}) };
          if (!cdp && typeof response.result.metadata?.nativeInstanceNonce === 'string') owner.snapshot.nativeInstanceNonce = response.result.metadata.nativeInstanceNonce;
          owner.pointerFallback = undefined;
          owner.needsObservation = false;
          // Remember which process owns this window so a re-created handle can be
          // found again without asking the user to start over.
          if (!owner.identity) {
            try {
              const { data: listed } = await call({ action: 'list_windows', includeHidden: true, limit: 100 });
              const match = (listed.windows || []).find((window: any) => Number(window.handle) === Number(data.session.handle));
              if (match) owner.identity = { pid: Number(match.pid), process: String(match.process || ''), window: String(match.title || '') };
            } catch { /* identity is an optimisation; ownership checks still protect input. */ }
          }
          return response;
        };
        // Background is sticky for the owner, including recovery and internal
        // observations. Foreground focus reclamation always requires opt-in.
        const focusPolicy = () => owner.focusPolicy ?? 'stop';
        const reacquire = async (background: boolean) => {
          const identity = owner.identity;
          if (!identity) return false;
          const { data } = await call({ action: 'list_windows', includeHidden: false, limit: 100, pid: identity.pid || undefined, process: identity.process || undefined });
          const windows: any[] = (data.windows || []).filter((window: any) => Number(window.pid) === Number(identity.pid));
          const chosen = windows.find((window: any) => String(window.title || '') === identity.window)
            || (windows.length === 1 ? windows[0] : undefined);
          if (!chosen) return false;
          if (!background) await call({ action: 'activate', handle: chosen.handle, background: false });
          await observe({ handle: chosen.handle, background });
          return true;
        };
        const checkOwnership = async (background = operationBackground, pendingStep?: Record<string, unknown>) => {
          if (!owner.snapshot || owner.needsObservation) throw new Error('Fresh observe is required for this session before input; recovery never replays actions.');
          const policy = focusPolicy();
          const stateResponse = await call({ action: 'session_state' });
          let { data } = stateResponse;
          const previous = owner.snapshot;
          const nextNonce = stateResponse.result.metadata?.nativeInstanceNonce;
          if (!cdp && previous.nativeInstanceNonce && typeof nextNonce === 'string' && previous.nativeInstanceNonce !== nextNonce) {
            owner.snapshot = undefined; owner.needsObservation = true; owner.pointerFallback = undefined;
            helperRecovery = { reason:'native_helper_restarted', previousHandle:previous.handle, identityVerified:false, inputReplayed:false };
            const {data:listed} = await call({action:'list_windows',handle:previous.handle,includeHidden:true,limit:1});
            const identity=owner.identity, windows=listed.windows;
            const exact=Array.isArray(windows)&&windows.length===1?windows[0]:undefined;
            if (!identity || !exact || Number(exact.handle)!==previous.handle || Number(exact.pid)!==identity.pid
              || String(exact.process||'')!==identity.process || String(exact.title||'')!==identity.window)
              throw new Error('Desktop helper restarted; the original window identity could not be verified. List windows and explicitly observe the intended target. No input dispatched.');
            helperRecovery.identityVerified=true;
            helperRecovery.nextObservation={action:'observe',handle:previous.handle};
            const target=pendingStep?.target as DesktopTarget | undefined;
            const mayResolveFresh=!!pendingStep && ['click','click_element','type','type_element'].includes(String(pendingStep.action))
              && Date.now()-previous.capturedAt <= 60_000
              && !!target && !target.elementId && (!!target.automationId || !!target.name) && !pendingStep.elementId
              && !pendingStep.observationToken && !pendingStep.forcePointer
              && !['x','y','relativeX','relativeY','toX','toY'].some(key=>pendingStep[key]!==undefined);
            if (!mayResolveFresh) throw new Error('Desktop helper restarted after idle release. Fresh observe is required for this exact window; old IDs, coordinates, keyboard focus and tokens are not replayed. For long model turns, use a fresh semantic automationId/name target instead of stale element IDs. No input dispatched.');
            await observe({handle:previous.handle,background});
            const refreshed = await call({action:'session_state'}); data=refreshed.data;
            const refreshedSnapshot = owner.snapshot as Snapshot | undefined;
            if (!refreshedSnapshot || refreshedSnapshot.nativeInstanceNonce!==nextNonce || refreshed.result.metadata?.nativeInstanceNonce!==nextNonce
              || Number(data.handle)!==previous.handle || owner.identity?.pid!==identity.pid || owner.identity?.process!==identity.process
              || owner.identity?.window!==identity.window || (!background && data.foreground!==true))
              throw new Error('Desktop helper recovery could not retain the exact foreground window. Fresh observe required; no input or activation dispatched.');
            owner.snapshot=refreshedSnapshot;
            helperRecovery.refreshedBeforeFirstDispatch=true;
          }
          if (Number(data.handle) !== owner.snapshot.handle) {
            if ((!background && policy !== 'activate') || !(await reacquire(background))) throw new Error('Desktop owner changed. Explicitly observe the intended target again.');
            data = (await call({ action: 'session_state' })).data;
            if (Number(data.handle) !== owner.snapshot.handle) throw new Error('Desktop owner changed. Explicitly observe the intended target again.');
          }
          if (!background && !data.foreground) {
            if (policy === 'activate') {
              await call({ action: 'activate', handle: owner.snapshot.handle });
              await observe({ handle: owner.snapshot.handle });
              data = (await call({ action: 'session_state' })).data;
              if (!data.foreground) throw new Error('Target window did not accept focus; no physical input dispatched.');
            } else if (policy === 'wait') {
              const waitMs = owner.focusWaitMs ?? 30_000;
              const deadline = Date.now() + waitMs;
              let regained = false;
              while (Date.now() < deadline) {
                try { await delayWithSignal(Math.min(100, deadline - Date.now()), lease.signal); }
                catch (error) { leaseAborted = true; throw error; }
                const current = (await call({ action: 'session_state' })).data;
                if (Number(current.handle) !== owner.snapshot.handle) throw new Error('Desktop owner changed while waiting for focus; no input dispatched.');
                if (current.foreground) {
                  await observe({ handle: owner.snapshot.handle });
                  data = (await call({ action: 'session_state' })).data;
                  regained = true;
                  break;
                }
              }
              if (!regained) throw new Error(`Focus wait timed out after ${waitMs}ms; no physical input dispatched.`);
            } else {
              throw new Error('Target is not foreground; no physical input dispatched. This is not a lease revocation. Set focusPolicy=wait to wait for the user to return focus, or observe after focus is restored.');
            }
          }
          if (data.geometryChanged || data.observationToken !== owner.snapshot.observationToken) throw new Error('Observation is stale. Observe again before input.');
        };
        const perform = async (original: Record<string, unknown>): Promise<ToolExecutionResult> => {
          if (transportContext.backend === 'native-isolated' && original.background === false) throw new Error('Isolated workspace requires background operations.');
          const step: Record<string, unknown> = { ...original, background: operationBackground || original.background === true || original.controlMode === 'background' }; const name = String(step.action || 'observe'); stepAction = name;
          validateExpectedWindowClose(step, step.background === true, cdp, owner.snapshot?.cdpTargetId || transportContext.cdpTargetId);
          validateRendererInput(step, cdp);
          validateHotkeyCount(step);
          for (const key of ['backend', 'cdpEndpoint', 'cdpTargetId'] as const) {
            if (step[key] !== undefined && step[key] !== transportContext[key]) throw new Error('Backend target changed within an operation; observe the new target separately.');
          }
          if (name === 'observe') {
            const explicitTarget = ['handle','pid','window','process'].some(key => step[key] !== undefined && step[key] !== '');
            return (await observe({ ...(!explicitTarget && owner.snapshot ? { handle: owner.snapshot.handle } : {}), ...step })).result;
          }
          if (step.background === true && (step.autoActivate === true || step.forcePointer === true))
            throw new Error('Background mode forbids activation and physical pointer fallback.');
          if (step.background === true && ['launch', 'activate', 'minimize', 'read_focused'].includes(name) && !(name === 'launch' && transportContext.backend === 'native-isolated'))
            throw new Error('This action changes or reads foreground state; use a background application adapter instead.');
          if (bindingActions.has(name)) {
            if (name === 'bind_window') step.activate = false;
            if (name !== 'launch') {
              const explicitTarget = ['handle','pid','window','process'].some(key => step[key] !== undefined && step[key] !== '');
              const target = await resolveWindow(explicitTarget ? step : { handle: owner.snapshot?.handle });
              step.handle = target.handle;
              owner.identity = { pid: target.pid, process: target.process, window: target.title };
            }
            owner.needsObservation = true;
            dispatchedActions++; emit('action_start'); const response = await call(step); emit('action_end');
            // Binding grants this owner a fresh snapshot, not another owner's stale cache.
            const handle = Number(response.data.window?.handle || response.data.session?.handle || response.data.handle);
            const observed = await observe({ ...(handle ? { handle } : {}), background: step.background });
            response.result.imageData = observed.result.imageData; response.result.imageMimeType = observed.result.imageMimeType;
            return response.result;
          }
          if (name === 'minimize') { await checkOwnership(); dispatchedActions++; emit('action_start'); const response = await call({ ...step, handle: owner.snapshot!.handle }); owner.needsObservation = true; emit('action_end'); return response.result; }
          if (inputActions.has(name)) {
            const background = step.background === true;
            if (!cdp && cdpOnlyActions.has(name)) throw new Error('This component action requires the chromium-cdp backend.');
            await checkOwnership(background,step);
            const snapshot = owner.snapshot!;
            // Reject hidden focus stealing and snapshot substitution by model arguments.
            if (step.autoActivate === true) throw new Error('Use explicit activate; autoActivate is disabled in managed control.');
            if (background && snapshot.captureTrust === 'background-unverified' && !snapshot.elements.some(element => element.selector)) throw new Error('Background observation has no trusted UI Automation control; OCR/frame evidence cannot drive input.');
            if (background && !cdp && !['click_element', 'type_element', 'click', 'type'].includes(name)) throw new Error('Background mode supports semantic UIA click/type only.');
            if (step.observationToken && step.observationToken !== owner.snapshot!.observationToken) throw new Error('Observation token is stale for this owner. Any observe or completed action replaces it: pass the token from that action\'s postObservation, or call observe again. Do not retry the previous token.');
            if (Date.now() - owner.snapshot!.capturedAt > 60_000) throw new Error('Observation expired. Observe again.');
            emit('resolve');
            if (step.target) {
              if (!cdp && !['click', 'click_element', 'type', 'type_element'].includes(name)) throw new Error('Semantic target applies only to click/type actions.');
              const element = resolveDesktopTarget(step.target as DesktopTarget, owner.snapshot!.elements);
              step.elementId = element.id;
              if (['type','type_element'].includes(name)) step.action = 'type_element';
              else if (['click','click_element'].includes(name)) step.action = 'click_element';
            } else if (step.elementId) resolveDesktopTarget({ elementId: String(step.elementId), ...(step.role ? { role: String(step.role) } : {}) }, owner.snapshot!.elements);
            if (cdp && step.elementId && name==='click') step.action='click_element';
            if (cdp && step.elementId && name==='type') step.action='type_element';
            if (cdp && !step.elementId && ['key','hotkey'].includes(name)) {
              const focused=snapshot.elements.filter(element=>element.focused&&element.capabilities?.includes('keyInput')&&element.enabled!==false);
              const target=focused.find(element=>['edit','combobox'].includes(element.role)) || (focused.length===1?focused[0]:undefined);
              if (target) step.elementId=target.id;
            }
            if (cdp && !step.elementId && name==='scroll') {
              const scrollers=snapshot.elements.filter(element=>element.capabilities?.includes('scroll')&&element.selector?.name==='Page scroll'&&element.enabled!==false);
              if(scrollers.length===1)step.elementId=scrollers[0].id;
            }
            step.observationToken = owner.snapshot!.observationToken; step.autoActivate = false; step.allowGeometryChange = false; step.background = background;
            if (!cdp && owner.snapshot!.nativeInstanceNonce) step.expectedNativeInstanceNonce = owner.snapshot!.nativeInstanceNonce;
            delete step.target;
            if (step.forcePointer === true) {
              const grant = owner.pointerFallback;
              if (!grant || grant.handle !== owner.snapshot!.handle || grant.observationToken !== owner.snapshot!.observationToken || grant.elementId !== String(step.elementId || '')) {
                throw new Error('forcePointer requires a prior UIA click with effectObserved=false for this exact element and observation.');
              }
              owner.pointerFallback = undefined;
            } else owner.pointerFallback = undefined;
            if (background) {
              if ((!cdp && !['click_element', 'type_element'].includes(String(step.action))) || !step.elementId)
                throw new Error('Background input requires a resolved semantic UIA element, not physical coordinates.');
              const target = owner.snapshot!.elements.find(element => element.id === step.elementId);
              if (!target?.selector) throw new Error('Background input requires a native UIA selector; OCR/local vision is not an input capability.');
            }
            // Persist dispatch intent BEFORE transport; a crash can leave the outcome uncertain.
            owner.needsObservation = true; dispatchedActions++;
            emit('action_start');
            const response = await call(step); acknowledgedActions++; emit('action_end');
            const finishWindowClose = (details: Record<string,unknown>): ToolExecutionResult => {
              owner.snapshot=undefined; owner.needsObservation=true; owner.pointerFallback=undefined;
              verified=true; verificationMethod='window_closed'; emit('verify');
              const body=JSON.parse(response.result.output);
              body.data={...body.data,...details,windowClosed:true,closedHandle:snapshot.handle,verified,verificationMethod,needsObservation:true};
              response.result.output=JSON.stringify(body);
              return response.result;
            };
            const confirmCdpClosed = async () => {
              if (!cdp || step.expectWindowClosed!==true) return false;
              const targetId=snapshot.cdpTargetId || transportContext.cdpTargetId;
              const {data:listed}=await call({action:'list_windows'});
              if (!Array.isArray(listed.windows)) throw new Error('CDP target closure cannot be verified from an invalid target list.');
              // This list comes from the same endpoint/backend context. Do not
              // select another page or accept a mismatching handle as closure.
              return !listed.windows.some((window:any)=>window.cdpTargetId===targetId);
            };
            const confirmNativeClosed = async () => {
              if (cdp || background || step.expectWindowClosed !== true
                || (response.data.foregroundVerified !== true && response.data.inputCompleted !== true)) return false;
              // Query the exact original handle, including hidden windows. The
              // last app window can close too; no surviving PID is required.
              // A failed input never reaches this acknowledged-response path.
              const timeout = new AbortController(), deadline = Date.now() + 1500;
              const closingSignal = AbortSignal.any([lease.signal, timeout.signal]);
              const timeoutError = new Error('Expected window closure was not confirmed within 1500ms. The original handle still exists or its state is unverified; observe before further input and do not replay the close action.');
              let rejectBound!: (error: Error) => void;
              const bounded = new Promise<never>((_, reject) => { rejectBound = reject; });
              const abort = () => rejectBound(closingSignal.reason instanceof Error ? closingSignal.reason : new Error('Window closure verification cancelled.'));
              closingSignal.addEventListener('abort', abort, {once:true});
              const timer = setTimeout(() => timeout.abort(timeoutError), 1500);
              const poll = async () => {
                for (;;) {
                  if (closingSignal.aborted) throw closingSignal.reason;
                  const { data: listed } = await call({ action: 'list_windows', handle: snapshot.handle, includeHidden: true, limit: 1 }, closingSignal);
                  if (closingSignal.aborted) throw closingSignal.reason;
                  if (!Array.isArray(listed.windows)) throw new Error('Native window closure cannot be verified from an invalid window list.');
                  // Exact query: malformed or unrelated rows never prove absence.
                  if (listed.windows.some((window: any) => !window || typeof window.handle !== 'number'
                    || !Number.isSafeInteger(window.handle) || window.handle <= 0 || window.handle !== snapshot.handle))
                    throw new Error('Native window closure cannot be verified from a mismatched exact-handle window list.');
                  if (listed.windows.length === 0) return true;
                  const remaining = deadline-Date.now();
                  if (remaining <= 0) throw timeoutError;
                  await delayWithSignal(Math.min(100,remaining),closingSignal);
                }
              };
              try { return await Promise.race([poll(), bounded]); }
              finally { clearTimeout(timer); closingSignal.removeEventListener('abort', abort); }
            };
            const describeForegroundRecovery = async (actual: any) => {
              if (cdp || background || !actual || !Number.isSafeInteger(Number(actual.handle)) || Number(actual.handle) <= 0 || lease.signal.aborted) return;
              const summarize = (window: any) => ({ handle: Number(window.handle), pid: Number(window.pid),
                title: String(window.title || '').slice(0, 160), process: String(window.process || '').slice(0, 80) });
              const relatedCandidates: unknown[] = [];
              if (owner.identity?.pid) {
                try {
                  const { data: listed } = await call({ action: 'list_windows', pid: owner.identity.pid, includeHidden: false, limit: 12 });
                  if (Array.isArray(listed.windows)) relatedCandidates.push(...listed.windows
                    .filter((window: any) => Number(window.pid) === owner.identity!.pid && Number(window.handle) !== snapshot.handle)
                    .slice(0, 12).map(summarize));
                } catch { /* Recovery hints never replace the input failure. */ }
              }
              foregroundRecovery = { actualForeground: summarize(actual), relatedCandidates,
                nextObservation: { action: 'observe', handle: Number(actual.handle) },
                guidance: `下一步只读观察实际前台窗口：action=observe，handle=${Number(actual.handle)}；先确认它是本任务的菜单或对话框，再决定后续操作。弹层可能已经打开，不要重复原按钮，也不要为恢复而激活主窗口。空标题窗口按此精确句柄观察。候选信息不授予输入权限，先核对上一动作是否已生效。` };
            };
            if (await confirmCdpClosed()) return finishWindowClose({targetClosed:true,cdpTargetId:snapshot.cdpTargetId || transportContext.cdpTargetId});
            let current: any;
            // The native input may complete before its owned dialog becomes
            // foreground. Only its successful foreground proof authorizes this
            // one post-action read to verify a late modal through native policy.
            const followOwnedModal = !background && !cdp && response.data.foregroundVerified === true
              && ['click','click_element','key','hotkey'].includes(String(step.action));
            try {
              const stateAfter=await call({ action: 'session_state', ...(followOwnedModal ? { followOwnedModal: true, ...(step.expectWindowClosed === true ? { expectWindowClosed: true } : {}) } : {}) });
              if (!cdp && snapshot.nativeInstanceNonce && stateAfter.result.metadata?.nativeInstanceNonce !== snapshot.nativeInstanceNonce)
                throw new Error('Desktop helper restarted after input was acknowledged. Fresh observe and verify the result; do not replay the input.');
              current=stateAfter.data;
            }
            catch(error) {
              if (await confirmCdpClosed()) return finishWindowClose({targetClosed:true,cdpTargetId:snapshot.cdpTargetId || transportContext.cdpTargetId});
              if (await confirmNativeClosed()) return finishWindowClose({pid:owner.identity?.pid});
              await describeForegroundRecovery(transportActualForeground);
              throw error;
            }
            if (await confirmNativeClosed()) return finishWindowClose({pid:owner.identity?.pid});
            if (!background && !current.foreground) {
              await describeForegroundRecovery(current.actualForeground);
              throw new Error('Target lost foreground during input; the action may have partially executed. Re-observe and verify before continuing; do not replay blindly.');
            }
            // Native ownership policy verifies both immediate and late modal
            // transitions; this never grants arbitrary foreground window access.
            if (!background && Number(current.handle) !== owner.snapshot!.handle && response.data.foregroundVerified !== true) throw new Error('Desktop owner changed after action. Observe again.');
            let after: Awaited<ReturnType<typeof observe>>;
            try { after = await observe({ handle: Number(current.handle), includeOcr: !!step.verifyText, background }); }
            catch (error) {
              if (await confirmCdpClosed()) return finishWindowClose({targetClosed:true,cdpTargetId:snapshot.cdpTargetId || transportContext.cdpTargetId});
              if (await confirmNativeClosed()) return finishWindowClose({pid:owner.identity?.pid});
              postObservationError=(error as Error).message;
              throw new Error(`Input acknowledged; post-action observation is pending: ${postObservationError} Re-observe to verify; do not replay input.`);
            }
            owner.pointerFallback = undefined;
            if (name === 'click' && String(step.action) === 'click_element' && step.forcePointer !== true && response.data?.method !== 'pointer' && response.data?.automation && response.data?.effectObserved === false && response.data?.foregroundVerified === true && step.elementId) {
              owner.pointerFallback = { observationToken: owner.snapshot!.observationToken, handle: owner.snapshot!.handle, elementId: String(step.elementId) };
            }
            verificationMethod = 'post_action_observation';
            verified = false;
            if (step.verifyText) {
              verificationMethod = 'visible_text';
              verified = owner.snapshot!.elements.some(e => String(e.text || '').includes(String(step.verifyText)));
              emit('verify');
              if (!verified) throw new Error('Post-action text verification failed; input may already have executed. Do not replay blindly.');
            } else emit('verify');
            response.result.imageData = after.result.imageData; response.result.imageMimeType = after.result.imageMimeType;
            const body = JSON.parse(response.result.output);
            body.data = { ...body.data, postObservation: postObservationSummary(owner.snapshot!, after.data), verified, verificationMethod };
            response.result.output = JSON.stringify(body);
            return response.result;
          }
          if (!passiveActions.has(name)) throw new Error(`Unknown managed desktop action: ${name}`);
          if (['frame', 'find_element', 'read_focused', 'wait_change'].includes(name)) await checkOwnership(step.background === true);
          if (name === 'frame') step.observationToken = owner.snapshot!.observationToken;
          const response = await call(step);
          if (name === 'session_state') {
            const body = JSON.parse(response.result.output);
            body.data.control = { ...controlStatus(), needsObservation: owner.needsObservation, recovered: owner.recovered, recovery: 'observe_before_input', queue: this.scheduler.snapshot() };
            response.result.output = JSON.stringify(body);
          }
          return response.result;
        };
        if (action === 'batch') {
          if (!Array.isArray(args.actions) || !args.actions.length || args.actions.length > 24) throw new Error('Batch requires 1–24 actions.');
          if (args.verifyText && args.actions.some(step=>step&&typeof step==='object'&&(step as Record<string,unknown>).expectWindowClosed===true)) throw new Error('Observe the remaining window separately before verifying text after a window-closing batch.');
          // Validate the entire batch BEFORE any side effects. Transport-specific
          // resolution still happens per step against a fresh observation.
          for (const step of args.actions) {
            if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Managed batch actions must be objects.');
            validateBatchStep(step as Record<string, unknown>, operationBackground, cdp, owner.snapshot?.cdpTargetId || transportContext.cdpTargetId);
          }
          const results: unknown[] = [];
          for (const [index, step] of (args.actions as Record<string, unknown>[]).entries()) {
            stepIndex = index + 1;
            const result = await perform({ ...step, ...(operationBackground ? { background: true } : {}) }); completedSteps++; results.push(JSON.parse(result.output));
          }
          if (args.verifyText) {
            await observe({ handle: owner.snapshot!.handle, includeOcr: true });
            verificationMethod = 'visible_text'; verified = owner.snapshot!.elements.some(e => String(e.text || '').includes(String(args.verifyText)));
            emit('verify'); if (!verified) throw new Error('Batch text verification failed; previous actions were executed.');
          }
          return { output: JSON.stringify({ ok: true, action, data: { results } }), success: true };
        }
        return perform(args);
      });
      emit('completed');
      return { ...result, durationMs: Date.now() - started, metadata: { ...result.metadata, desktop: { operationId, phase, verified, verificationMethod, events, completedSteps, dispatchedActions, acknowledgedActions, ...(helperRecovery ? {helperRecovery} : {}), recovered: owner.recovered, observationToken: owner.snapshot?.observationToken, control: controlStatus(), recovery: 'observe_before_input' } } };
    } catch (error) {
      owner.needsObservation = true;
      owner.pointerFallback = undefined;
      const message = (error as Error).message; const failedAt = phase;
      const cancelled = !!signal?.aborted || leaseAborted;
      const takeover = /user takeover|desktop control paused by operator|control lease (?:revoked|transferred)/i.test(message);
      try { emit(cancelled ? 'cancelled' : takeover ? 'takeover' : 'failed'); } catch { /* Keep original failure if storage is unavailable. */ }
      // Include the current failed dispatch in recovery, not only the state loaded at startup.
      try { if (this.journalDir) owner.recovered = this.recover(context.owner); } catch { /* Original transport/journal failure remains authoritative. */ }
      return { output: message + (foregroundRecovery ? '\n' + JSON.stringify({ foregroundRecovery }) : '') + (helperRecovery ? '\n' + JSON.stringify({helperRecovery}) : ''), success: false, cancelled, durationMs: Date.now() - started, metadata: { desktop: { operationId, phase, failedAt, completedSteps, dispatchedActions, acknowledgedActions, observationPending: !!postObservationError, postObservationError, ...(foregroundRecovery ? {foregroundRecovery} : {}), ...(helperRecovery ? {helperRecovery} : {}), inputMayHaveExecuted: dispatchedActions > 0, recovered: owner.recovered, verified: false, verificationMethod, events, userTakeover: takeover, control: controlStatus(), noAction: dispatchedActions === 0, recovery: 'observe_before_input' } } };
    }
  }
}
