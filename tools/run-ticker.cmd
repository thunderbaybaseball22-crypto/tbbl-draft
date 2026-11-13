@echo off
rem Runs one ticker pass and appends the result to %USERPROFILE%\.tbbl\ticker.log. Used by Windows Task Scheduler (docs\TICKER.md).
cd /d "%~dp0.."
if not exist "%USERPROFILE%\.tbbl" mkdir "%USERPROFILE%\.tbbl"
rem Trust the Windows certificate store (needed on networks that inspect HTTPS traffic).
set NODE_OPTIONS=--use-system-ca
rem Use the per-user Node install if it exists; otherwise fall back to node on PATH.
set "TBBL_NODE=%LOCALAPPDATA%\nodejs\node-v26.13.1-win-x64\node.exe"
rem Then the standard installer location (Task Scheduler may not have Node on its PATH).
if not exist "%TBBL_NODE%" set "TBBL_NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%TBBL_NODE%" set "TBBL_NODE=node"
"%TBBL_NODE%" tools\ticker.mjs >> "%USERPROFILE%\.tbbl\ticker.log" 2>&1
