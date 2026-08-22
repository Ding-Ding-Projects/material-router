@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem Material Router - one-click build-and-run script
rem Takes a fresh checkout to a running app. Installs everything
rem it needs itself; never requires secrets or code signing.
rem Silent mode: build.bat /s   (also --silent, or SILENT=1)
rem TODO(plumbing-lane): pre-elevation check + hardened portable
rem toolchain fallback.
rem ============================================================

set "SILENT="
if /i "%~1"=="/s" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if /i "%SILENT%"=="1" set "SILENT=1"

call :log "Phase 1/3: fetching dependencies"
call "%~dp0download-dependencies.bat" /s
if errorlevel 1 goto :fail

call :log "Phase 2/3: generating brand icons if missing"
if exist "build\icons\icon.png" (
    call :log "  icons already present, skipping"
) else (
    call node scripts/generate-icons.mjs
    if errorlevel 1 goto :fail
)

call :log "Phase 3/3: build complete - starting app"
if defined SILENT (
    call :log "  silent mode: not launching the app"
    endlocal & exit /b 0
)
choice /c YN /n /m "Launch Material Router now? [Y/N] "
if errorlevel 2 (
    call :log "Skipping launch."
) else (
    start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
)
endlocal & exit /b 0

:fail
call :err "build FAILED - see messages above"
endlocal & exit /b 1

:log
echo [%time%] %~1
exit /b 0
:err
echo [ERROR] %~1 >&2
exit /b 0
