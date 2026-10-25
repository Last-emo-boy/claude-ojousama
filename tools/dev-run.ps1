# Dev launcher: runs the workspace sources with the installed runtime (run install.ps1 once).
# The runtime must live OUTSIDE the DSH workspace: the workspace carries a Low integrity
# label and Chromium crashes when started at Low IL. Exposes test hooks via --inspect.
param([string]$Runtime = "$env:LOCALAPPDATA\Programs\ClaudeOjousama\runtime", [int]$Inspect = 9229)
$app = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $Runtime 'ClaudeOjousama.exe'
Get-CimInstance Win32_Process -Filter "Name='ClaudeOjousama.exe'" |
  Where-Object { $_.ExecutablePath -like "$Runtime*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:CLAUDE_PET_DEBUG = '1'
$log = Join-Path $env:TEMP 'claude-ojousama-dev.log'
$proc = Start-Process -FilePath $exe -ArgumentList @("--inspect=$Inspect", "`"$app`"") -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
"pid $($proc.Id)"
$proc.WaitForExit()
"exit $($proc.ExitCode)"
Get-Content $log, "$log.err" -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch 'Debugger|For help' } | Select-Object -Last 40
