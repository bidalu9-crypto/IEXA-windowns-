import re

path = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\tools\ToolExecutors.ts'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

old = '''    return new Promise((resolve) => {
      const options: ExecOptions = {
        cwd: this.workspaceDir,
        timeout: effectiveTimeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: 'utf8',
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        env: { ...process.env, HOME: this.workspaceDir, CHCP: '65001' },
      };

      const child = exec(command, options, async (error, stdout, stderr) => {'''

new = '''    // On Windows, force UTF-8 code page to avoid garbled Chinese output
    const finalCommand = process.platform === 'win32' ? \x60chcp 65001 >nul && ${command}\x60 : command;

    return new Promise((resolve) => {
      const options: ExecOptions = {
        cwd: this.workspaceDir,
        timeout: effectiveTimeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: 'utf8',
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        env: { ...process.env, HOME: this.workspaceDir },
      };

      const child = exec(finalCommand, options, async (error, stdout, stderr) => {'''

print('old found:', old in c)
c = c.replace(old, new)
with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('done')