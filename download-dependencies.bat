@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem Material Router - one-click dependency fetcher
rem Obtains every toolchain + project dependency from canonical
rem upstreams into per-user locations. Never machine-wide, never
rem elevated when a user-scoped path exists.
rem Silent mode: download-dependencies.bat /s   (also --silent,
rem or set SILENT=1)
rem TODO(plumbing-lane): pin exact versions + verify recorded
rem SHA-256 digests for every downloaded binary via a committed
rem manifest beside this script.
rem ============================================================

set "SILENT="
if /i "%~1"=="/s" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if defined SILENT set "SILENT=1"
if /i "%SILENT%"=="1" set "SILENT=1"

call :log "Phase 1: checking for existing Node.js runtime"
set "NODE_EXE="
for %%P in (node.exe) do set "NODE_EXE=%%~$PATH:P"
if defined NODE_EXE (
    call :log "  found: !NODE_EXE!"
    goto :node_ok
)

call :log "  Node.js not found; installing user-scoped copy"
call :install-node || goto :fail

:node_ok
call :log "Phase 2: verifying npm"
where npm >nul 2>nul || goto :fail_npm
for /f "delims=" %%V in ('node -p "process.version"') do call :log "  node %%V"

call :log "Phase 3: installing project dependencies (npm ci)"
call npm ci --no-audit --no-fund
if errorlevel 1 goto :fail_ci

call :log "Phase 4: verifying Electron binary is materialized"
if exist "node_modules\electron\dist\electron.exe" (
    call :log "  electron.exe present"
) else (
    call :log "  electron.exe missing; running electron's own install step"
    pushd node_modules\electron
    call node install.js
    popd
    if not exist "node_modules\electron\dist\electron.exe" goto :fail_electron
)

call :log "All dependencies ready."
endlocal & exit /b 0

:install-node
rem Prefer winget (ships with current Windows), fall back to portable zip.
where winget >nul 2>nul
if errorlevel 1 goto :portable_node
call :log "  winget found; installing OpenJS.NodeJS.LTS (user scope)"
winget install --id OpenJS.NodeJS.LTS --scope user --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto :portable_node
rem Refresh PATH for THIS process after install.
for /f "tokens=2*" %%A in ('reg query HKCU\Environment /v Path 2^>nul') do set "USER_PATH=%%B"
set "PATH=%PATH%;%USER_PATH%"
for %%P in (node.exe) do set "NODE_EXE=%%~$PATH:P"
if defined NODE_EXE exit /b 0
:portable_node
call :log "  falling back to portable zip from nodejs.org"
set "NODE_DIR=%LOCALAPPDATA%\material-router-toolchain\node"
if not exist "%NODE_DIR%\node.exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path (Split-Path '%NODE_DIR%') | Out-Null; $z=Join-Path $env:TEMP 'node-portable.zip'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip' -OutFile $z; Expand-Archive -Force $z (Split-Path '%NODE_DIR%'); Move-Item -Force (Join-Path (Split-Path '%NODE_DIR%') 'node-v22.14.0-win-x64') '%NODE_DIR%'"
    if errorlevel 1 exit /b 1
)
set "PATH=%PATH%;%NODE_DIR%"
exit /b 0

:fail_npm
call :err "npm not found even after Node install"
goto :fail
:fail_ci
call :err "npm ci failed"
goto :fail
:fail_electron
call :err "electron binary could not be materialized"
goto :fail
:fail
call :err "dependency fetch FAILED - see messages above"
endlocal & exit /b 1

:log
if defined SILENT (echo %~1) else (echo [%time%] %~1)
exit /b 0
:err
echo [ERROR] %~1 >&2
exit /b 0
