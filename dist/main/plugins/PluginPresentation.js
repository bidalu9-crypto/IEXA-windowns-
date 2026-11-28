"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePluginCard = validatePluginCard;
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v, max) {
    if (typeof v !== 'string' || v.length > max)
        throw new Error('插件卡片文字无效或过长。');
    return v;
}
function validatePluginCard(value) {
    if (!object(value) || value.version !== 1)
        throw new Error('插件卡片需要 version: 1。');
    const card = { version: 1, title: text(value.title, 160) };
    if (value.description !== undefined)
        card.description = text(value.description, 2000);
    if (value.fields !== undefined) {
        if (!Array.isArray(value.fields) || value.fields.length > 24)
            throw new Error('插件卡片最多 24 个字段。');
        card.fields = value.fields.map(field => {
            if (!object(field))
                throw new Error('插件卡片字段无效。');
            return { label: text(field.label, 100), value: text(field.value, 2000) };
        });
    }
    if (value.table !== undefined) {
        const table = value.table;
        if (!object(table) || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 12 || !Array.isArray(table.rows) || table.rows.length > 100)
            throw new Error('插件表格大小无效。');
        const columns = table.columns.map(column => text(column, 100));
        const rows = table.rows.map(row => {
            if (!Array.isArray(row) || row.length !== columns.length)
                throw new Error('插件表格列数不匹配。');
            return row.map(cell => text(cell, 2000));
        });
        card.table = { columns, rows };
    }
    if (Buffer.byteLength(JSON.stringify(card), 'utf8') > 128 * 1024)
        throw new Error('插件卡片超过 128 KB。');
    return card;
}
//# sourceMappingURL=PluginPresentation.js.map