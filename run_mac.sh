#!/bin/zsh

echo "Checking dependencies..."
python3 -c "import matplotlib" &> /dev/null || python3 -m pip install matplotlib numpy

echo "Starting Node.js..."
node server.js
