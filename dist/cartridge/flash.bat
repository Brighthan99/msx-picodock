@echo off
rem ---------------------------------------------------------------------------
rem flash.bat - write a cartridge image to the PicoDock.
rem
rem   flash.bat                      rem picodock.uf2 if you built one, else .org
rem   flash.bat picodock.org.uf2     rem back to a plain cartridge
rem
rem The Windows half of flash.sh, same program underneath. Put the cartridge in
rem BOOTSEL first: hold the button while plugging it in, with a normal data
rem cable - a VBUS-blocking one carries no power and BOOTSEL cannot work.
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "HERE=%HERE:~0,-1%"
set "FROM=%CD%"

rem Resolved against the directory it was typed in, then against this one -
rem the images live beside this script, so "flash.bat picodock.org.uf2" names a
rem file that is not in the caller's working directory.
set "UF2="
if "%~1"=="" goto noarg
pushd "%FROM%" >nul
for %%X in ("%~1") do set "UF2=%%~fX"
popd >nul
if not exist "%UF2%" if exist "%HERE%\%~1" set "UF2=%HERE%\%~1"
:noarg
cd /d "%HERE%"

rem find-node.bat checks for Node.js and says what to install when it is
rem missing.
call "%HERE%\..\find-node.bat"
if not defined NODE exit /b 1

rem Whichever it picks, say which and what the other one is - "picodock" is in
rem both names, so naming the file alone would not say what is about to be
rem written.
if defined UF2 goto have
if exist "picodock.uf2" (
  set "UF2=picodock.uf2"
  echo [*] flashing picodock.uf2 - the one you built, with your roms\ in it
  echo     ^(picodock.org.uf2 is the plain one this ships;
  echo      flash.bat picodock.org.uf2 goes back to it^)
  goto have
)
if exist "picodock.org.uf2" (
  set "UF2=picodock.org.uf2"
  echo [*] flashing picodock.org.uf2 - the plain cartridge this ships
  echo     ^(put .rom files in roms\ and make-uf2.bat builds picodock.uf2
  echo      with them in it^)
  goto have
)
echo [-] no image here to flash.
echo     picodock.org.uf2 ships with this; make-uf2.bat builds picodock.uf2
exit /b 1
:have

%NODE% "%NODEDIR%\bin\flash_uf2.js" "%UF2%" || exit /b 1
echo     Confirm the firmware came up:  flash-check.bat
endlocal
