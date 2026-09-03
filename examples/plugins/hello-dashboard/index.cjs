const fs = require('fs');
const path = require('path');

module.exports.tools = {
  async greet(args) {
    const name = String(args.name || '').trim();
    if (!name) return { output: 'name 不能为空。', success: false };
    return { output: args.formal ? `您好，${name}。很高兴为您服务。` : `你好，${name}！` , success: true };
  },

  async save_note(args, context) {
    const content = String(args.content || '').trim();
    if (!content) return { output: 'content 不能为空。', success: false };
    fs.mkdirSync(context.dataDir, { recursive: true });
    const notePath = path.join(context.dataDir, 'notes.txt');
    fs.appendFileSync(notePath, `[${new Date().toISOString()}] ${content}\n`, 'utf8');
    return { output: `便签已保存：${notePath}`, success: true };
  },
};
