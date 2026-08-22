@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem Material Router - one-click dependency fetcher
rem Obtains every toolchain + project dependency from canonical
rem upstreams into per-user locations, pinned by
rem scripts/dependency-manifest.json and verified by SHA-256.
rem Never machine-wide, never elevated, never any signing material.
rem
rem Silent mode: download-dependencies.bat /s
rem              (also --silent, or set SILENT=1)
rem Exit code 0 = everything ready; non-zero = first real failure,
rem named in the message above it.
rem ============================================================

rem Capture an inherited SILENT=1 before clearing the variable: setlocal
rem copies the caller's environment, so the env-var silent mode must be
rem read before we reset anything.
set "SILENT_INHERITED=%SILENT%"
set "SILENT="
if /i "%~1"=="/s" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if "%SILENT_INHERITED%"=="1" set "SILENT=1"

set "ROOT=%~dp0"
set "TOOLCHAIN=%LOCALAPPDATA%\material-router-toolchain"
set "NODE_DIR=%TOOLCHAIN%\node"
set "MANIFEST=%ROOT%scripts\dependency-manifest.json"

rem ------------------------------------------------------------
rem Phase 1/5: read the committed dependency manifest
rem ------------------------------------------------------------
call :phase_begin "Phase 1/5: reading scripts/dependency-manifest.json"
if not exist "%MANIFEST%" goto :fail_no_manifest
for /f "tokens=1-5 delims=|" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$m = Get-Content -LiteralPath '%MANIFEST%' -Raw | ConvertFrom-Json; $n = $m.toolchain.node; Write-Output ($n.version + '|' + $n.portable.url + '|' + $n.portable.sha256 + '|' + $n.winget.packageId + '|' + $n.portable.archiveRootDir)")') do (
    set "NODE_VER=%%A"
    set "NODE_URL=%%B"
    set "NODE_SHA=%%C"
    set "NODE_WINGET_ID=%%D"
    set "NODE_ROOTDIR=%%E"
)
if not defined NODE_SHA goto :fail_manifest_parse
call :log "  pinned node %NODE_VER%"
call :log "  pinned archive root dir: %NODE_ROOTDIR%"
call :log "  pinned archive sha256: %NODE_SHA%"
call :phase_end "manifest loaded"
if errorlevel 1 goto :fail

rem ------------------------------------------------------------
rem Phase 2/5: locate or install the Node.js runtime
rem ------------------------------------------------------------
call :phase_begin "Phase 2/5: locating or installing the Node.js runtime"
call :find_node
if defined NODE_EXE (
    call :log "  found: !NODE_EXE!"
    goto :node_ok
)

call :log "  no usable Node.js runtime found; installing user-scoped copy"
call :install_node || goto :fail_node
call :find_node
if not defined NODE_EXE goto :fail_node
call :log "  installed: !NODE_EXE!"

:node_ok
for /f "delims=" %%V in ('"%NODE_EXE%" -p "process.version"') do set "GOT_NODE_VER=%%V"
call :log "  node in use: !GOT_NODE_VER!"
call :phase_end "node runtime ready"

rem ------------------------------------------------------------
rem Phase 3/5: npm project dependencies
rem ------------------------------------------------------------
call :phase_begin "Phase 3/5: installing project dependencies (npm ci, lockfile-pinned)"
set "NPM_CMD=npm"
if exist "%NODE_DIR%\npm.cmd" set "NPM_CMD=%NODE_DIR%\npm.cmd"

