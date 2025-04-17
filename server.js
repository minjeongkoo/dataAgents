const dgram = require('dgram');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const UDP_PORT = 2115;
const HOST = '0.0.0.0';

const udpSocket = dgram.createSocket('udp4');
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
  console.log('WebSocket client connected');
});


// SICK Compact Format 정식 파서
function parseCompactPacket(buffer) {
  if (buffer.length < 32) return null;

  const sof = buffer.readUInt32BE(0);
  if (sof !== 0x02020202) return null;

  const commandId = buffer.readUInt32LE(4);
  if (commandId !== 1) return null;

  const telegramCounter = Number(buffer.readBigUInt64LE(8));
  const timestamp = Number(buffer.readBigUInt64LE(16));
  const moduleSize = buffer.readUInt32LE(28);
  const moduleData = buffer.slice(32, 32 + moduleSize);

  const layerCount = moduleData.readUInt8(0);
  const echoCount = moduleData.readUInt8(1);
  const scanPointCount = moduleData.readUInt16LE(2);
  const startAngleRaw = moduleData.readInt32LE(4);
  const angleStepRaw = moduleData.readUInt32LE(8);
  const dataOffset = 12;

  if (scanPointCount === 0 || angleStepRaw === 0) return null;

  const startAngle = (startAngleRaw / 10000.0) * Math.PI / 180;
  const angleStep = (angleStepRaw / 10000.0) * Math.PI / 180;

  const points = [];

  for (let i = 0; i < scanPointCount; i++) {
    const offset = dataOffset + i * 2;
    if (offset + 2 > moduleData.length) break;

    const dist = moduleData.readUInt16LE(offset);
    if (dist > 0) {
      const angle = startAngle + i * angleStep;
      const x = dist * Math.cos(angle);
      const y = dist * Math.sin(angle);
      points.push({ x, y });
    }
  }

  return { telegramCounter, timestamp, points };
}

// UDP 데이터 수신 → 파싱 → 브라우저 전송
udpSocket.on('message', (msg) => {
  const parsed = parseCompactPacket(msg);
  if (parsed) {
    io.emit('scan', parsed);
    console.log("Emitted", parsed.points.length, "points to client");
  }
});

udpSocket.bind(UDP_PORT, HOST, () => {
  console.log(`UDP listening on ${HOST}:${UDP_PORT}`);
});

httpServer.listen(3000, () => {
  console.log('Web server running at http://localhost:3000');
});
