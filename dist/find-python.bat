@echo off
rem ---------------------------------------------------------------------------
rem find-python.bat - work out how to run Python on this machine.
rem
rem   call "%~dp0..\find-python.bat"
rem   if not defined PY exit /b 1
rem   %PY% something.py
rem
rem Sets PY to a command that runs Python 3, or leaves it undefined and prints
rem what to do about it.
rem
rem This exists because "python" on Windows is a trap. Windows ships an App
rem Execution Alias at that name which is not Python: with nothing installed it
rem opens the Microsoft Store instead of running anything, and "where python"
rem finds it, so checking whether the command exists proves nothing. A script
rem that trusts it reports a Python error for a machine that has no Python.
rem
rem The py launcher does not have that problem - it is installed by Python
rem itself and by nothing else, so its presence is the answer. It is tried first
rem and "python" only after, and only after actually running it.
rem ---------------------------------------------------------------------------
set "PY="

rem The launcher. -3 in case a Python 2 is also on the machine.
py -3 -c "import sys" >nul 2>&1 && set "PY=py -3" && goto :eof

rem A python on PATH that really runs. The Store alias fails this.
python -c "import sys" >nul 2>&1 && set "PY=python" && goto :eof
python3 -c "import sys" >nul 2>&1 && set "PY=python3" && goto :eof

echo [-] Python 3 was not found.
echo.
echo     The quickest way, on Windows 10 or 11:
echo.
echo         winget install Python.Python.3.12
echo.
echo     Then close this window and open a new one - a new PATH only reaches
echo     programs started afterwards.
echo.
echo     Installing by hand from python.org works too. Tick
echo     "Add python.exe to PATH" on the first screen of the installer; it is
echo     off by default and everything here depends on it.
echo.
echo     If you think Python is already installed and this still says otherwise,
echo     what you have is probably the Microsoft Store placeholder rather than
echo     Python. Settings ^> Apps ^> Advanced app settings ^> App execution
echo     aliases, and turn off the two called python.exe and python3.exe.
goto :eof
