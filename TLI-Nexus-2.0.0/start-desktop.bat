@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  echo Install it from https://nodejs.org/
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); if(a<22||(a===22&&b<13)){console.error('Detected Node.js '+process.versions.node+'. Required: 22.13 or newer.');process.exit(1)}"
if errorlevel 1 (
  pause
  exit /b 1
)
if not exist node_modules\electron\dist\electron.exe (
  echo Installing TLI Nexus dependencies. Internet connection is required for the first launch...
  call npm install --include=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection and npm permissions.
    pause
    exit /b 1
  )
)
call npm run desktop
if errorlevel 1 pause
endlocal
