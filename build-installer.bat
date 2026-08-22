@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem Material Router - installer build script
rem Produces the same unsigned Squirrel.Windows installer that CI
rem publishes. Never signs, never tags, never pushes, never
rem publishes a release.
rem Silent mode: build-installer.bat /s  (also --silent, SILENT=1)
rem NOTE: the produced Setup.exe is UNSIGNED by project policy and
rem may trigger an unknown-publisher / SmartScreen warning.
rem TODO(plumbing-lane): verify artifact SHA-256 against release.
rem ============================================================

set "SILENT="
if /i "%~1"=="/s" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if /i "%SILENT%"=="1" set "SILENT=1"

call :log "Phase 1/4: fetching dependencies"
call "%~dp0download-dependencies.bat" /s
if errorlevel 1 goto :fail

call :log "Phase 2/4: generating brand icons"
call node scripts/generate-icons.mjs
if errorlevel 1 goto :fail

call :log "Phase 3/4: packaging Squirrel installer (unsigned)"
if exist dist rmdir /s /q dist
call npx electron-builder --win squirrel
if errorlevel 1 goto :fail

call :log "Phase 4/4: verifying artifacts"
set "SETUP="
for %%F in ("dist\squirrel-windows\*-Setup.exe") do set "SETUP=%%~fF"
if not defined SETUP goto :fail_no_setup
if not exist "dist\squirrel-windows\RELEASES" goto :fail_no_releases
set "NUPKG="
for %%F in ("dist\squirrel-windows\*.full.nupkg") do set "NUPKG=%%~nxF"
if not defined NUPKG call :log "  WARN: full .nupkg not found (delta-only output?)"

call :log "  Setup.exe : %SETUP%"
for /f "skip=1 delims=" %%H in ('certutil -hashfile "%SETUP%" SHA256') do (
    if not defined SHA set "SHA=%%H"
)
set "SHA="
for /f "delims=" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath '%SETUP%' -Algorithm SHA256).Hash.ToLower()"') do set "SHA=%%H"
call :log "  SHA-256   : %SHA%"
call :log "Installer build OK. Nothing was published."

if defined SILENT (endlocal & exit /b 0)
pause
endlocal & exit /b 0

:fail_no_setup
call :err "no *-Setup.exe found under dist\squirrel-windows"
goto :fail
:fail_no_releases
call :err "RELEASES manifest missing from dist\squirrel-windows"
goto :fail
:fail
call :err "installer build FAILED - see messages above"
if defined SILENT (endlocal & exit /b 1)
pause
endlocal & exit /b 1

:log
echo [%time%] %~1
exit /b 0
:err
echo [ERROR] %~1 >&2
exit /b 0
