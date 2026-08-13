import re

path = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\tools\ToolExecutors.ts'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Check current state
print('iconv import:', 'iconv-lite' in content)
print("encoding 'buffer':", "'buffer'" in content)
print("cmd.exe:", "'cmd.exe'" in content)
print("encode line:", "'gbk'" in content)

# Remove iconv import
content = content.replace(
    "// @ts-ignore\nimport * as iconv from 'iconv-lite';\n",
    ""
)
print('iconv removed:', 'iconv-lite' not in content)

# Revert to utf8 encoding
content = content.replace(
    "encoding: 'buffer',  // get raw bytes for GBK decoding on Windows",
    "encoding: 'utf8',"
)
print("encoding reverted to utf8:", "'utf8'" in content)

# Remove decode function and restore original output
old = (
    "        // On Windows, cmd.exe outputs GBK by default \u2014 decode to UTF-8\n"
    "        const decode = (buf: Buffer) => {\n"
    "          if (!buf) return '';\n"
    "          return process.platform === 'win32' ? iconv.decode(buf, 'gbk') : buf.toString('utf8');\n"
    "        };\n"
    "        const output = [decode(stdout as Buffer), decode(stderr as Buffer)].filter(Boolean).join('\\n').trim();"
)
new = "        const output = [stdout, stderr].filter(Boolean).join('\\n').trim();"
print('decode old found:', old in content)
content = content.replace(old, new)

# Add PYTHONIOENCODING and chcp 65001
old_env = (
    "    return new Promise((resolve) => {\n"
    "      const options: ExecOptions = {\n"
    "        cwd: this.workspaceDir,\n"
    "        timeout: effectiveTimeout,\n"
    "        maxBuffer: 10 * 1024 * 1024, // 10MB\n"
    "        encoding: 'utf8',\n"
    "        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',\n"
    "        env: { ...process.env, HOME: this.workspaceDir },\n"
    "      };\n"
    "\n"
    "      const child = exec(command, options, async (error, stdout, stderr) => {"
)
new_env = (
    "    // On Windows, force UTF-8 output: chcp 65001 + PYTHONIOENCODING for Python\n"
    "    const finalCommand = process.platform === 'win32' ? `chcp 65001 >nul && ${command}` : command;\n"
    "\n"
    "    return new Promise((resolve) => {\n"
    "      const options: ExecOptions = {\n"
    "        cwd: this.workspaceDir,\n"
    "        timeout: effectiveTimeout,\n"
    "        maxBuffer: 10 * 1024 * 1024, // 10MB\n"
    "        encoding: 'utf8',\n"
    "        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',\n"
    "        env: { ...process.env, HOME: this.workspaceDir, PYTHONIOENCODING: 'utf-8' },\n"
    "      };\n"
    "\n"
    "      const child = exec(finalCommand, options, async (error, stdout, stderr) => {"
)
print('env old found:', old_env in content)
content = content.replace(old_env, new_env)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('done')