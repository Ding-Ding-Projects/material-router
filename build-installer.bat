@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem Material Router - installer build script
rem Produces the same unsigned Squirrel.Windows installer that
rem CI publishes, through the project's supported packaging path.
rem Never signs, never tags, never pushes, never publishes a
rem release - building an installer and shipping one are
rem different actions with different authority, and this script
rem has only the first.
rem
rem The produced Setup.exe is UNSIGNED by permanent project
rem policy; Windows may show an unknown-publisher / SmartScreen
rem warning on first run. This is expected and stated here rather
rem than left for you to discover at install time.
rem
rem Silent mode: build-installer.bat /s  (also --silent, SILENT=1)
rem ============================================================

set "SILENT_INHERITED=%SILENT%"
set "SILENT="
if /i "%~1"=="/s" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if "%SILENT_INHERITED%"=="1" set "SILENT=1"

set "ROOT=%~dp0"
set "OUTDIR=%ROOT%dist\squirrel-windows"

rem ------------------------------------------------------------
rem Phase 1/4: dependencies (toolchain + project deps, pinned)
rem ------------------------------------------------------------
call :phase_begin "Phase 1/4: fetching pinned dependencies"
call "%ROOT%download-dependencies.bat" /s
if errorlevel 1 goto :fail_deps
call :phase_end "dependencies ready"

rem ------------------------------------------------------------
rem Phase 2/4: brand assets + packaging
rem ------------------------------------------------------------
call :phase_begin "Phase 2/4: brand icons"
pushd "%ROOT%"
call node scripts/generate-icons.mjs
if errorlevel 1 (
    popd
    goto :fail_icons
)
popd
call :phase_end "icons ready"

call :phase_begin "Phase 3/4: packaging the unsigned Squirrel installer"
rem Clear generated output before launch so a stale artifact can
rem never be mistaken for a fresh one.
if exist "%ROOT%dist" rmdir /s /q "%ROOT%dist"
pushd "%ROOT%"
call npx electron-builder --win squirrel
set "PKG_RC=!errorlevel!"
popd
if not "!PKG_RC!"=="0" goto :fail_package
call :phase_end "packaging finished"

rem ------------------------------------------------------------
rem Phase 4/4: verify what was built before claiming success
rem ------------------------------------------------------------
call :phase_begin "Phase 4/4: verifying artifacts"
set "SETUP="
for %%F in ("%OUTDIR%\*-Setup.exe") do if not defined SETUP set "SETUP=%%~fF"
if not defined SETUP goto :fail_no_setup
if not exist "%OUTDIR%\RELEASES" goto :fail_no_releases

set "NUPKG="
for %%F in ("%OUTDIR%\*.full.nupkg") do if not defined NUPKG set "NUPKG=%%~fF"
set "DELTA="
for %%F in ("%OUTDIR%\*.delta.nupkg") do if not defined DELTA set "DELTA=%%~fF"

call :verify_nonzero "%SETUP%" || goto :fail_empty_setup
call :verify_nonzero "%OUTDIR%\RELEASES" || goto :fail_empty_releases
if defined NUPKG call :verify_nonzero "%NUPKG%" || goto :fail_empty_nupkg
if defined DELTA call :verify_nonzero "%DELTA%" || goto :fail_empty_delta

call :verify_unsigned "%SETUP%" || goto :fail_signed
call :log "  Setup.exe        : %SETUP%"
for /f "delims=" %%H in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-FileHash -LiteralPath '%SETUP%' -Algorithm SHA256).Hash.ToLower()"') do set "SHA=%%H"
call :log "  Setup.exe SHA-256: %SHA%"
call :log "  RELEASES         : %OUTDIR%\RELEASES"
if defined NUPKG call :log "  full nupkg       : %NUPKG%"
if defined DELTA call :log "  delta nupkg      : %DELTA% (optional)"
call :log "  signature status : NotSigned - verified via Get-AuthenticodeSignature"
call :log ""
call :log "This installer is UNSIGNED by project policy. It may trigger a"
call :log "SmartScreen unknown-publisher warning when a user runs it."
call :log "Installer build OK. Nothing was tagged, pushed, or published."
call :phase_end "artifacts verified"
if defined SILENT (endlocal & exit /b 0)
pause
endlocal & exit /b 0

rem ============================================================
rem Helpers
rem ============================================================
:verify_nonzero
if not exist "%~1" exit /b 1
for %%S in ("%~1") do set "FSIZE=%%~zS"
if !FSIZE! EQU 0 exit /b 1
exit /b 0

:verify_unsigned
rem Fail closed if anything came out signed: signing is permanently
rem out of scope, so a signed artifact means something went badly wrong.
for /f "usebackq delims=" %%S in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-AuthenticodeSignature -LiteralPath '%~1').Status"`) do set "SIGSTATUS=%%S"
if /i not "!SIGSTATUS!"=="NotSigned" (
    call :err "unexpected Authenticode status '%SIGSTATUS%' on %~1 - signing is permanently out of scope"
    exit /b 1
)
exit /b 0

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
call :err "dependency fetch failed - see download-dependencies output above"
goto :fail
:fail_icons
call :err "brand icon generation failed - see scripts/generate-icons.mjs output above"
goto :fail
:fail_package
call :err "electron-builder failed - see its output above for the exact packaging error"
goto :fail
:fail_no_setup
call :err "no *-Setup.exe found under dist\squirrel-windows after a successful-looking build"
goto :fail
:fail_no_releases
call :err "RELEASES manifest missing from dist\squirrel-windows"
goto :fail
:fail_empty_setup
call :err "Setup.exe exists but is zero bytes: %SETUP%"
goto :fail
:fail_empty_releases
call :err "RELEASES exists but is zero bytes"
goto :fail
:fail_empty_nupkg
call :err "full .nupkg exists but is zero bytes: %NUPKG%"
goto :fail
:fail_empty_delta
call :err "delta .nupkg exists but is zero bytes: %DELTA%"
goto :fail
:fail_signed
call :err "artifact signature check failed above - refusing to present this as a project installer"
goto :fail
:fail
call :err "installer build FAILED at the phase named above"
endlocal & exit /b 1
