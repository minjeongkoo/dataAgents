#!/bin/zsh

# Check if matplotlib is installed
if ! python3 -c "import matplotlib" &> /dev/null; then
  echo "matplotlib is not installed."
  echo "Installing dependencies: matplotlib and numpy..."
  python3 -m pip install matplotlib numpy
  if [ $? -ne 0 ]; then
    echo "Dependency installation failed. Aborting."
    exit 1
  fi
fi

echo "Starting Node.js server..."
node server.js &
NODE_PID=$!

echo "Starting Python parser..."
python3 parser.py &
PY_PID=$!

trap "echo 'Shutting down...'; kill $NODE_PID $PY_PID; exit" INT

echo "All services started successfully."
wait
