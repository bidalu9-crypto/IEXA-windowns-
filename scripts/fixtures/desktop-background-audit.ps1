param([Parameter(Mandatory=$true)][string]$Title,[Parameter(Mandatory=$true)][string]$OutputDirectory)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @"
using System;
using System.IO;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class BackgroundAuditForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    delegate void WinEvent(IntPtr hook,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,WinEvent callback,uint process,uint thread,uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
    WinEvent callback; IntPtr hook; string directory; TextBox input; Label result; Timer timer;
    public BackgroundAuditForm(string title,string output) {
        directory=output; Text=title; Name="BackgroundAuditForm"; Size=new Size(520,260); StartPosition=FormStartPosition.Manual; Location=new Point(20,20);
        input=new TextBox { Name="AuditInput", AccessibleName="Audit input", Location=new Point(20,20), Size=new Size(400,25) };
        var apply=new Button { Name="AuditApply", Text="Apply audit", Location=new Point(20,70), Size=new Size(150,35) };
        result=new Label { Name="AuditResult", Text="No receipt", Location=new Point(20,125), Size=new Size(460,40) };
        apply.Click+=(a,b)=>{result.Text="Applied "+input.Text;File.AppendAllText(Path.Combine(directory,"receipt.txt"),input.Text+"\n");};
        Controls.AddRange(new Control[]{input,apply,result});
        callback=(h,e,w,o,c,t,m)=>File.AppendAllText(Path.Combine(directory,"foreground-events.jsonl"),"{\"handle\":"+w.ToInt64()+",\"eventTime\":"+m+"}\n");
        hook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0);
        if(hook==IntPtr.Zero)throw new InvalidOperationException("Foreground event hook failed");
        var foreground=GetForegroundWindow().ToInt64(); POINT cursor;GetCursorPos(out cursor);
        Shown+=(a,b)=>File.WriteAllText(Path.Combine(directory,"ready.json"),"{\"handle\":"+Handle.ToInt64()+",\"foreground\":"+foreground+",\"cursorX\":"+cursor.X+",\"cursorY\":"+cursor.Y+"}");
        timer=new Timer { Interval=40 }; timer.Tick+=(a,b)=>{
            POINT now;GetCursorPos(out now);
            File.WriteAllText(Path.Combine(directory,"state.json"),"{\"foreground\":"+GetForegroundWindow().ToInt64()+",\"cursorX\":"+now.X+",\"cursorY\":"+now.Y+"}");
            if(File.Exists(Path.Combine(directory,"stop")))Close();
        };timer.Start();
    }
    protected override void OnFormClosed(FormClosedEventArgs e){timer.Stop();UnhookWinEvent(hook);base.OnFormClosed(e);}
}
"@
[System.Windows.Forms.Application]::Run([BackgroundAuditForm]::new($Title,$OutputDirectory))
