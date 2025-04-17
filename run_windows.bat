@echo off

REM Check if matplotlib is installed
python -c "import matplotlib" 2>NUL
IF ERRORLEVEL 1 (
  echo matplotlib is not installed.
  echo Installing dependencies: matplotlib and numpy...
  python -m pip install matplotlib numpy
  IF ERRORLEVEL 1 (
    echo Dependency installation failed. Aborting.
    pause
    exit /B
  )
)

echo Starting Node.js server...
start "" node server.js

echo Starting Python parser...
start "" python parser.py

echo All services started successfully.
pause