set "CI_MARKER=%ROOT%node_modules\.material-router-ci-ok"
set "NEED_CI=1"
if exist "%CI_MARKER%" if exist "%ROOT%package-lock.json" (
    rem Idempotent warm path: skip npm ci only when the lockfile has not
    rem changed since the last successful install.
    for /f "delims=" %%T in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$l = (Get-Item -LiteralPath '%ROOT%package-lock.json').LastWriteTimeUtc.Ticks; $m = (Get-Item -LiteralPath '%CI_MARKER%').LastWriteTimeUtc.Ticks; Write-Output ([int]($m -gt $l))"') do set "NEED_CI=%%T"
)
if "!NEED_CI!"=="1" (
    call :log "  running npm ci against package-lock.json"
    pushd "%ROOT%"
    call "!NPM_CMD!" ci --no-audit --no-fund
    set "CI_RC=!errorlevel!"
    popd
    if not "!CI_RC!"=="0" goto :fail_ci
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Content -LiteralPath '%CI_MARKER%' -Value 'ok' -Encoding Ascii" || goto :fail_ci
) else (
    call :log "  skipped: node_modules present and newer than package-lock.json"
)
call :phase_end "project dependencies ready"

rem ------------------------------------------------------------
rem Phase 4/5: verify the Electron binary was materialized
rem ------------------------------------------------------------
call :phase_begin "Phase 4/5: verifying the Electron binary is materialized"
if exist "%ROOT%node_modules\electron\dist\electron.exe" (
    call :log "  electron.exe present in node_modules"
) else (
    call :log "  electron.exe missing; running electron's own install step"
    pushd "%ROOT%node_modules\electron"
    call "%NODE_EXE%" install.js
    set "EL_RC=!errorlevel!"
    popd
    if not exist "%ROOT%node_modules\electron\dist\electron.exe" goto :fail_electron
    call :log "  electron.exe materialized by install.js"
)
call :phase_end "electron binary ready"

rem ------------------------------------------------------------
rem Phase 5/5: summary
rem ------------------------------------------------------------
call :phase_begin "Phase 5/5: summary"
call :log "  node        : !NODE_EXE!"
call :log "  project deps: %ROOT%node_modules"
call :log "  toolchain   : %TOOLCHAIN%"
call :phase_end "all dependencies ready"
endlocal & exit /b 0

rem ============================================================
rem Helpers
rem ============================================================

:find_node
rem Prefer an existing usable runtime: PATH first, then the pinned
rem portable install, then a winget user-scope install location.
set "NODE_EXE="
for %%P in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:P"
if defined NODE_EXE call :node_version_ok && exit /b 0
set "NODE_EXE="
if exist "%NODE_DIR%\node.exe" (
    set "NODE_EXE=%NODE_DIR%\node.exe"
    set "PATH=%NODE_DIR%;%PATH%"
    call :node_version_ok && exit /b 0
    set "NODE_EXE="
)
for %%P in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\*NodeJS*\node.exe") do if not defined NODE_EXE set "NODE_EXE=%%~fP"
if defined NODE_EXE call :node_version_ok && exit /b 0
set "NODE_EXE="
exit /b 0

:node_version_ok
rem The runtime must satisfy the manifest's major version (vX.Y.Z -> X).
set "REQUIRED_MAJOR=%NODE_VER:~1%"
for /f "delims=. tokens=1" %%M in ("!REQUIRED_MAJOR!") do set "REQUIRED_MAJOR=%%M"
for /f "delims=. tokens=1" %%M in ('"%NODE_EXE%" -p "process.versions.node"') do set "GOT_MAJOR=%%M"
if %GOT_MAJOR% LSS %REQUIRED_MAJOR% (
    call :log "  node on machine is v%GOT_MAJOR%.x; manifest requires v%REQUIRED_MAJOR%.x - ignoring it"
    exit /b 1
)
exit /b 0

:install_node
rem Route A: winget user scope (ships with current Windows).
where winget >nul 2>nul
if errorlevel 1 goto :portable_node
call :log "  route A: winget install %NODE_WINGET_ID% --scope user"
winget install --id %NODE_WINGET_ID% --scope user --accept-source-agreements --accept-package-agreements
if errorlevel 1 call :log "  route A failed; falling back to the pinned portable zip"
if not errorlevel 1 goto :refresh_path_after_winget
goto :portable_node

