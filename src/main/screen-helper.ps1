# Long-lived helper for claude-ojousama (Windows PowerShell 5.1: WinRT OCR needs it).
# Protocol: one JSON request per stdin line, one JSON response per stdout line.
#   {"id":1,"cmd":"fg"}                         -> foreground window: title, class, process, physical bounds
#   {"id":2,"cmd":"ocr","path":"x.png","lang":"zh-Hans-CN"} -> recognised text lines
#   {"id":3,"cmd":"procs","names":["cloudmusic"]} -> main window titles of those processes
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PetWin {
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
