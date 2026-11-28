import * as http from 'http';
import { URL } from 'url';
import { TaskScheduler } from '../tasks/Scheduler';
export interface ScheduledTaskRouteContext {
    scheduler: TaskScheduler;
    listProfiles(): Array<{
        id: string;
        name: string;
        model: string;
    }>;
    listSessions(): Array<{
        id: string;
        title: string;
    }>;
    allowWrite: boolean;
    now(): number;
}
export declare function handleScheduledTaskRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: ScheduledTaskRouteContext): Promise<boolean>;
//# sourceMappingURL=ScheduledTaskRoutes.d.ts.map