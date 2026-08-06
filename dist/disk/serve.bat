@echo off
rem ---------------------------------------------------------------------------
rem serve.bat - hand the disk to the cartridge and keep it there.
rem
rem   serve.bat                      rem picodock.img beside this file
rem   serve.bat C:\msx\games.img     rem a different disk
rem   serve.bat --print pdf          rem options pass straight through
rem
rem The Windows half of serve.sh. Same program, same arguments; a .bat exists
rem only because cmd.exe cannot run a .sh. Under Git Bash or WSL use serve.sh.
rem
rem Leave it running while you use the MSX. Start it before switching the MSX
rem on - it says it is waiting until the cartridge appears, and sits through
rem resets and reflashing. Ctrl-C when you are done.
rem
rem Needs Python 3 and pyserial. The split-screen view also needs curses, which
rem Windows Python does not ship: `pip install windows-curses`. Without it the
rem server says so and falls back to plain output rather than failing.
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "HERE=%HERE:~0,-1%"
set "FROM=%CD%"

set "IMAGE=picodock.img"
set "ARGS="
set "TAKEN="
:parse
if "%~1"=="" goto done
set "A=%~1"
if not "%A:~0,1%"=="-" if not defined TAKEN (
  pushd "%FROM%" >nul
  for %%X in ("%~1") do set "IMAGE=%%~fX"
  popd >nul
  set "TAKEN=1"
) else (
  set "ARGS=%ARGS% %1"
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

if not exist "tools\pd_diskserver.py" (
  echo [-] tools\pd_diskserver.py is missing.
  echo     tools\ is staged from src/host/ by src\stage_dist.sh - run that.
  exit /b 1
)
rem A fresh clone has no picodock.img, so build one rather than stopping. No
rem image is shipped: it would be a hundred-odd megabytes of mostly nothing in
rem the repository, and making one needs only Python, which you already have to
rem have to be here. Building also picks up whatever is in user-files\ already.
if not exist "%IMAGE%" if /i "%IMAGE%"=="picodock.img" if exist "make-disk.bat" (
  echo [*] no picodock.img yet - building one
  call "make-disk.bat" || exit /b 1
)
if not exist "%IMAGE%" (
  echo [-] no disk image at %IMAGE%
  echo     make one:  make-disk.bat
  exit /b 1
)

rem ..\output, relative to this script, is dist\output - the same folder
rem serve.sh writes to, and the same three characters on every machine.
%PY% "tools\pd_diskserver.py" "%IMAGE%" --tui --output "..\output"%ARGS%
endlocal
