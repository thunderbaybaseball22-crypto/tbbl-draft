@echo off
rem COMMISSIONER ONLY. Sets a temporary password for one owner: set-password.cmd owner@example.com (docs\TICKER.md).
cd /d "%~dp0.."
node tools\set-password.mjs %*
pause
