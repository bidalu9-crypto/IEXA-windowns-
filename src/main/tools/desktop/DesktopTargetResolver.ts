export interface DesktopElement {
  id: string; role: string; text: string; enabled?: boolean; source?: string;
  bounds?: { left: number; top: number; width: number; height: number };
  selector?: { automationId?: string; controlType?: string; name?: string };
}
export interface DesktopTarget { automationId?: string; name?: string; role?: string; elementId?: string; }
const normal = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase();
/** Exact conjunctive matching; ambiguity is an error, never an arbitrary first click. */
export function resolveDesktopTarget(target: DesktopTarget, elements: DesktopElement[]): DesktopElement {
  if (!target || typeof target !== 'object' || !Object.values(target).some(v => typeof v === 'string' && v.trim())) throw new Error('A semantic target needs automationId, name, role or elementId.');
  if (Object.keys(target).some(key => !['automationId', 'name', 'role', 'elementId'].includes(key))) throw new Error('Unknown semantic target field.');
  const matches = elements.filter(e => e.enabled !== false
    && (!target.elementId || e.id === target.elementId)
    && (!target.automationId || normal(e.selector?.automationId) === normal(target.automationId))
    && (!target.name || (normal(e.text) === normal(target.name) || normal(e.selector?.name) === normal(target.name)))
    && (!target.role || normal(e.role) === normal(target.role) || normal(e.selector?.controlType) === normal(target.role)));
  if (!matches.length) throw new Error('Semantic target not found. Observe again or refine the selector.');
  // Prefer UIA over duplicate OCR evidence; multiple UIA matches remain ambiguous.
  const uia = matches.filter(e => e.selector);
  const candidates = uia.length ? uia : matches;
  if (candidates.length !== 1) throw new Error(`Semantic target is ambiguous (${candidates.length} matches). Specify automationId or elementId.`);
  return candidates[0];
}

export interface DesktopWindow { handle: number; pid: number; title: string; process: string; }
export function resolveDesktopWindow(target: { handle?: unknown; pid?: unknown; window?: unknown; process?: unknown }, windows: DesktopWindow[]): DesktopWindow {
  const has = (value: unknown) => value !== undefined && value !== null && value !== '';
  if (!Object.values(target).some(has)) throw new Error('Specify a window handle, PID, title or process before binding a new owner.');
  const matches = windows.filter(w => (!has(target.handle) || w.handle === Number(target.handle))
    && (!has(target.pid) || w.pid === Number(target.pid))
    && (!has(target.window) || normal(w.title).includes(normal(target.window)))
    && (!has(target.process) || normal(w.process).includes(normal(target.process))));
  if (!matches.length) throw new Error('Target window not found. List windows again; no foreground fallback was used.');
  if (matches.length !== 1) throw new Error(`Window target is ambiguous (${matches.length} matches). Use an exact handle and PID from list_windows.`);
  return matches[0];
}
