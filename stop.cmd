@echo off
setlocal
cd /d "%~dp0"
node src\cli.js stop
if errorlevel 1 pause
