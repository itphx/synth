@echo off
rem Synth launcher for the offline bundle (bundled Node, local tools in PATH).
setlocal
set "ROOT=%~dp0.."
set "PATH=%ROOT%\runtime\node;%ROOT%\tools;%PATH%"
if not defined HOME set "HOME=%USERPROFILE%"
"%ROOT%\runtime\node\node.exe" "%ROOT%\app\dist\cli.js" %*
exit /b %ERRORLEVEL%
