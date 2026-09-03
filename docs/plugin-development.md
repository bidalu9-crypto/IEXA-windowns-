# IEXA 插件开发

插件是包含 `iexa-plugin.json` 的本地文件夹。用户在“拓展”页面选择该文件夹后，IEXA 会校验并复制到工作区的 `.iexa-plugins` 目录。

## 清单

```json
{
  "id": "hello-dashboard",
  "name": "Hello Dashboard",
  "version": "1.0.0",
  "description": "示例插件",
  "author": "IEXA",
  "main": "index.cjs",
  "ui": "ui/index.html",
  "tools": [
    {
      "name": "greet",
      "description": "生成问候语",
      "parameters": {
        "name": { "type": "string", "description": "姓名" }
      },
      "required": ["name"]
    }
  ]
}
```

`id` 必须是 3-64 位小写标识符，`version` 使用 SemVer。`main` 与 `ui` 都必须是插件目录内的相对路径。插件最多声明 32 个工具。

## 执行入口

入口使用 CommonJS，可导出 `tools` 映射：

```js
module.exports.tools = {
  async greet(args, context) {
    return { output: `你好，${args.name}`, success: true };
  }
};
```

也可以导出统一处理器：

```js
module.exports.execute = async (toolName, args, context) => ({
  output: `${toolName}: ${JSON.stringify(args)}`,
  success: true
});
```

插件在独立 Node 子进程中运行。`context` 提供：

- `workspaceDir`: IEXA 工作区。
- `pluginDir`: 当前插件安装目录。
- `dataDir`: 当前插件的持久数据目录，卸载插件时保留。

每次调用限时 30 秒，输入上限 2 MB，输出上限 8 MB。

## 可视化界面

`ui` 页面运行在无同源权限的沙箱 iframe 中。IEXA 在页面加载后通过 `MessageChannel` 发送专用通信端口，插件先接收并保存端口：

```js
let bridge;
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'iexa-plugin-init' || !event.ports?.[0]) return;
  bridge = event.ports[0];
  bridge.onmessage = (event) => console.log(event.data);
  bridge.start();
});
```

调用插件工具时通过该端口发送：

```js
bridge.postMessage({
  type: 'iexa-plugin-call',
  requestId: 'unique-id',
  tool: 'greet',
  arguments: { name: 'IEXA' }
});
```

专用端口返回：

```js
{
  type: 'iexa-plugin-result',
  requestId: 'unique-id',
  result: { output: '你好，IEXA', success: true }
}
```

失败时返回同样结构并包含 `error` 字符串。完整可安装示例位于 `examples/plugins/hello-dashboard`。
