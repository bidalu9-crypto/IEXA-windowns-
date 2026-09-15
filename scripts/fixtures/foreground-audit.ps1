param([Parameter(Mandatory=$true)][string]$OutputDirectory)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class ForegroundAuditContext : ApplicationContext {
 delegate void WinEvent(IntPtr hook,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint time);
 [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,WinEvent callback,uint process,uint thread,uint flags);
 [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 WinEvent callback;IntPtr hook;Timer timer;
 public ForegroundAuditContext(string dir) {
  callback=(h,e,w,o,c,t,m)=>File.AppendAllText(Path.Combine(dir,"focus-events.jsonl"),"{\"handle\":"+w.ToInt64()+",\"time\":"+m+"}\n");
  hook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0);
  if(hook==IntPtr.Zero)throw new Exception("WinEvent foreground hook failed");
  File.WriteAllText(Path.Combine(dir,"focus-ready.json"),"{\"foreground\":"+GetForegroundWindow().ToInt64()+",\"hookInstalled\":true}");
  timer=new Timer{Interval=30};timer.Tick+=(s,e)=>{if(File.Exists(Path.Combine(dir,"stop-monitor"))){
   timer.Stop();UnhookWinEvent(hook);File.WriteAllText(Path.Combine(dir,"focus-ended.json"),"{\"foreground\":"+GetForegroundWindow().ToInt64()+"}");ExitThread();
  }};timer.Start();
 }
}
"@
[System.Windows.Forms.Application]::Run([ForegroundAuditContext]::new($OutputDirectory))
