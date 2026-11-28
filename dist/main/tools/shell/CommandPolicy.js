"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandPolicy = void 0;
const IexaError_1 = require("../../errors/IexaError");
/** Arbitrary shells are a capability, not a command-name blacklist. */
class CommandPolicy {
    classify(command) { this.assertAllowed(command); return 'high'; }
    assertAllowed(command) {
        if (typeof command !== 'string' || !command.trim())
            throw new IexaError_1.IexaError('COMMAND_EMPTY', 'TOOL', 'Command is empty.');
        if (command.includes('\0'))
            throw new IexaError_1.IexaError('COMMAND_INVALID', 'TOOL', 'Command contains a NUL character.');
    }
}
exports.CommandPolicy = CommandPolicy;
//# sourceMappingURL=CommandPolicy.js.map