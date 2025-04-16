// ✅ SICK Compact Format UDP Parser + Visualization (Node.js + Web UI)

const dgram = require('dgram');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const UDP_PORT = 2115;
const HOST = '0.0.0.0'; // 모든 인터페이스 수신

const server = dgram.createSocket('udp4');
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

// Serve basic frontend
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// WebSocket 연결 시 메시지 전달
io.on('connection', (socket) => {
  console.log('🌐 웹 클라이언트 연결됨');
});

// Compact Format 헤더 파싱
function parseCompactPacket(buffer) {
  const header = buffer.slice(0, 32);
  const startOfFrame = header.readUInt32BE(0);
  if (startOfFrame !== 0x02020202) return null;

  const commandId = header.readUInt32LE(4);
  if (commandId !== 1) return null; // 측정 데이터만 처리

  const telegramCounter = Number(header.readBigUInt64LE(8));
  const timestamp = Number(header.readBigUInt64LE(16));
  const version = header.readUInt32LE(24);
  const moduleSize = header.readUInt32LE(28);

  const moduleData = buffer.slice(32, 32 + moduleSize);

  // 예시로 첫 거리값 4바이트씩 float로 추출
  const distances = [];
  for (let i = 0; i < moduleData.length; i += 4) {
    if (i + 4 > moduleData.length) break;
    const value = moduleData.readFloatLE(i);
    distances.push(value);
  }

  return { telegramCounter, timestamp, distances };
}

// UDP 수신 처리
server.on('message', (msg, rinfo) => {
  const parsed = parseCompactPacket(msg);
  if (parsed) {
    io.emit('scan', parsed); // 웹소켓으로 전송
  }
});

server.bind(UDP_PORT, HOST, () => {
  console.log(`✅ UDP 수신 대기 중: ${HOST}:${UDP_PORT}`);
});

httpServer.listen(3000, () => {
  console.log('🌐 웹 서버 실행 중: http://localhost:3000');
});