param([Parameter(Mandatory=$true)][string]$Title,[Parameter(Mandatory=$true)][string]$OutputDirectory,[int]$HelperPid=0)
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
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("shcore.dll")] static extern int GetProcessDpiAwareness(IntPtr process,out int awareness);
    public static int HelperDpiAwareness(int pid) {
        var process=OpenProcess(0x1000,false,pid);
        if(process==IntPtr.Zero)throw new InvalidOperationException("Helper identity is not queryable");
        try { int awareness; Marshal.ThrowExceptionForHR(GetProcessDpiAwareness(process,out awareness));return awareness; }
        finally { CloseHandle(process); }
    }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
    WinEvent callback; IntPtr hook; string directory; TextBox input; Label result; Timer timer; Panel marker; string mode="initial";
    int printRequests;
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x317 || message.Msg == 0x318) {
            printRequests++;
            if (directory != null) File.WriteAllText(Path.Combine(directory,"paint-requests.txt"),printRequests.ToString());
        }
        base.WndProc(ref message);
    }
    public BackgroundAuditForm(string title,string output) {
        directory=output; File.WriteAllText(Path.Combine(directory,"paint-requests.txt"),"0"); Text=title; Name="BackgroundAuditForm"; Size=new Size(520,260); StartPosition=FormStartPosition.Manual; Location=new Point(20,20);
        input=new TextBox { Name="AuditInput", AccessibleName="Audit input", Location=new Point(20,20), Size=new Size(400,25) };
        var apply=new Button { Name="AuditApply", Text="Apply audit", Location=new Point(20,70), Size=new Size(150,35) };
        result=new Label { Name="AuditResult", Text="No receipt", Location=new Point(20,125), Size=new Size(460,40) };
        apply.Click+=(a,b)=>{result.Text="Applied "+input.Text;File.AppendAllText(Path.Combine(directory,"receipt.txt"),input.Text+"\n");};
        marker=new Panel { Location=new Point(440,70), Size=new Size(24,24), BackColor=Color.FromArgb(229,17,191) };
        Controls.AddRange(new Control[]{input,apply,result,marker});
        callback=(h,e,w,o,c,t,m)=>File.AppendAllText(Path.Combine(directory,"foreground-events.jsonl"),"{\"handle\":"+w.ToInt64()+",\"eventTime\":"+m+"}\n");
        hook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0);
        if(hook==IntPtr.Zero)throw new InvalidOperationException("Foreground event hook failed");
        var foreground=GetForegroundWindow().ToInt64(); POINT cursor;GetCursorPos(out cursor);
        Shown+=(a,b)=>File.WriteAllText(Path.Combine(directory,"ready.json"),"{\"handle\":"+Handle.ToInt64()+",\"foreground\":"+foreground+",\"cursorX\":"+cursor.X+",\"cursorY\":"+cursor.Y+"}");
        timer=new Timer { Interval=40 }; timer.Tick+=(a,b)=>{
            var commandPath=Path.Combine(directory,"command.txt");
            if(File.Exists(commandPath)) {
                var command=File.ReadAllText(commandPath).Trim(); File.Delete(commandPath);
                if(command=="move") Location=new Point(140,110);
                else if(command=="borderless") FormBorderStyle=FormBorderStyle.None;
                else if(command=="hide") Hide();
                else throw new InvalidOperationException("Unexpected fixture command");
                mode=command;
            }
            var point=marker.PointToScreen(Point.Empty);
            File.WriteAllText(Path.Combine(directory,"geometry.json"),"{\"mode\":\""+mode+"\",\"handle\":"+Handle.ToInt64()+",\"markerX\":"+point.X+",\"markerY\":"+point.Y+",\"visible\":"+(Visible?"true":"false")+"}");
            POINT now;GetCursorPos(out now);
            File.WriteAllText(Path.Combine(directory,"state.json"),"{\"foreground\":"+GetForegroundWindow().ToInt64()+",\"cursorX\":"+now.X+",\"cursorY\":"+now.Y+"}");
            if(File.Exists(Path.Combine(directory,"stop")))Close();
        };timer.Start();
    }
    protected override void OnFormClosed(FormClosedEventArgs e){timer.Stop();UnhookWinEvent(hook);base.OnFormClosed(e);}
}
"@
if ($HelperPid -gt 0) {
    $dpi=[BackgroundAuditForm]::HelperDpiAwareness($HelperPid)
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'helper-dpi.json'),('{"awareness":'+$dpi+'}'))
}
[System.Windows.Forms.Application]::Run([BackgroundAuditForm]::new($Title,$OutputDirectory))
