using System.Drawing;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace Iexa.DesktopAgent;

/// <summary>Discover real standard Win32 menu command IDs; no app-specific constants,
/// pointer events, keyboard shortcuts or submenu expansion. Restricted to owned desktops.</summary>
internal static class Win32MenuAutomation
{
    sealed record Command(uint Id, string Name, bool Enabled);
    static List<Command> Read(IntPtr window)
    {
        var commands = new List<Command>(); var visited = new HashSet<IntPtr>();
        void Walk(IntPtr menu, string prefix, bool parentEnabled, int depth)
        {
            if (menu == IntPtr.Zero || depth > 6 || !visited.Add(menu) || commands.Count >= 256) return;
            var count = Math.Clamp(GetMenuItemCount(menu), 0, 256);
            for (uint i = 0; i < count && commands.Count < 256; i++)
            {
                var buffer = Marshal.AllocHGlobal(2048);
                try
                {
                    var item = new MENUITEMINFO { cbSize = (uint)Marshal.SizeOf<MENUITEMINFO>(), fMask = 0x147, dwTypeData = buffer, cch = 1023 };
                    if (!GetMenuItemInfo(menu, i, true, ref item) || (item.fType & 0x900) != 0 || item.cch >= 1023) continue;
                    var label = (Marshal.PtrToStringUni(buffer) ?? "").Split('\t')[0].Replace("&", "").Trim();
                    if (label.Length == 0) continue;
                    var name = prefix.Length > 0 ? prefix + " > " + label : label;
                    var enabled = parentEnabled && (item.fState & 3) == 0;
                    if (item.hSubMenu != IntPtr.Zero) Walk(item.hSubMenu, name, enabled, depth + 1);
                    else if (item.wID > 0 && item.wID < 0xffff) commands.Add(new Command(item.wID, name, enabled));
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
        }
        Walk(GetMenu(window), "", true, 0); return commands;
    }
    static string Fingerprint(IntPtr window, List<Command> commands) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(GetMenu(window).ToInt64()+"|"+string.Join("|",commands.Select(c=>$"{c.Id}:{c.Name}:{c.Enabled}")))));
    internal static MatureElement[] Observe(IntPtr window, long generation, int limit)
    {
        if (!IsolatedDesktopHost.IsVerified()) return [];
        var commands = Read(window); var hash = Fingerprint(window, commands); GetWindowThreadProcessId(window,out var pid);
        return commands.Take(limit).Select(c => {
            var id = $"menu_{window.ToInt64()}_{c.Id}_{generation}";
            var selector = new AutomationSelector("win32-menu",window.ToInt64(),(int)pid,[],"menu-command:"+c.Id,"MenuCommand",c.Name,"Win32Menu",0,0,0,0,generation,c.Id,hash);
            // Zero bounds intentionally: this is an available menu command, not a visible click target.
            return new MatureElement(id,"menucommand",c.Name,Rectangle.Empty,c.Enabled,selector);
        }).ToArray();
    }
    internal static AutomationActionResult Click(AutomationSelector selector, Action cancellationCheck)
    {
        AutomationActionResult Fail(string stage,string message) => new(false,false,"win32-menu","win32_menu_command",selector,stage,message);
        if (!IsolatedDesktopHost.IsVerified()) return Fail("desktop-ownership","Menu commands require a verified owned non-input desktop.");
        var window = new IntPtr(selector.Hwnd);
        IsolatedDesktopHost.VerifyWindow(window);
        if (!IsWindow(window)) return Fail("window","Menu owner closed.");
        GetWindowThreadProcessId(window,out var pid);
        if (pid != selector.ProcessId) return Fail("window","Menu owner process changed.");
        var commands = Read(window);
        if (Fingerprint(window,commands) != selector.MenuFingerprint) return Fail("snapshot","Native menu changed; observe before input.");
        var matches = commands.Where(c=>c.Id==selector.MenuCommandId).ToArray();
        if (matches.Length != 1 || matches[0].Name != selector.Name || !matches[0].Enabled) return Fail("target","Menu command missing, disabled or ambiguous.");
        cancellationCheck();
        var sent = SendMessageTimeout(window,0x111,new UIntPtr(matches[0].Id),IntPtr.Zero,0x23,1200,out _);
        if (sent == IntPtr.Zero) return Fail("dispatch","Menu handler timed out or exited; command may have executed. No retry or alternate backend.");
        cancellationCheck();
        return new(true,false,"win32-menu","win32_menu_command",selector);
    }
    [StructLayout(LayoutKind.Sequential)] struct MENUITEMINFO { public uint cbSize,fMask,fType,fState,wID; public IntPtr hSubMenu,hbmpChecked,hbmpUnchecked,dwItemData,dwTypeData; public uint cch; public IntPtr hbmpItem; }
    [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr window);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll", EntryPoint="GetMenuItemInfoW", CharSet=CharSet.Unicode)] static extern bool GetMenuItemInfo(IntPtr menu,uint item,bool byPosition,ref MENUITEMINFO info);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window,uint message,UIntPtr wParam,IntPtr lParam,uint flags,uint timeout,out UIntPtr result);
}
