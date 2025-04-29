@echo off
python -c "import matplotlib" 2>NUL
IF ERRORLEVEL 1 (
  echo Installing dependencies...
  python -m pip install matplotlib numpy
)

echo Starting Node.js...
node server.js
pause
