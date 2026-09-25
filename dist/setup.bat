@echo off
rem ---------------------------------------------------------------------------
rem setup.bat - check for Node.js on Windows, install what the server needs, and
rem say what it found.
rem
rem   setup.bat
rem
rem Run it once. Any failure stops it, so finishing means the machine is ready
rem rather than nearly ready.
rem
rem Almost nothing here needs anything installed beyond Node.js. Making a disk,
rem putting files on it and flashing the cartridge use only what Node ships
rem with. Serving the disk to the MSX needs one package, serialport, because
rem talking to a USB serial port is not something Node does on its own - this
rem fetches it (serve.bat would do the same on its first run).
rem
rem There used to be Python here. Since 2026-09-25 everything in dist\ is
rem Node.js, so there is one thing to install instead of two.
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "HERE=%HERE:~0,-1%"

echo PicoDock setup
echo ==============
echo.

set "NEED_PACKAGES=1"
call "%HERE%\find-node.bat"
if not defined NODE exit /b 1

for /f "delims=" %%V in ('node -v') do set "NODEVER=%%V"
echo [+] Node.js %NODEVER%
if exist "%HERE%\node\node_modules\serialport" (
  echo [+] serialport installed
) else (
  echo [-] serialport did not install - run this again and read what npm says.
  exit /b 1
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
