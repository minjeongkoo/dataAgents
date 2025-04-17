const dgram = require('dgram');
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const udp = dgram.createSocket('udp4');

const UDP_PORT = 2115;
const UDP_HOST = '169.254.199.100';
const WEB_PORT = 3000;

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Start Python process
const python = spawn('python', ['parser.py']);
python.stderr.on('data', err => {
  console.error('Python stderr:', err.toString());
});

python.stdin.on('error', err => {
  console.error('Python stdin error:', err.message);
});

python.stdout.on('data', data => {
  try {
    const parsed = JSON.parse(data.toString());
    io.emit('scan', parsed);
  } catch (e) {
    console.error('Failed to parse Python output:', e.message);
  }
});

udp.on('message', (msg) => {
  python.stdin.write(msg.toString('hex') + '\n');
});

udp.bind(UDP_PORT, UDP_HOST, () => {
  console.log(`UDP listening on ${UDP_HOST}:${UDP_PORT}`);
});

server.listen(WEB_PORT, () => {
  console.log(`Web server running on http://localhost:${WEB_PORT}`);
});