:refresh_path_after_winget
rem Refresh PATH for THIS process after the install: a package manager
rem writes PATH for future shells only, so the next line here cannot see
rem what was just installed until we re-read the registry ourselves.
for /f "tokens=2*" %%A in ('reg query HKCU\Environment /v Path 2^>nul') do set "USER_PATH=%%B"
if defined USER_PATH set "PATH=%PATH%;%USER_PATH%"
set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WindowsApps"
for %%P in (node.exe) do set "NODE_EXE=%%~$PATH:P"
if defined NODE_EXE exit /b 0
call :log "  winget reported success but node.exe is not resolvable yet; using portable zip"
goto :portable_node

:portable_node
rem Route B: pinned portable zip, SHA-256 verified against the manifest.
rem A digest mismatch fails closed: delete the archive, refuse to extract.
call :log "  route B: downloading %NODE_URL%"
if not exist "%TOOLCHAIN%" mkdir "%TOOLCHAIN%"
set "ZIP=%TEMP%\material-router-node-portable.zip"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%ZIP%'" || goto :fail_download
call :log "  downloaded; verifying SHA-256 against the manifest"
for /f "delims=" %%H in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-FileHash -LiteralPath '%ZIP%' -Algorithm SHA256).Hash.ToLower()"') do set "GOT_SHA=%%H"
if /i not "%GOT_SHA%"=="%NODE_SHA%" (
    del /q "%ZIP%" >nul 2>nul
    call :err "SHA-256 mismatch for the Node archive: expected %NODE_SHA%, got %GOT_SHA%"
    call :err "the download was deleted and nothing was extracted - refusing to continue"
    exit /b 1
)
call :log "  digest verified: %GOT_SHA%"
call :log "  extracting to %NODE_DIR%"
if exist "%NODE_DIR%" rmdir /s /q "%NODE_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Expand-Archive -Force -LiteralPath '%ZIP%' -DestinationPath '%TOOLCHAIN%'; Move-Item -Force (Join-Path '%TOOLCHAIN%' '%NODE_ROOTDIR%') '%NODE_DIR%'" || goto :fail_extract
del /q "%ZIP%" >nul 2>nul
set "PATH=%NODE_DIR%;%PATH%"
set "NODE_EXE=%NODE_DIR%\node.exe"
exit /b 0

rem ============================================================
rem Reporting helpers: phase_begin/phase_end print per-phase
rem durations; every phase names what it did and what it found.
rem ============================================================
:phase_begin
for /f "delims=" %%T in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Date).ToString('o')"') do set "PHASE_START=%%T"
set "PHASE_LABEL=%~1"
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
set "PHASE_LABEL="
exit /b 0

:log
if defined SILENT (echo %~1) else (echo [%TIME%] %~1)
exit /b 0

:err
echo [ERROR] %~1 >&2
exit /b 0

rem ============================================================
rem Failure exits: each names the exact dependency, source tried,
rem and blocking condition.
rem ============================================================
:fail_no_manifest
call :err "scripts/dependency-manifest.json is missing - refusing to fetch anything unrecorded"
goto :fail
:fail_manifest_parse
call :err "could not read the pinned node version/url/sha256 from scripts/dependency-manifest.json"
goto :fail
:fail_node
call :err "no usable Node.js runtime: winget route and pinned portable-zip route both failed"
goto :fail
:fail_download
call :err "download failed for %NODE_URL% - check network access to nodejs.org"
goto :fail
:fail_extract
call :err "extraction to %NODE_DIR% failed"
goto :fail
:fail_ci
call :err "npm ci failed against package-lock.json - resolve the registry/network error above and re-run"
goto :fail
:fail_electron
call :err "node_modules/electron/dist/electron.exe still missing after running electron's install.js - see its output above"
goto :fail
:fail
call :err "dependency fetch FAILED at the step named above"
endlocal & exit /b 1
