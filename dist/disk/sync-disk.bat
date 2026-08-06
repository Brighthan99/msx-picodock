@echo off
rem ---------------------------------------------------------------------------
rem sync-disk.bat - push what is in user-files\ onto a disk that already exists.
rem
rem   sync-disk.bat                     rem into picodock.img beside this file
rem   sync-disk.bat C:\msx\games.img    rem into another one
rem   sync-disk.bat -y                  rem do not ask
rem
rem The Windows half of sync-disk.sh, same program underneath. make-disk.bat
rem builds from nothing and will not touch an existing image, because rebuilding
rem would throw away whatever the MSX has written. This is the other half.
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "HERE=%HERE:~0,-1%"
set "FROM=%CD%"

set "IMAGE=picodock.img"
set "YES="
:parse
if "%~1"=="" goto done
if /i "%~1"=="-y" (set "YES=1") else if /i "%~1"=="--yes" (set "YES=1") else (
  pushd "%FROM%" >nul
  for %%X in ("%~1") do set "IMAGE=%%~fX"
  popd >nul
)
shift
goto parse
:done

cd /d "%HERE%"

rem "python" on Windows may be the Store placeholder rather than Python.
rem find-python.bat works out what actually runs, and says what to do when
rem nothing does.
call "%HERE%\..\find-python.bat"
if not defined PY exit /b 1
if not exist "tools\build_disk.py" (
  echo [-] tools\build_disk.py is missing.
  echo     tools\ is staged from src/host/ by src\stage_dist.sh - run that.
  exit /b 1
)
if not exist "%IMAGE%" (
  echo [-] no disk image at %IMAGE%
  echo     make one first:  make-disk.bat
  exit /b 1
)

echo This copies user-files\ onto %IMAGE%. Two things it does not do:
echo.
echo   * Files removed from user-files\ are NOT removed from the disk. This adds
echo     and overwrites; it never deletes. Anything the MSX wrote is safe for
echo     the same reason - and so is anything you meant to get rid of.
echo.
echo   * system\ wins. A file in user-files\ whose name system\ already uses is
echo     skipped, not copied over the top. That is the half that has to boot.
echo.
rem The prompt is outside any parenthesised block on purpose: cmd expands %VAR%
rem when it *parses* a block, so a variable set inside one reads as empty unless
rem delayed expansion is on. Avoiding the block is simpler than turning that on.
if defined YES goto go
set "REPLY="
set /p "REPLY=Go ahead? [Y/n] "
if /i "%REPLY%"=="n" goto stopped
if /i "%REPLY%"=="no" goto stopped
:go

%PY% "tools\build_disk.py" sync . "%IMAGE%" || exit /b 1

echo.
echo     Now run PDSYNC on the MSX.
echo.
echo     Nextor caches the directory, so until PDSYNC runs, DIR shows the
echo     listing from before this. It is on the disk already:  A^> PDSYNC
endlocal
exit /b 0

:stopped
echo [-] stopped, nothing was written.
endlocal
exit /b 1
