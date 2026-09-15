import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ToolExecutionResult } from '../../providers/types';
import { DesktopControlScheduler, desktopControlScheduler } from './DesktopControlScheduler';
import { DesktopElement, DesktopTarget, resolveDesktopTarget, resolveDesktopWindow } from './DesktopTargetResolver';
import { DesktopRecoveryState, readDesktopRecovery, appendDesktopRecoveryEvent } from './DesktopRecoveryJournal';

export type DesktopPhase = 'queued' | 'observe' | 'resolve' | 'action_start' | 'action_end' | 'verify' | 'completed' | 'failed' | 'takeover' | 'cancelled';
export interface DesktopEvent { version: 1; operationId: string; sequence: number; phase: DesktopPhase; timestamp: number; action: string; verified?: boolean; step?: number; totalSteps?: number; dispatchedActions?: number; completedSteps?: number; inputMayHaveExecuted?: boolean; }
export interface DesktopContext { owner: string; operationId?: string; onEvent?: (event: DesktopEvent) => void; }
interface Snapshot { observationToken: string; capturedAt: number; handle: number; elements: DesktopElement[]; frameHash?: string; captureTrust?: string; }
interface OwnerState { snapshot?: Snapshot; needsObservation: boolean; backendContext?: { backend?: unknown; cdpEndpoint?: unknown; cdpTargetId?: unknown }; recovered?: DesktopRecoveryState; }
type Transport = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolExecutionResult>;
const inputActions = new Set(['move', 'click', 'drag', 'click_element', 'type', 'type_element', 'key', 'hotkey', 'scroll']);
const bindingActions = new Set(['launch', 'activate', 'bind_window']);
const passiveActions = new Set(['list_windows', 'observe', 'frame', 'session_state', 'find_element', 'read_focused', 'wait', 'wait_change']);

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
    let stepIndex: number | undefined; let completedSteps = 0; let dispatchedActions = 0;
    const totalSteps = action === 'batch' && Array.isArray(args.actions) ? args.actions.length : undefined;
    let stepAction = action;
    let state = this.owners.get(context.owner);
    if (!state) { state = { needsObservation: true }; this.owners.set(context.owner, state); }
    const owner = state;
    const emit = (next: DesktopPhase) => {
      phase = next;
      const event: DesktopEvent = { version: 1, operationId, sequence: events.length + 1, phase, timestamp: Date.now(), action: stepAction, dispatchedActions, completedSteps, inputMayHaveExecuted: dispatchedActions > 0, ...(stepIndex ? { step: stepIndex, totalSteps } : {}), ...(phase === 'verify' || phase === 'completed' ? { verified } : {}) };
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
        if (args.backend !== undefined || args.cdpEndpoint !== undefined || args.cdpTargetId !== undefined) {
          const next = { ...owner.backendContext, ...(args.backend !== undefined ? {backend:args.backend} : {}), ...(args.cdpEndpoint !== undefined ? {cdpEndpoint:args.cdpEndpoint} : {}), ...(args.cdpTargetId !== undefined ? {cdpTargetId:args.cdpTargetId} : {}) };
          if (next.backend === 'native' || next.backend === 'native-isolated') { delete next.cdpEndpoint; delete next.cdpTargetId; }
          if (JSON.stringify(next) !== JSON.stringify(owner.backendContext)) { owner.snapshot = undefined; owner.needsObservation = true; }
          owner.backendContext = next;
        }
        const transportContext = owner.backendContext || {};
        const call = async (payload: Record<string, unknown>): Promise<{ result: ToolExecutionResult; data: any }> => {
          if (lease.signal.aborted) { leaseAborted = true; throw new Error(lease.signal.reason instanceof Error ? lease.signal.reason.message : 'Desktop control cancelled.'); }
          const result = await this.transport({ ...payload, ...transportContext, detail: 'raw' }, lease.signal);
          if (lease.signal.aborted) { leaseAborted = true; throw new Error(lease.signal.reason instanceof Error ? lease.signal.reason.message : 'Desktop control cancelled.'); }
          if (!result.success) throw new Error(result.output);
          let body: any; try { body = JSON.parse(result.output); } catch { throw new Error('Desktop transport returned invalid JSON.'); }
          return { result, data: body.data || body };
        };
        const resolveWindow = async (options: Record<string, unknown>) => {
          const target = { handle: options.handle, pid: options.pid, window: options.window, process: options.process };
          const { data } = await call({ action: 'list_windows', window: target.window, process: target.process, pid: target.pid, includeHidden: true, limit: 100 });
          return resolveDesktopWindow(target, (data.windows || []).filter((window: any) => !transportContext.cdpTargetId || window.cdpTargetId === transportContext.cdpTargetId));
        };
        const observe = async (options: Record<string, unknown> = {}) => {
          emit('observe');
          if (options.handle || options.pid || options.window || options.process) options = { ...options, handle: (await resolveWindow(options)).handle };
          const response = await call({ ...options, action: 'observe', captureFrame: options.captureFrame });
          const data = response.data;
          if (options.handle && Number(data.session?.handle) !== Number(options.handle)) throw new Error('Observed window changed during capture. No input dispatched; observe your target again.');
          if (!data.session?.observationToken || !Number(data.session.handle)) throw new Error('Observation is missing a bound window or token.');
          owner.snapshot = { observationToken: data.session.observationToken, capturedAt: Date.now(), handle: Number(data.session.handle), elements: (data.elements || []).filter((element: DesktopElement) => data.frame?.trust === 'foreground' || element.source !== 'ocr'), frameHash: data.frame?.hash, captureTrust: data.frame?.trust || 'unknown' };
          owner.needsObservation = false;
          return response;
        };
        const checkOwnership = async (background = false) => {
          if (!owner.snapshot || owner.needsObservation) throw new Error('Fresh observe is required for this session before input; recovery never replays actions.');
          const { data } = await call({ action: 'session_state' });
          if (Number(data.handle) !== owner.snapshot.handle) throw new Error('Desktop owner changed. Explicitly activate and observe your target again.');
          if (!background && !data.foreground) throw new Error('User takeover: target window lost foreground.');
          if (data.geometryChanged || data.observationToken !== owner.snapshot.observationToken) throw new Error('Observation is stale. Observe again before input.');
        };
        const perform = async (original: Record<string, unknown>): Promise<ToolExecutionResult> => {
          if (transportContext.backend === 'native-isolated' && original.background === false) throw new Error('Isolated workspace requires background operations.');
          const step: Record<string, unknown> = { ...original, ...(transportContext.backend === 'native-isolated' ? {background:true} : {}) }; const name = String(step.action || 'observe'); stepAction = name;
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
            if (name !== 'launch') {
              const explicitTarget = ['handle','pid','window','process'].some(key => step[key] !== undefined && step[key] !== '');
              const target = await resolveWindow(explicitTarget ? step : { handle: owner.snapshot?.handle });
              step.handle = target.handle;
            }
            owner.needsObservation = true;
            dispatchedActions++; emit('action_start'); const response = await call(step); emit('action_end');
            // Binding grants this owner a fresh snapshot, not another owner's stale cache.
            const handle = Number(response.data.window?.handle || response.data.session?.handle || response.data.handle);
            const observed = await observe(handle ? { handle } : {});
            response.result.imageData = observed.result.imageData; response.result.imageMimeType = observed.result.imageMimeType;
            return response.result;
          }
          if (name === 'minimize') { await checkOwnership(); dispatchedActions++; emit('action_start'); const response = await call({ ...step, handle: owner.snapshot!.handle }); owner.needsObservation = true; emit('action_end'); return response.result; }
          if (inputActions.has(name)) {
            const background = step.background === true;
            await checkOwnership(background);
            const snapshot = owner.snapshot!;
            // Reject hidden focus stealing and snapshot substitution by model arguments.
            if (step.autoActivate === true) throw new Error('Use explicit activate; autoActivate is disabled in managed control.');
            if (background && snapshot.captureTrust === 'background-unverified' && !snapshot.elements.some(element => element.selector)) throw new Error('Background observation has no trusted UI Automation control; OCR/frame evidence cannot drive input.');
            if (background && !['click_element', 'type_element', 'click', 'type'].includes(name)) throw new Error('Background mode supports semantic UIA click/type only.');
            if (step.observationToken && step.observationToken !== owner.snapshot!.observationToken) throw new Error('Observation token is stale for this owner.');
            if (Date.now() - owner.snapshot!.capturedAt > 60_000) throw new Error('Observation expired. Observe again.');
            emit('resolve');
            if (step.target) {
              if (!['click', 'click_element', 'type', 'type_element'].includes(name)) throw new Error('Semantic target applies only to click/type actions.');
              const element = resolveDesktopTarget(step.target as DesktopTarget, owner.snapshot!.elements);
              step.elementId = element.id; step.action = name.startsWith('type') ? 'type_element' : 'click_element';
            } else if (step.elementId) resolveDesktopTarget({ elementId: String(step.elementId), ...(step.role ? { role: String(step.role) } : {}) }, owner.snapshot!.elements);
            step.observationToken = owner.snapshot!.observationToken; step.autoActivate = false; step.allowGeometryChange = false; step.background = background;
            delete step.target;
            if (background) {
              if (!['click_element', 'type_element'].includes(String(step.action)) || !step.elementId)
                throw new Error('Background input requires a resolved semantic UIA element, not physical coordinates.');
              const target = owner.snapshot!.elements.find(element => element.id === step.elementId);
              if (!target?.selector) throw new Error('Background input requires a native UIA selector; OCR/local vision is not an input capability.');
            }
            // Persist dispatch intent BEFORE transport; a crash can leave the outcome uncertain.
            owner.needsObservation = true; dispatchedActions++;
            emit('action_start');
            const response = await call(step); emit('action_end');
            const { data: current } = await call({ action: 'session_state' });
            if (!background && !current.foreground) throw new Error('User takeover: target window lost foreground after action.');
            // A native same-process dialog transition is accepted only when explicitly verified by native action.
            if (!background && Number(current.handle) !== owner.snapshot!.handle && response.data.foregroundVerified !== true) throw new Error('Desktop owner changed after action. Observe again.');
            const after = await observe({ handle: Number(current.handle), includeOcr: !!step.verifyText });
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
            body.data = { ...body.data, postObservation: { observationToken: owner.snapshot!.observationToken, handle: owner.snapshot!.handle, frameHash: owner.snapshot!.frameHash }, verified, verificationMethod };
            response.result.output = JSON.stringify(body);
            return response.result;
          }
          if (!passiveActions.has(name)) throw new Error(`Unknown managed desktop action: ${name}`);
          if (['frame', 'find_element', 'read_focused', 'wait_change'].includes(name)) await checkOwnership(step.background === true);
          if (name === 'frame') step.observationToken = owner.snapshot!.observationToken;
          const response = await call(step);
          if (name === 'session_state') {
            const body = JSON.parse(response.result.output);
            body.data.control = { needsObservation: owner.needsObservation, recovered: owner.recovered, recovery: 'observe_before_input', queue: this.scheduler.snapshot() };
            response.result.output = JSON.stringify(body);
          }
          return response.result;
        };
        if (action === 'batch') {
          if (!Array.isArray(args.actions) || !args.actions.length || args.actions.length > 24) throw new Error('Batch requires 1–24 actions.');
          // Validate the entire batch BEFORE any side effects.
          for (const step of args.actions) if (!step || typeof step !== 'object' || !inputActions.has(String(step.action))) throw new Error('Managed batches accept input actions only; observe/bind separately.');
          const results: unknown[] = [];
          for (const [index, step] of (args.actions as Record<string, unknown>[]).entries()) {
            stepIndex = index + 1;
            const result = await perform({ ...step, ...(args.background === true ? { background: true } : {}) }); completedSteps++; results.push(JSON.parse(result.output));
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
      return { ...result, durationMs: Date.now() - started, metadata: { ...result.metadata, desktop: { operationId, phase, verified, verificationMethod, events, completedSteps, dispatchedActions, recovered: owner.recovered, observationToken: owner.snapshot?.observationToken, recovery: 'observe_before_input' } } };
    } catch (error) {
      owner.needsObservation = true;
      const message = (error as Error).message; const failedAt = phase;
      const cancelled = !!signal?.aborted || leaseAborted;
      const takeover = /takeover|foreground|paused by|owner changed/i.test(message);
      try { emit(cancelled ? 'cancelled' : takeover ? 'takeover' : 'failed'); } catch { /* Keep original failure if storage is unavailable. */ }
      // Include the current failed dispatch in recovery, not only the state loaded at startup.
      try { if (this.journalDir) owner.recovered = this.recover(context.owner); } catch { /* Original transport/journal failure remains authoritative. */ }
      return { output: message, success: false, cancelled, durationMs: Date.now() - started, metadata: { desktop: { operationId, phase, failedAt, completedSteps, dispatchedActions, inputMayHaveExecuted: dispatchedActions > 0, recovered: owner.recovered, verified: false, verificationMethod, events, userTakeover: takeover, recovery: 'observe_before_input' } } };
    }
  }
}
