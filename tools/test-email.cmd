@echo off
rem Sends ONE test email (see docs\TICKER.md). Optional: test-email.cmd someone@example.com sends only to that address.
cd /d "%~dp0.."
node tools\test-email.mjs %*
pause
