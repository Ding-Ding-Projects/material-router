@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem Material Router - one-click build-and-run script
rem Takes a fresh checkout to a running app on a machine with
rem nothing installed. Installs every toolchain piece itself into
rem user-scoped locations; never touches signing material.
rem
rem Interactive runs pre-elevate up front (so anything that ever
rem needs rights fails at second zero instead of minute six).
rem Silent mode continues unelevated: everything it installs
rem resolves to a user-scoped path anyway. Silent mode never
rem blocks on a prompt and never opens a window.
rem
rem Silent mode: build.bat /s   (also --silent, or SILENT=1)
rem ============================================================

set "SILENT_INHERITED=%SILENT%"
set "SILENT="
if /i "%~1"=="/s" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if "%SILENT_INHERITED%"=="1" set "SILENT=1"

set "ROOT=%~dp0"

rem ------------------------------------------------------------
rem Phase 1/4: environment pre-flight (interactive-only elevation)
rem ------------------------------------------------------------
call :phase_begin "Phase 1/4: environment pre-flight"
if defined SILENT (
    call :log "  silent mode: continuing unelevated; every install below is user-scoped"
    goto :after_elevate
)
net session >nul 2>&1
if not errorlevel 1 (
    call :log "  already elevated"
) else (
    call :log "  not elevated; relaunching this build elevated before any work begins"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$args = @(); if ('%*' -ne '') { $args = @('%*') }; $p = Start-Process -FilePath '%~f0' -ArgumentList $args -Verb RunAs -PassThru -Wait; exit $p.ExitCode"
    if errorlevel 1 (
        call :err "elevation was declined or failed - nothing was installed or built"
        call :err "to build entirely unelevated with user-scoped installs, run: build.bat /s"
        endlocal & exit /b 1
    )
    endlocal & exit /b 0
)
:after_elevate
call :phase_end "pre-flight ok"

rem ------------------------------------------------------------
rem Phase 2/4: dependencies (toolchain + project deps, pinned)
rem ------------------------------------------------------------
call :phase_begin "Phase 2/4: fetching pinned dependencies"
call "%ROOT%download-dependencies.bat" /s
if errorlevel 1 goto :fail_deps
call :phase_end "dependencies ready"

rem ------------------------------------------------------------
rem Phase 3/4: brand assets (deterministic generator)
rem ------------------------------------------------------------
call :phase_begin "Phase 3/4: brand icons"
if exist "%ROOT%build\icons\icon.png" (
    call :log "  icons already present, skipping generation"
) else (
    call :log "  generating deterministic brand assets"
    pushd "%ROOT%"
    call node scripts/generate-icons.mjs
    set "ICON_RC=!errorlevel!"
    popd
    if not "!ICON_RC!"=="0" goto :fail_icons
)
call :phase_end "icons ready"

rem ------------------------------------------------------------
rem Phase 4/4: build complete. The launch offer is deliberately
rem the last thing this script does, after every gate has passed.
rem ------------------------------------------------------------
call :phase_begin "Phase 4/4: build complete"
call :log "  checkout is ready: npm start will launch Material Router"
call :phase_end "done"
if defined SILENT (
    call :log "silent mode: not launching the app"
    endlocal & exit /b 0
)
choice /c YN /n /m "Launch Material Router now? [Y/N] "
if errorlevel 2 (
    call :log "Skipping launch."
) else (
    start "" "%ROOT%node_modules\electron\dist\electron.exe" "%ROOT%."
)
endlocal & exit /b 0

rem ============================================================
rem Reporting helpers
rem ============================================================
:phase_begin
for /f "delims=" %%T in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Date).ToString('o')"') do set "PHASE_START=%%T"
call :log "%~1"
exit /b 0

:phase_end
if not defined PHASE_START (
    call :log "  done - %~1"
    exit /b 0
)
for /f "delims=" %%D in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "[math]::Round(((Get-Date)-[datetime]'!PHASE_START!').TotalSeconds, 1)"') do set "PHASE_SECS=%%D"
call :log "  ok in !PHASE_SECS! s - %~1"
set "PHASE_START="
exit /b 0

:log
if defined SILENT (echo %~1) else (echo [%TIME%] %~1)
exit /b 0

:err
echo [ERROR] %~1 >&2
exit /b 0

rem ============================================================
rem Failure exits
rem ============================================================
:fail_deps
call :err "dependency fetch failed - see download-dependencies output above for the exact dependency and source tried"
goto :fail
:fail_icons
call :err "brand icon generation failed - see scripts/generate-icons.mjs output above"
goto :fail
:fail
call :err "build FAILED at the phase named above"
endlocal & exit /b 1
