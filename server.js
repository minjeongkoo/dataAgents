import dgram from 'dgram';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const UDP_PORT = 2115;
const UDP_HOST = '0.0.0.0';
const HTTP_PORT = 3000;

// ESM에서 __dirname 사용을 위한 설정
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// UDP 소켓 생성
const udpSocket = dgram.createSocket('udp4');

// Express 및 HTTP 서버 생성
const app = express();
const httpServer = http.createServer(app);

app.use(cors());

// socket.io 서버 (CORS 허용)
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5173", // Vue 앱 주소
    methods: ["GET", "POST"]
  }
});

// UDP 수신
udpSocket.on('listening', () => {
  const address = udpSocket.address();
  console.log(`[UDP] Listening on ${address.address}:${address.port}`);
});

udpSocket.on('message', (msg, rinfo) => {
  console.log(`[UDP] Message from ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`);

  const points = parseCompactFormat(msg);

  if (points.length > 0) {
    console.log(`[WebSocket] Sending ${points.length} points`);
    io.emit('lidar-points', points);
  } else {
    console.log(`[WebSocket] No valid points`);
  }
});

// WebSocket 연결 로그
io.on('connection', (socket) => {
  console.log('[WebSocket] Client connected');
});

// 서버 실행
udpSocket.bind(UDP_PORT, UDP_HOST);
httpServer.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Server listening on http://localhost:${HTTP_PORT}`);
});


// Compact Format 파서 함수
function parseCompactFormat(buffer) {
  let offset = 0;

  // Compact Frame Header
  const startOfFrame = buffer.readUInt32BE(offset); offset += 4;
  if (startOfFrame !== 0x02020202) return [];
  const commandId = buffer.readUInt32LE(offset); offset += 4;
  const telegramCounter = buffer.readBigUInt64LE(offset); offset += 8;
  const timeStampTransmit = buffer.readBigUInt64LE(offset); offset += 8;
  const telegramVersion = buffer.readUInt32LE(offset); offset += 4;
  const sizeModule0 = buffer.readUInt32LE(offset); offset += 4;

  // Module Header
  const segmentCounter = buffer.readBigUInt64LE(offset); offset += 8;
  const frameNumber = buffer.readBigUInt64LE(offset); offset += 8;
  const senderId = buffer.readUInt32LE(offset); offset += 4;
  const numberOfLinesInModule = buffer.readUInt32LE(offset); offset += 4;
  const numberOfBeamsPerScan = buffer.readUInt32LE(offset); offset += 4;
  const numberOfEchosPerBeam = buffer.readUInt32LE(offset); offset += 4;

  // 데이터 유효성 체크
  if (numberOfBeamsPerScan === 0 || numberOfEchosPerBeam !== 1) return [];

  // Time, Angle arrays
  offset += numberOfLinesInModule * 8 * 2; // TimeStampStart + TimeStampStop
  const phiArray = [];
  const thetaStartArray = [];
  const thetaStopArray = [];

  for (let i = 0; i < numberOfLinesInModule; i++) {
    phiArray.push(buffer.readFloatLE(offset)); offset += 4;
  }
  for (let i = 0; i < numberOfLinesInModule; i++) {
    thetaStartArray.push(buffer.readFloatLE(offset)); offset += 4;
  }
  for (let i = 0; i < numberOfLinesInModule; i++) {
    thetaStopArray.push(buffer.readFloatLE(offset)); offset += 4;
  }

  const distanceScalingFactor = buffer.readFloatLE(offset); offset += 4;
  const nextModuleSize = buffer.readUInt32LE(offset); offset += 4;
  offset += 4; // Reserved + DataContentEchos + DataContentBeams + Reserved

  const points = [];

  for (let beam = 0; beam < numberOfBeamsPerScan; beam++) {
    for (let line = 0; line < numberOfLinesInModule; line++) {
      const distanceRaw = buffer.readUInt16LE(offset); offset += 2;
      const rssi = buffer.readUInt16LE(offset); offset += 2;
      const properties = buffer.readUInt8(offset); offset += 1;
      const thetaRaw = buffer.readUInt16LE(offset); offset += 2;

      const distance = distanceRaw * distanceScalingFactor;
      const phi = phiArray[line];
      const theta = (thetaRaw - 16384) / 5215;

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
