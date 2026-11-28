import * as http from 'http';
import { URL } from 'url';
export interface SteerAttachment {
    name: string;
    mime: string;
    kind: 'image' | 'text' | 'file';
    data?: Buffer;
    text?: string;
    savedPath?: string;
    width?: number;
    height?: number;
}
export interface SteerMetaAttachment {
    name: string;
    mime: string;
    kind: 'image' | 'text' | 'file';
    savedPath?: string;
    previewUrl?: string;
}
export interface SteerRouteContext {
    workspaceDir: string;
    limits: {
        maxBodyBytes: number;
        maxAttachments: number;
        maxUploadBytes: number;
        maxVisionImageBytes: number;
        maxAttachmentTotalBytes: number;
    };
    isAgentRunning(sessionId: string): boolean;
    usesVisionProxy(sessionId: string): boolean;
    steer(sessionId: string, input: {
        id: string;
        text: string;
        attachments: SteerAttachment[];
    }): boolean;
    rememberMeta(sessionId: string, steerId: string, meta: {
        content: string;
        attachments?: SteerMetaAttachment[];
    }): void;
}
export declare function handleSteerRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: SteerRouteContext): Promise<boolean>;
//# sourceMappingURL=SteerRoutes.d.ts.map