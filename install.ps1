<#
  Install (or update) Claude Ojousama into %LOCALAPPDATA%\Programs\ClaudeOjousama and optionally launch it.

  Why a separate install location: the DeepSeek Harness workspace carries a Low integrity
  label, and Chromium/Electron crashes when its executable is started at Low integrity.
  Copies made here inherit the normal (Medium) label of LocalAppData.

  Usage:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Launch] [-NoDesktopShortcut]
#>
param([switch]$Launch, [switch]$NoDesktopShortcut)
$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA 'Programs\ClaudeOjousama'
$rt = Join-Path $dest 'runtime'
$appDir = Join-Path $dest 'app'
$exe = Join-Path $rt 'ClaudeOjousama.exe'

function Stop-Pet {
  Get-CimInstance Win32_Process -Filter "Name='ClaudeOjousama.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($rt, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 400
}

# 1. Electron runtime ------------------------------------------------------------
$srcRt = Join-Path $src 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $srcRt 'electron.exe'))) {
  Write-Host '下载 Electron 运行时（使用 npmmirror 镜像）…'
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  Push-Location $src
  try {
    npm install --no-audit --no-fund | Out-Host
    if (-not (Test-Path (Join-Path $srcRt 'electron.exe'))) { node node_modules/electron/install.js | Out-Host }
  } finally { Pop-Location }
}
$srcVer = (Get-Content (Join-Path $srcRt 'version') -ErrorAction SilentlyContinue | Select-Object -First 1)
$dstVer = (Get-Content (Join-Path $rt 'version') -ErrorAction SilentlyContinue | Select-Object -First 1)
Stop-Pet

# 0. The app used to be installed as ClaudePet ("Claude 娘"): stop it, remove its shortcuts and install.
$oldDest = Join-Path $env:LOCALAPPDATA 'Programs\ClaudePet'
Get-CimInstance Win32_Process -Filter "Name='ClaudePet.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($oldDest, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($oldLnk in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude 娘.lnk'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Claude 娘.lnk'))) {
  if (Test-Path -LiteralPath $oldLnk) { Remove-Item -LiteralPath $oldLnk -Force }
}
if (Test-Path -LiteralPath (Join-Path $oldDest 'runtime\ClaudePet.exe')) {
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $oldDest -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "已移除旧版安装：$oldDest"
}
if (-not (Test-Path $exe) -or $srcVer -ne $dstVer) {
  Write-Host "安装 Electron $srcVer 运行时 → $rt"
  robocopy $srcRt $rt /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy runtime failed ($LASTEXITCODE)" }
  Move-Item -Force (Join-Path $rt 'electron.exe') $exe
}

# 2. App files ---------------------------------------------------------------------
Write-Host "安装桌宠程序 → $appDir"
New-Item -ItemType Directory -Force $appDir | Out-Null
robocopy (Join-Path $src 'src') (Join-Path $appDir 'src') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy src failed ($LASTEXITCODE)" }
robocopy (Join-Path $src 'assets') (Join-Path $appDir 'assets') /MIR /XD raw reference /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy assets failed ($LASTEXITCODE)" }
Copy-Item -Force (Join-Path $src 'package.json') (Join-Path $appDir 'package.json')

# 3. Desktop shortcut (the app itself maintains the Start Menu one, with its AppUserModelID)
if (-not $NoDesktopShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk = Join-Path $desktop 'Claude Ojousama.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.Arguments = "`"$appDir`""
  $s.WorkingDirectory = $rt
  $s.IconLocation = (Join-Path $appDir 'assets\icon.ico') + ',0'
  $s.Description = 'Claude Ojousama · DeepSeek Harness 桌宠'
  $s.Save()
  Write-Host "桌面快捷方式：$lnk"
}

# 4. Launch ------------------------------------------------------------------------------
if ($Launch) {
  Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process -FilePath $exe -ArgumentList "`"$appDir`"" -WorkingDirectory $rt
  Write-Host 'Claude Ojousama 启动啦～'
}
