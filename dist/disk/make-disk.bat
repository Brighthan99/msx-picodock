@echo off
rem ---------------------------------------------------------------------------
rem make-disk.bat - build the virtual disk, filled and ready to serve.
rem
rem   make-disk.bat                        rem -> picodock.img, 128 MB
rem   make-disk.bat 512m                   rem a different size
rem   make-disk.bat 128m C:\msx\games.img
rem
rem The Windows half of make-disk.sh, and the same program underneath -
rem ..\node\bin\build_disk.js. A .bat exists only because cmd.exe cannot run a .sh;
rem under Git Bash or WSL use make-disk.sh.
rem
rem Refuses to overwrite an image that exists - use sync-disk.bat for that. See
rem make-disk.sh for what "filled" means and why system\ wins a name collision.
rem
rem Needs Node.js and nothing else. Nothing is mounted: the FAT16 is written
rem directly, which is what makes this work on Windows at all.
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "HERE=%HERE:~0,-1%"
set "FROM=%CD%"

set "SIZE=%~1"
if "%SIZE%"=="" set "SIZE=128m"
set "OUT=picodock.img"
if not "%~2"=="" (
  pushd "%FROM%" >nul
  for %%X in ("%~2") do set "OUT=%%~fX"
  popd >nul
)
set "VOL=%~3"
if "%VOL%"=="" set "VOL=MSXDISK"

cd /d "%HERE%"

rem find-node.bat checks for Node.js and says what to install when it is
rem missing.
call "%HERE%\..\find-node.bat"
if not defined NODE exit /b 1

%NODE% "%NODEDIR%\bin\build_disk.js" make . "%SIZE%" "%OUT%" "%VOL%" || exit /b 1

echo.
echo     serve it:  serve.bat
echo     add files: drop them in user-files\ and run sync-disk.bat
echo     then run PDSYNC on the MSX, or Nextor keeps showing the old listing.
endlocal
