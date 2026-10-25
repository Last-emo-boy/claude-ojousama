# Long-lived helper for claude-ojousama (Windows PowerShell 5.1: WinRT OCR needs it).
# Protocol: one JSON request per stdin line, one JSON response per stdout line.
#   {"id":1,"cmd":"fg"}                         -> foreground window: title, class, process, physical bounds
#   {"id":2,"cmd":"ocr","path":"x.png","lang":"zh-Hans-CN"} -> recognised text lines
#   {"id":3,"cmd":"procs","names":["cloudmusic"]} -> main window titles of those processes
#   {"id":4,"cmd":"wins"}                       -> visible top-level windows, topmost first (z-order)
#   {"id":5,"cmd":"rect","hwnd":123}            -> one window's current bounds / state
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class PetWinInfo {
  public long Hwnd; public string Title; public string Cls; public uint Pid;
  public int X, Y, W, H; public bool Max;
}
public static class PetWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmGetInt(IntPtr h, int attr, out int v, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  public static RECT Bounds(IntPtr h) {
    RECT r;
    // DWMWA_EXTENDED_FRAME_BOUNDS = 9: the visible frame without the invisible resize border.
    if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r);
    return r;
  }

  /** Visible, uncloaked, non-tool, non-minimized top-level windows in z-order (topmost first). */
  public static List<PetWinInfo> Visible(int limit) {
    var list = new List<PetWinInfo>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
      int cloaked;
      if (DwmGetInt(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true; // DWMWA_CLOAKED
      RECT r = Bounds(h);
      if (r.Right - r.Left < 60 || r.Bottom - r.Top < 40) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      var c = new StringBuilder(128); GetClassName(h, c, 128);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(new PetWinInfo { Hwnd = h.ToInt64(), Title = t.ToString(), Cls = c.ToString(), Pid = pid,
        X = r.Left, Y = r.Top, W = r.Right - r.Left, H = r.Bottom - r.Top, Max = IsZoomed(h) });
      return list.Count < limit;
    }, IntPtr.Zero);
    return list;
  }
}
'@
# Physical pixels everywhere; the pet converts them to DIPs.
[void][PetWin]::SetProcessDPIAware()

function Get-Fg {
  $h = [PetWin]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return @{ ok = $true; none = $true } }
  $title = New-Object System.Text.StringBuilder 512
  [void][PetWin]::GetWindowText($h, $title, 512)
  $cls = New-Object System.Text.StringBuilder 256
  [void][PetWin]::GetClassName($h, $cls, 256)
  $r = New-Object PetWin+RECT
  # DWMWA_EXTENDED_FRAME_BOUNDS = 9: the visible frame without the invisible resize border.
  if ([PetWin]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [void][PetWin]::GetWindowRect($h, [ref]$r) }
  [uint32]$procId = 0
  [void][PetWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $pname = ''
  try { $pname = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  return @{
    ok = $true; hwnd = $h.ToInt64(); title = $title.ToString(); cls = $cls.ToString(); pid = $procId; process = $pname
    x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top
    minimized = [PetWin]::IsIconic($h); maximized = [PetWin]::IsZoomed($h)
  }
}

# ---- Windows.Media.Ocr ---------------------------------------------------------
$ocrReady = $false
function Init-Ocr {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
    Select-Object -First 1
  $script:engines = @{}
  $script:ocrReady = $true
}
function Await($op, [Type]$type) {
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(12000)) { throw 'WinRT call timed out' }
  return $task.Result
}
function Invoke-Ocr([string]$path, [string]$lang) {
  if (-not $script:ocrReady) { Init-Ocr }
  if (-not $lang) { $lang = 'zh-Hans-CN' }
  if (-not $script:engines.ContainsKey($lang)) {
    $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $lang))
    if (-not $eng) { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    $script:engines[$lang] = $eng
  }
  $engine = $script:engines[$lang]
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = foreach ($l in $result.Lines) { $l.Text }
    return ($lines -join "`n")
  } finally {
    $stream.Dispose()
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    switch ($req.cmd) {
      'fg' { $res = Get-Fg }
      'ocr' { $res = @{ ok = $true; text = (Invoke-Ocr $req.path $req.lang) } }
      'procs' {
        $wins = @(Get-Process -Name @($req.names) -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } |
          ForEach-Object { @{ process = $_.ProcessName; title = $_.MainWindowTitle } })
        $res = @{ ok = $true; windows = $wins }
      }
      'wins' {
        $ws = [PetWin]::Visible(48)
        $names = @{}
        $ids = @($ws | ForEach-Object { [int]$_.Pid } | Select-Object -Unique)
        foreach ($p in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $names["$($p.Id)"] = $p.ProcessName }
        $res = @{ ok = $true; windows = @($ws | ForEach-Object {
          @{ hwnd = $_.Hwnd; title = $_.Title; cls = $_.Cls; pid = $_.Pid; process = $names["$($_.Pid)"]; x = $_.X; y = $_.Y; w = $_.W; h = $_.H; maximized = $_.Max }
        }) }
      }
      'rect' {
        $h = [IntPtr][long]$req.hwnd
        if (-not [PetWin]::IsWindow($h) -or -not [PetWin]::IsWindowVisible($h)) { $res = @{ ok = $true; gone = $true } }
        else {
          $r = [PetWin]::Bounds($h)
          $res = @{ ok = $true; x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top; minimized = [PetWin]::IsIconic($h); maximized = [PetWin]::IsZoomed($h) }
        }
      }
      'ping' { $res = @{ ok = $true } }
      default { $res = @{ ok = $false; error = "unknown cmd $($req.cmd)" } }
    }
  } catch {
    $res = @{ ok = $false; error = $_.Exception.Message }
  }
  $res.id = $(if ($req) { $req.id } else { $null })
  [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
