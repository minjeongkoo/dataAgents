import dgram from 'dgram';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const UDP_PORT = 2115;
const UDP_HOST = '0.0.0.0'; // 모든 IP 수신
const HTTP_PORT = 3000;

// __dirname 설정 (ESM 지원용)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// UDP 소켓 생성
const udpSocket = dgram.createSocket('udp4');

// Express 웹 서버 생성
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

// Static 파일 서빙 (public 폴더)
app.use(express.static(path.join(__dirname, 'public')));

udpSocket.on('listening', () => {
  const address = udpSocket.address();
  console.log(`[UDP] Listening on ${address.address}:${address.port}`);
});

udpSocket.on('message', (msg, rinfo) => {
  console.log(`[UDP] Message from ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`);

  const points = parseCompactFormat(msg);
  console.log(`[WebSocket] Sending ${points.length} points`);

  io.emit('lidar-points', points);
});

udpSocket.bind(UDP_PORT, UDP_HOST);

// 웹소켓 연결
io.on('connection', (socket) => {
  console.log('[WebSocket] Client connected');
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Server listening on http://localhost:${HTTP_PORT}`);
});

// Compact Format 파서
function parseCompactFormat(buffer) {
  let offset = 0;

  // === Compact Frame Header (고정) ===
  const startOfFrame = buffer.readUInt32BE(offset); offset += 4;
  const commandId = buffer.readUInt32LE(offset); offset += 4;
  const telegramCounter = buffer.readBigUInt64LE(offset); offset += 8;
  const timeStampTransmit = buffer.readBigUInt64LE(offset); offset += 8;
  const telegramVersion = buffer.readUInt32LE(offset); offset += 4;
  const payloadSize = buffer.readUInt32LE(offset); offset += 4; // == SizeModule0

  // === Module Header ===
  const numberOfLinesInModule = buffer.readUInt32LE(offset); offset += 4;
  const numberOfBeamsPerScan = buffer.readUInt32LE(offset); offset += 4;
  const numberOfEchosPerBeam = buffer.readUInt32LE(offset); offset += 4;

  console.log(`[UDP] Message from ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`);
  console.log(`[DEBUG] Header Info:`);
  console.log(`  numberOfLinesInModule: ${numberOfLinesInModule}`);
  console.log(`  numberOfBeamsPerScan: ${numberOfBeamsPerScan}`);
  console.log(`  numberOfEchosPerBeam: ${numberOfEchosPerBeam}`);
  console.log(`[WebSocket] Sending ${points.length} points`);
  
  const timeStampStart = [];
  for (let i = 0; i < numberOfLinesInModule; i++) {
    timeStampStart.push(buffer.readBigUInt64LE(offset));
    offset += 8;
  }

  const timeStampStop = [];
  for (let i = 0; i < numberOfLinesInModule; i++) {
    timeStampStop.push(buffer.readBigUInt64LE(offset));
    offset += 8;
  }

  const phiArray = [];
  for (let i = 0; i < numberOfLinesInModule; i++) {
    phiArray.push(buffer.readFloatLE(offset));
    offset += 4;
  }

  const thetaStartArray = [];
  for (let i = 0; i < numberOfLinesInModule; i++) {
    thetaStartArray.push(buffer.readFloatLE(offset));
    offset += 4;
  }

  const thetaStopArray = [];
  for (let i = 0; i < numberOfLinesInModule; i++) {
    thetaStopArray.push(buffer.readFloatLE(offset));
    offset += 4;
  }

  const distanceScalingFactor = buffer.readFloatLE(offset);
  offset += 4;

  const nextModuleSize = buffer.readUInt32LE(offset);
  offset += 4;

  offset += 1; // Reserved
  offset += 1; // DataContentEchos
  offset += 1; // DataContentBeams
  offset += 1; // Reserved

  const points = [];

  for (let lineIdx = 0; lineIdx < numberOfLinesInModule; lineIdx++) {
    const phi = phiArray[lineIdx];

    for (let beamIdx = 0; beamIdx < numberOfBeamsPerScan; beamIdx++) {
      const distanceRaw = buffer.readUInt16LE(offset); offset += 2;
      const rssi = buffer.readUInt16LE(offset); offset += 2;
      const properties = buffer.readUInt8(offset); offset += 1;
      const thetaRaw = buffer.readUInt16LE(offset); offset += 2;

      const distance = distanceRaw * distanceScalingFactor;
      const theta = (thetaRaw - 16384) / 5215; // uint16 -> radian 변환

      const x = distance * Math.cos(phi) * Math.cos(theta);
      const y = distance * Math.cos(phi) * Math.sin(theta);
      const z = distance * Math.sin(phi);

      if (distance > 100 && distance < 120000) {
        points.push({ x, y, z });
      }
    }
  }

  return points;
}
