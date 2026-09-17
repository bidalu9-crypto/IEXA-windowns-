param([long]$WindowHandle,[string]$OutputFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeChromeCapture {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h,IntPtr r);
 [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
 [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr h,int x,int y);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
 [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
 public static long HitTest(IntPtr h,int x,int y) { IntPtr result; long point=((long)(ushort)y<<16)|(ushort)x; return SendMessageTimeout(h,0x84,IntPtr.Zero,new IntPtr(point),2,2000,out result)==IntPtr.Zero ? -999 : result.ToInt64(); }
}
"@
$null=[NativeChromeCapture]::SetProcessDPIAware()
$h=[IntPtr]$WindowHandle;$r=New-Object NativeChromeCapture+Rect;$client=New-Object NativeChromeCapture+Rect
if (-not [NativeChromeCapture]::GetWindowRect($h,[ref]$r)) {throw 'GetWindowRect failed'}
$null=[NativeChromeCapture]::GetClientRect($h,[ref]$client)
$width=$r.Right-$r.Left;$height=$r.Bottom-$r.Top
$bitmap=New-Object System.Drawing.Bitmap($width,$height,([Drawing.Imaging.PixelFormat]::Format32bppArgb))
$graphics=[Drawing.Graphics]::FromImage($bitmap)
$dc=$graphics.GetHdc()
try {if (-not [NativeChromeCapture]::PrintWindow($h,$dc,2)) {throw 'PrintWindow failed'}} finally {$graphics.ReleaseHdc($dc);$graphics.Dispose()}
$region=[NativeChromeCapture]::CreateRectRgn(0,0,0,0)
try {
 $kind=[NativeChromeCapture]::GetWindowRgn($h,$region)
 if ($kind -eq 3) {
  # Restore alpha only outside the measured native region; do not simulate UI.
  foreach ($y in ((0..31)+(($height-32)..($height-1)))) {
   foreach ($x in ((0..31)+(($width-32)..($width-1)))) {
    if (-not [NativeChromeCapture]::PtInRegion($region,$x,$y)) {$bitmap.SetPixel($x,$y,[Drawing.Color]::Transparent)}
   }
  }
 }
 $box=New-Object NativeChromeCapture+Rect
 $null=[NativeChromeCapture]::GetRgnBox($region,[ref]$box)
 if ($kind -eq 3) {
  $crop=$bitmap.Clone((New-Object Drawing.Rectangle($box.Left,$box.Top,($box.Right-$box.Left),($box.Bottom-$box.Top))),$bitmap.PixelFormat)
  try {$crop.Save($OutputFile,[Drawing.Imaging.ImageFormat]::Png)} finally {$crop.Dispose()}
 } else { $bitmap.Save($OutputFile,[Drawing.Imaging.ImageFormat]::Png) }
 $edge=[NativeChromeCapture]::HitTest($h,($r.Left+$box.Left+1),($r.Top+[int]($height/2)))
 $caption=[NativeChromeCapture]::HitTest($h,($r.Left+330),($r.Top+22))
 $close=[NativeChromeCapture]::HitTest($h,($r.Left+$width-26),($r.Top+25))
 [ordered]@{width=$width;height=$height;clientWidth=$client.Right-$client.Left;clientHeight=$client.Bottom-$client.Top;regionKind=$kind;regionBox=$box;leftEdgeHit=$edge;captionHit=$caption;closeHit=$close;cornerInside=[NativeChromeCapture]::PtInRegion($region,0,0)} | ConvertTo-Json -Compress
} finally {$bitmap.Dispose();$null=[NativeChromeCapture]::DeleteObject($region)}
