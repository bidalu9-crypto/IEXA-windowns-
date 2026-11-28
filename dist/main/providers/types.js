"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolParamSchema = toolParamSchema;
function toolParamSchema(param) {
    return {
        type: param.type,
        description: param.description,
        ...(param.enumValues ? { enum: param.enumValues } : {}),
        ...(param.minimum !== undefined ? { minimum: param.minimum } : {}),
        ...(param.maximum !== undefined ? { maximum: param.maximum } : {}),
        ...(param.items ? { items: toolParamSchema(param.items) } : {}),
        ...(param.properties ? { properties: Object.fromEntries(Object.entries(param.properties).map(([key, value]) => [key, toolParamSchema(value)])) } : {}),
        ...(param.required ? { required: param.required } : {}),
    };
}
//# sourceMappingURL=types.js.map