@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  pause
  exit /b 1
)
echo Installing build dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto failed
echo Running release checks...
call npm run release:check
if errorlevel 1 goto failed
echo Building NSIS installer and portable EXE...
call npm run dist:win
if errorlevel 1 goto failed
echo.
echo Build completed. See the release folder.
explorer "%~dp0release"
exit /b 0
:failed
echo Build failed. Review the error output above.
pause
exit /b 1
