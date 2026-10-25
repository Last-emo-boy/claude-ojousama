@echo off
rem Install/update Claude Ojousama into %LOCALAPPDATA%\Programs\ClaudeOjousama and launch it.
rem (Electron cannot start from inside the DSH workspace: it carries a Low integrity label.)
set ELECTRON_RUN_AS_NODE=
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Launch
