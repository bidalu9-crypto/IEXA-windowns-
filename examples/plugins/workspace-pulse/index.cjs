const fs = require('node:fs'), path = require('node:path');
module.exports.tools = {
  async inspect(args, context) {
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50) return { success: false, output: 'limit 需为 1–50 的整数。' };
    const entries = fs.readdirSync(context.workspaceDir, { withFileTypes: true })
      .filter(entry => args.includeHidden || !entry.name.startsWith('.'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const rows = entries.slice(0, args.limit).map(entry => {
      const stat = fs.lstatSync(path.join(context.workspaceDir, entry.name));
      return [entry.name, entry.isSymbolicLink() ? '链接' : entry.isDirectory() ? '文件夹' : '文件', entry.isFile() ? `${stat.size} B` : '—'];
    });
    const ui = { version: 1, title: '工作区文件快照', description: '此卡片记录调用时的真实文件信息；历史回放不会重新扫描。', fields: [{ label: '可见条目', value: String(entries.length) }, { label: '本次展示', value: String(rows.length) }], table: { columns: ['名称', '类型', '大小'], rows } };
    return { success: true, output: rows.map(row => row.join(' · ')).join('\n') || '工作区为空。', ui };
  }
};
