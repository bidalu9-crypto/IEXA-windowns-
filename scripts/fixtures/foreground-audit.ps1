param([Parameter(Mandatory=$true)][string]$OutputDirectory)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class ForegroundAuditContext : ApplicationContext {
 delegate void WinEvent(IntPtr hook,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint time);
 delegate IntPtr InputEvent(int code,IntPtr message,IntPtr data);
 [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] struct MouseInput { public Point point;public uint data,flags,time;public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public uint key,scan,flags,time;public UIntPtr extra; }
 [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,WinEvent callback,uint process,uint thread,uint flags);
 [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id,InputEvent callback,IntPtr module,uint thread);
 [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
 [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
 [DllImport("kernel32.dll",CharSet=CharSet.Auto)] static extern IntPtr GetModuleHandle(string module);
 WinEvent callback;InputEvent mouseCallback,keyboardCallback;IntPtr hook,mouseHook,keyboardHook;Timer timer;
 Point cursor;long cursorChanges,mouseEvents,keyboardEvents,injectedMouseEvents,injectedKeyboardEvents;
 string directory;
 string State(bool ready) {
  Point point;if(!GetCursorPos(out point))throw new Exception("GetCursorPos failed");
  return "{\"foreground\":"+GetForegroundWindow().ToInt64()+",\"cursor\":{\"x\":"+point.x+",\"y\":"+point.y+"},\"hookInstalled\":true,\"mouseHookInstalled\":true,\"keyboardHookInstalled\":true,\"cursorChanges\":"+cursorChanges+",\"mouseEvents\":"+mouseEvents+",\"keyboardEvents\":"+keyboardEvents+",\"injectedMouseEvents\":"+injectedMouseEvents+",\"injectedKeyboardEvents\":"+injectedKeyboardEvents+"}";
 }
 void SampleCursor() {
  Point point;if(!GetCursorPos(out point))return;
  if(point.x!=cursor.x||point.y!=cursor.y){cursorChanges++;File.AppendAllText(Path.Combine(directory,"cursor-events.jsonl"),"{\"x\":"+point.x+",\"y\":"+point.y+",\"ticks\":"+Environment.TickCount+"}\n");cursor=point;}
 }
 void CleanupHooks() {if(hook!=IntPtr.Zero)UnhookWinEvent(hook);if(mouseHook!=IntPtr.Zero)UnhookWindowsHookEx(mouseHook);if(keyboardHook!=IntPtr.Zero)UnhookWindowsHookEx(keyboardHook);}
 public ForegroundAuditContext(string dir) {
  directory=dir;
  callback=(h,e,w,o,c,t,m)=>File.AppendAllText(Path.Combine(dir,"focus-events.jsonl"),"{\"handle\":"+w.ToInt64()+",\"time\":"+m+"}\n");
  mouseCallback=(code,message,data)=>{
   if(code>=0){mouseEvents++;var input=(MouseInput)Marshal.PtrToStructure(data,typeof(MouseInput));if((input.flags&1)!=0){injectedMouseEvents++;File.AppendAllText(Path.Combine(dir,"input-events.jsonl"),"{\"kind\":\"injected-mouse\",\"message\":"+message.ToInt64()+",\"time\":"+input.time+"}\n");}}
   return CallNextHookEx(mouseHook,code,message,data);
  };
  keyboardCallback=(code,message,data)=>{
   if(code>=0){keyboardEvents++;var input=(KeyboardInput)Marshal.PtrToStructure(data,typeof(KeyboardInput));if((input.flags&16)!=0){injectedKeyboardEvents++;File.AppendAllText(Path.Combine(dir,"input-events.jsonl"),"{\"kind\":\"injected-keyboard\",\"time\":"+input.time+"}\n");}}
   return CallNextHookEx(keyboardHook,code,message,data);
  };
  hook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0);
  if(hook==IntPtr.Zero)throw new Exception("WinEvent foreground hook failed");
  mouseHook=SetWindowsHookEx(14,mouseCallback,GetModuleHandle(null),0);
  keyboardHook=SetWindowsHookEx(13,keyboardCallback,GetModuleHandle(null),0);
  if(mouseHook==IntPtr.Zero||keyboardHook==IntPtr.Zero){CleanupHooks();throw new Exception("Low-level input audit hook failed");}
  if(!GetCursorPos(out cursor)){CleanupHooks();throw new Exception("Initial GetCursorPos failed");}
  File.WriteAllText(Path.Combine(dir,"focus-ready.json"),State(true));
  timer=new Timer{Interval=30};timer.Tick+=(s,e)=>{SampleCursor();if(File.Exists(Path.Combine(dir,"stop-monitor"))){
   timer.Stop();File.WriteAllText(Path.Combine(dir,"focus-ended.json"),State(false));CleanupHooks();ExitThread();
  }};timer.Start();
 }
}
"@
[System.Windows.Forms.Application]::Run([ForegroundAuditContext]::new($OutputDirectory))
