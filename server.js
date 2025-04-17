// ✅ SICK Compact Format UDP Parser + Visualization (정식 포맷 기반)

const dgram = require('dgram');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const UDP_PORT = 2115;
const HOST = '0.0.0.0';

const server = dgram.createSocket('udp4');
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
  console.log('🌐 웹 클라이언트 연결됨');
});

function parseCompactPacket(buffer) {
  const HEADER_SIZE = 32;
  const startOfFrame = buffer.readUInt32BE(0);
  if (startOfFrame !== 0x02020202) return null;

  const commandId = buffer.readUInt32LE(4);
  if (commandId !== 1) return null;

  const telegramCounter = Number(buffer.readBigUInt64LE(8));
  const timestamp = Number(buffer.readBigUInt64LE(16));
  const version = buffer.readUInt32LE(24);
  const sizeModule0 = buffer.readUInt32LE(28);

  const moduleData = buffer.slice(HEADER_SIZE, HEADER_SIZE + sizeModule0);

  let offset = 0;
  const scanCounter = moduleData.readUInt32LE(offset); offset += 4;
  const timeSinceStartup = moduleData.readUInt32LE(offset); offset += 4;
  const timeOfTransmission = moduleData.readUInt32LE(offset); offset += 4;
  const status = moduleData.readUInt16LE(offset); offset += 2;
  const phaseOffset = moduleData.readUInt16LE(offset); offset += 2;
  const layerCount = moduleData.readUInt8(offset); offset += 1;
  const echoCount = moduleData.readUInt8(offset); offset += 1;
  const reserved1 = moduleData.readUInt16LE(offset); offset += 2;
  const scanPointCount = moduleData.readUInt16LE(offset); offset += 2;

  offset += 42; // skip to distances (fixed meta block size)

  const distances = [];
  for (let i = 0; i < scanPointCount; i++) {
    const dist = moduleData.readUInt16LE(offset);
    distances.push(dist);
    offset += 2;
  }

  return { telegramCounter, timestamp, distances };
}

server.on('message', (msg, rinfo) => {
  const parsed = parseCompactPacket(msg);
  if (parsed) {
    io.emit('scan', parsed);
  }
});

server.bind(UDP_PORT, HOST, () => {
  console.log(`✅ UDP 수신 대기 중: ${HOST}:${UDP_PORT}`);
});

httpServer.listen(3000, () => {
  console.log('🌐 웹 서버 실행 중: http://localhost:3000');
});