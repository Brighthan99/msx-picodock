@echo off
rem ---------------------------------------------------------------------------
rem make-uf2.bat - turn a folder of ROMs into a flashable cartridge image.
rem
rem   make-uf2.bat                        rem uses roms\ beside this file
rem   make-uf2.bat C:\msx\konami          rem or any other folder
rem   make-uf2.bat C:\msx\konami out.uf2
rem
rem The Windows half of make-uf2.sh. Same tool underneath, same arguments, same
rem result - a .bat exists only because cmd.exe cannot run the .sh. If you have
rem Git Bash or WSL, make-uf2.sh works there and this file is unnecessary.
rem
rem This is the no-build-environment path: the picodock-uf2-windows-x64.exe
rem beside it has the firmware, the menu ROM and the Nextor kernel compiled in,
rem so nothing here needs the Pico SDK, an ARM toolchain, cmake or sdcc.
rem
rem The ROM folder may be empty. You get a cartridge whose menu holds just the
rem Nextor disk entry, which is a perfectly good one - software on the *virtual
rem disk* can be changed without reflashing.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion

rem Everything is relative to this file's own folder, the same reason the shell
rem version cds to its own directory: the paths printed below then mean the same
rem thing wherever this has been unpacked.
set "HERE=%~dp0"
set "HERE=%HERE:~0,-1%"
set "FROM=%CD%"

set "ROMDIR=%HERE%\roms"
set "OUT=%HERE%\picodock.uf2"
set "OUTNAME=picodock.uf2"
if not "%~1"=="" (
  pushd "%FROM%" >nul
  for %%A in ("%~1") do set "ROMDIR=%%~fA"
  popd >nul
)
if not "%~2"=="" (
  pushd "%FROM%" >nul
  for %%A in ("%~2") do set "OUT=%%~fA"
  popd >nul
  set "OUTNAME=%~2"
)

set "TOOL=%HERE%\picodock-uf2-windows-x64.exe"
if not exist "%TOOL%" (
  echo [-] no prebuilt tool for Windows here.
  echo     Looked for: picodock-uf2-windows-x64.exe
  echo     Available:
  dir /b "%HERE%\picodock-uf2-*" 2>nul
  echo     Cross-build it on a machine with zig:  src\make_tool.sh windows-x64
  exit /b 1
)

if not exist "%ROMDIR%\" (
  echo [-] no such folder: %ROMDIR%
  exit /b 1
)

set /a N=0
for %%F in ("%ROMDIR%\*.rom") do set /a N+=1
echo [*] ROMs:  %ROMDIR%  (%N% found^)
if %N%==0 echo     none - the image will hold just the Nextor disk entry, which is fine.
echo [*] tool:  picodock-uf2-windows-x64.exe
echo.

rem -m is the Nextor disk entry, and it brings the 192KB memory mapper with it.
rem Without it the menu lists ROMs and cannot boot the virtual disk; without the
rem mapper a 64KB MSX2 cannot boot Nextor at all. The tool scans its working
rem directory, so this runs from the ROM folder and hands it a full output path.
pushd "%ROMDIR%"
"%TOOL%" -m -o "%OUT%"
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" exit /b %RC%

echo.
echo [+] %OUTNAME%
echo     Take the cartridge out of the MSX, hold BOOTSEL, plug it in with a
echo     NORMAL data cable (a VBUS-blocking one carries no power^), and drop
echo     this file on the RPI-RP2 drive that appears.
endlocal
