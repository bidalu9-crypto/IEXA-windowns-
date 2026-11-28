"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setPetWindowHost = setPetWindowHost;
exports.petWindowHost = petWindowHost;
let host = null;
function setPetWindowHost(next) {
    host = next;
}
function petWindowHost() {
    return host;
}
//# sourceMappingURL=PetWindowHost.js.map