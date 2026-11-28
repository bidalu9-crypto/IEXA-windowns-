export interface DesktopElement {
    id: string;
    role: string;
    text: string;
    enabled?: boolean;
    source?: string;
    confidence?: number | null;
    bounds?: {
        left: number;
        top: number;
        width: number;
        height: number;
    };
    selector?: {
        automationId?: string;
        controlType?: string;
        name?: string;
    };
    capabilities?: string[];
    focused?: boolean;
    checked?: boolean;
    expanded?: boolean | string;
    options?: {
        value: string;
        label: string;
        disabled: boolean;
        selected: boolean;
    }[];
    scroll?: {
        top: number;
        left: number;
        width: number;
        height: number;
        clientWidth: number;
        clientHeight: number;
    };
}
export interface DesktopTarget {
    automationId?: string;
    name?: string;
    role?: string;
    elementId?: string;
}
/** Exact conjunctive matching; ambiguity is an error, never an arbitrary first click. */
export declare function resolveDesktopTarget(target: DesktopTarget, elements: DesktopElement[]): DesktopElement;
export interface DesktopWindow {
    handle: number;
    pid: number;
    title: string;
    process: string;
}
export declare function resolveDesktopWindow(target: {
    handle?: unknown;
    pid?: unknown;
    window?: unknown;
    process?: unknown;
}, windows: DesktopWindow[]): DesktopWindow;
//# sourceMappingURL=DesktopTargetResolver.d.ts.map