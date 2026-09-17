import { ChildProcess, spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const liveWorkspaces = new Set<NativeIsolatedWorkspace>();
export async function controlNativeIsolatedWorkspaces(operation: 'pause' | 'resume', signal?: AbortSignal) {
  return Promise.all([...liveWorkspaces].map(workspace => workspace.operatorControl(operation,signal)));
}

interface WorkspaceReady { desktopName: string; pid: number; hostPid: number; port: number; jobBound: boolean; }
/** Native desktop UI isolation only. Existing user windows, filesystem/network and
 * account credentials are not moved or sandboxed. Never switch the input desktop. */
export class NativeIsolatedWorkspace {
  private child?: ChildProcess;
  private pending?: Promise<WorkspaceReady>;
  private ready?: WorkspaceReady;
  private closed = false;
  private failed = false;
  private directory?: string;
  constructor(private readonly appRoot: string, private readonly executableOverride?: string) {}
  async ensureStarted(signal?: AbortSignal): Promise<WorkspaceReady> {
    if (signal?.aborted) throw new Error('Isolated workspace creation cancelled.');
    if (this.closed || this.failed) throw new Error('Isolated workspace closed or lost; do not replay prior actions. Start a new explicit workspace.');
    if (this.ready) {
      if (this.child?.exitCode !== null || this.child?.signalCode !== null) throw new Error('Isolated worker host exited; previous app state may be lost.');
      return this.ready;
    }
    this.pending ??= this.start(signal).catch(error => {
      const cancelled = signal?.aborted === true;
      this.cleanupAttempt();
      if (!cancelled) this.failed = true;
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private executable(): string {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || path.dirname(process.execPath);
    const candidates = this.executableOverride ? [this.executableOverride] : [
      path.join(this.appRoot,'desktop-agent','publish','Iexa.DesktopAgent.exe'),
      path.join(resources,'app.asar.unpacked','desktop-agent','publish','Iexa.DesktopAgent.exe'),
      path.join(resources,'desktop-agent','publish','Iexa.DesktopAgent.exe'),
    ];
    for (const exe of candidates) {
      try {
        const capability = JSON.parse(fs.readFileSync(path.join(path.dirname(exe),'isolated-desktop-capability.json'),'utf8').replace(/^\uFEFF/,''));
        const hash = createHash('sha256').update(fs.readFileSync(exe.replace(/\.exe$/i,'.dll'))).digest('hex');
        if (fs.existsSync(exe) && capability.version === 1 && hash === String(capability.sha256).toLowerCase()) return exe;
      } catch { /* An old helper must not be launched with unrecognized isolation arguments. */ }
    }
    throw new Error('A rebuilt native isolated-desktop helper and matching capability hash are required; no foreground fallback.');
  }
  private async start(signal?: AbortSignal): Promise<WorkspaceReady> {
    if (process.platform !== 'win32') throw new Error('Native isolated workspace requires Windows.');
    const exe = this.executable();
    const port = await new Promise<number>((resolve,reject) => {
      const server = net.createServer(); server.once('error',reject);
      server.listen(0,'127.0.0.1',()=>{const p=(server.address() as net.AddressInfo).port;server.close(error=>error?reject(error):resolve(p));});
    });
    if (signal?.aborted || this.closed) throw new Error('Isolated workspace creation cancelled.');
    this.directory = path.join(process.env.LOCALAPPDATA || os.tmpdir(),'IEXA-WIN','desktop-workspaces',randomUUID());
    fs.mkdirSync(this.directory,{recursive:true});
    fs.writeFileSync(path.join(this.directory,'request.json'),JSON.stringify({Port:port,ParentPid:process.pid}),{mode:0o600});
    const fd=fs.openSync(path.join(this.directory,'host.log'),'a');
    try { this.child=spawn(exe,['--isolated-host',this.directory],{windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,IEXA_ISOLATED_DESKTOP:''}}); }
    finally { fs.closeSync(fd); }
    let launchError: Error | undefined;
    this.child.on('error',error=>{launchError=error;}); this.child.unref();
    const deadline=Date.now()+15000;
    while(Date.now()<deadline) {
      if (signal?.aborted || this.closed) throw new Error('Isolated workspace creation cancelled.');
      if (launchError) throw launchError;
      const errorFile=path.join(this.directory,'error.json');
      if (fs.existsSync(errorFile)) throw new Error(`Isolated host failed: ${fs.readFileSync(errorFile,'utf8')}`);
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`Isolated host exited before readiness. See ${this.directory}`);
      const readyFile=path.join(this.directory,'ready.json');
      if(fs.existsSync(readyFile)) {
        let info: WorkspaceReady | undefined;
        try { info=JSON.parse(fs.readFileSync(readyFile,'utf8')); } catch { /* Partial readiness file, no action dispatched. */ }
        if(info) {
          if(info.hostPid !== this.child.pid || info.port !== port || !info.jobBound || !/^IEXA-Owned-[a-f0-9]{32}$/.test(info.desktopName)) throw new Error('Isolated host identity mismatch.');
          try {
            const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)});
            const health=await response.json() as any;
            if(response.ok && health.pid===info.pid && health.product==='IEXA Desktop Agent' && health.protocolVersion===6 && health.isolatedDesktop?.verified===true && health.isolatedDesktop.desktopName===info.desktopName) {this.ready=info;liveWorkspaces.add(this);return info;}
          } catch { /* Only readiness polling retries, never app actions. */ }
        }
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error(`Isolated worker did not become ready. See ${this.directory}`);
  }
  private cleanupAttempt(): void {
    liveWorkspaces.delete(this);
    const directory = this.directory; const child = this.child;
    try { if (directory) fs.writeFileSync(path.join(directory, 'stop'), ''); } catch {}
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    this.child = undefined; this.ready = undefined; this.directory = undefined;
    if (directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} }
  }
  async operatorControl(operation: 'pause' | 'resume', signal?: AbortSignal) {
    const info=this.ready;
    if(!info || this.closed)return {ok:true,closed:true};
    try {
      const endpoint=`http://127.0.0.1:${info.port}`;
      const response=await fetch(`${endpoint}/health`,{signal:signal || AbortSignal.timeout(1200)});
      const health=await response.json() as any;
      if(!response.ok || health.pid!==info.pid || health.isolatedDesktop?.desktopName!==info.desktopName) throw new Error('Isolated worker identity changed.');
      const result=await fetch(`${endpoint}/${operation}`,{method:'POST',signal:signal || AbortSignal.timeout(1200)});
      const body=await result.json() as any;
      if(!result.ok || body.ok!==true)throw new Error('Native operator control failed.');
      return {ok:true,desktopName:info.desktopName,operation};
    } catch(error){return {ok:false,desktopName:info.desktopName,error:(error as Error).message};}
  }
  close(): void {
    if(this.closed)return;this.closed=true;liveWorkspaces.delete(this);
    if(this.directory)fs.writeFileSync(path.join(this.directory,'stop'),'');
    const child=this.child;
    if(child && child.exitCode===null && child.signalCode===null) {
      const timer=setTimeout(()=>{if(child.exitCode===null && child.signalCode===null)child.kill();},5000);timer.unref();
      child.once('exit',()=>clearTimeout(timer));
    }
  }
  diagnostics() { return {directory:this.directory,ready:this.ready,closed:this.closed,failed:this.failed}; }
}
