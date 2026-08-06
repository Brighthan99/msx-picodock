@echo off
rem ---------------------------------------------------------------------------
rem setup.bat - install what PicoDock needs on Windows, and say what it found.
rem
rem   setup.bat
rem
rem Run it once. It checks for Python, installs the two packages the server
rem needs, and says what it found. Any failure stops it, so finishing means the
rem machine is ready rather than nearly ready.
rem
rem Almost nothing here needs anything installed. Making a disk, putting files on
rem it and flashing the cartridge are all plain Python. Serving the disk to the
rem MSX needs two: pyserial, because talking to a USB serial port is not
rem something Python does on its own, and windows-curses for the split view.
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "HERE=%HERE:~0,-1%"

echo PicoDock setup
echo ==============
echo.

call "%HERE%\find-python.bat"
if not defined PY exit /b 1

for /f "delims=" %%V in ('%PY% -c "import sys; print(sys.version.split()[0])"') do set "PYVER=%%V"
echo [+] Python %PYVER%
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)" || (
  echo [-] Python 3.8 or newer is needed. Install a current one and re-run this.
  exit /b 1
)
echo.

rem --- pyserial: required to serve the disk -----------------------------------
%PY% -c "import serial" >nul 2>&1 && (
  echo [+] pyserial already installed
) || (
  echo [*] installing pyserial - needed to talk to the cartridge
  %PY% -m pip install --user pyserial || (
    echo [-] that failed. Try it by hand and read what it says:
    echo         %PY% -m pip install --user pyserial
    exit /b 1
  )
  echo [+] pyserial installed
)

rem --- windows-curses: the split-screen view -----------------------------------
rem Installed like pyserial rather than offered. The server does still fall back
rem to plain output without it - and that fallback is the right answer for a
rem pipe, a redirect or an ssh session with no terminal - but "it works, just
rem differently" is a poor thing to leave someone to discover. Setting a machine
rem up is the moment to get it right.
%PY% -c "import curses" >nul 2>&1 && (
  echo [+] curses already available
) || (
  echo [*] installing windows-curses - the split-screen view
  %PY% -m pip install --user windows-curses || (
    echo [-] that failed. Try it by hand and read what it says:
    echo         %PY% -m pip install --user windows-curses
    echo.
    echo     If it will not install on this machine, PicoDock still runs - the
    echo     server falls back to plain scrolling output and everything works
    echo     except the panes. Re-run this once it is sorted.
    exit /b 1
  )
  echo [+] windows-curses installed
)

echo.
echo Ready. What to do next:
echo.
echo     cartridge\flash.bat        put the firmware on the cartridge
echo                                ^(hold BOOTSEL while plugging it in^)
echo     disk\serve.bat             serve the disk to the MSX
echo.
echo See docs\windows.md if any of that does not go as expected.
endlocal
