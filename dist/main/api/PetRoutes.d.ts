import * as http from 'http';
import { URL } from 'url';
import { PetStore } from '../pet/PetStore';
export interface PetRouteContext {
    store: PetStore;
    maxSpriteBytes: number;
}
export declare function handlePetRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: PetRouteContext): Promise<boolean>;
//# sourceMappingURL=PetRoutes.d.ts.map