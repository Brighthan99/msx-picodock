@echo off
rem ---------------------------------------------------------------------------
rem find-node.bat - find Node.js, and install the server's packages the first time.
rem
rem   call "%~dp0..\find-node.bat"
rem   if not defined NODE exit /b 1
rem   %NODE% "%NODEDIR%\bin\something.js"
rem
rem   set "NEED_PACKAGES=1"  before the call, for the server: also npm install once
rem
rem Sets NODE and NODEDIR, or leaves NODE undefined and prints what to do.
rem
rem Everything in dist\ runs on Node.js since 2026-09-25 - there is no Python to
rem install any more. Making a disk, putting files on it and flashing need only
rem Node itself. Serving the disk needs the serialport package, fetched the
rem first time serve.bat runs, into dist\node\node_modules\.
rem ---------------------------------------------------------------------------
set "NODE="
set "NODEDIR=%~dp0node"

where node >nul 2>&1 || goto :missing
for /f "delims=" %%V in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 18 (
  echo [-] Node.js is too old - 18 or newer is needed.
  goto :eof
)
if not exist "%NODEDIR%\bin\pdserve.js" (
  echo [-] dist\node\ is missing. It is staged from node\ by src\stage_dist.sh.
  goto :eof
)
if "%NEED_PACKAGES%"=="1" if not exist "%NODEDIR%\node_modules\serialport" (
  echo [*] first run: installing the server's packages into dist\node\ ^(once^)
  pushd "%NODEDIR%" >nul
  rem ci, not install: the versions in package-lock.json, and it never writes
  rem that file - install would, leaving a tracked file changed.
  call npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    popd >nul
    echo [-] npm ci failed - read what it said above.
    goto :eof
  )
  popd >nul
  echo.
)
set "NODE=node"
goto :eof

:missing
echo [-] Node.js was not found.
echo.
echo     The quickest way, on Windows 10 or 11:
echo.
echo         winget install OpenJS.NodeJS.LTS
echo.
echo     Then close this window and open a new one - a new PATH only reaches
echo     programs started afterwards. The installer from nodejs.org works too.
goto :eof
