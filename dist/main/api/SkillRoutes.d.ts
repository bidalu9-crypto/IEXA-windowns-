import * as http from 'http';
import { URL } from 'url';
import { SkillStore } from '../skills/SkillStore';
export interface SkillRouteContext {
    skills: SkillStore;
    skillsChanged: () => void;
}
export declare function handleSkillRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: SkillRouteContext): Promise<boolean>;
//# sourceMappingURL=SkillRoutes.d.ts.map