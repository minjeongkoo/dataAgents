import dgram from 'dgram';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';


const UDP_PORT = 2115;    // UDP 수신 포트 (라이다)
const WS_PORT = 3000;     // WebSocket 제공 포트 (브라우저)

// multiScan100 기본 빔 수직각 (deg)
const beamAnglesDeg = [
  -15.0, -13.7, -12.3, -11.0, -9.6, -8.3,
  -7.0, -5.6, -4.3, -2.9, -1.6, -0.2,
   1.1,  2.5,  3.8,  5.2,  6.5,  7.9,
   9.2, 10.6, 11.9, 13.3, 14.6, 16.0
];

// 한 바퀴 회전 시간 (10Hz → 100ms)
const ROTATION_PERIOD_MS = 100;

const udpSocket = dgram.createSocket('udp4');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// WebSocket 서버 연결
io.on('connection', (socket) => {
  console.log('[WS] Client connected');
});

// UDP 데이터 수신
udpSocket.on('message', (msg, rinfo) => {
  console.log(`[UDP] Message from ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`);

  const points = parseCompactFormat(msg);

  if (points.length > 0) {
    console.log(`[WebSocket] Sending ${points.length} points`);
    io.emit('lidar-points', points); // WebSocket으로 브라우저에 전달
  }
});

// UDP, WS 서버 시작
udpSocket.bind(UDP_PORT);
server.listen(WS_PORT, () => {
  console.log(`[HTTP/WS] Server running at http://localhost:${WS_PORT}`);
});


// ===== 핵심: Compact Format 파싱 함수 =====

function parseCompactFormat(buffer) {
  const points = [];

  // 최소 길이 체크 (헤더 + 모듈 데이터)
  if (buffer.length < 32) return points;

  const sof = buffer.readUInt32BE(0);
  if (sof !== 0x02020202) return points; // Compact Format Start 검증

  const telegramCounter = buffer.readBigUInt64LE(8);
  const timestamp = Number(buffer.readBigUInt64LE(16)); // ns 단위

  // Compact Format은 헤더 이후 모듈로 이어짐
  const moduleOffset = 32;

  // 여기선 간단히 Distance와 RSSI만 파싱 (예시로 Distance만)
  const numChannels = buffer.readUInt32LE(moduleOffset);
  const channelDataOffset = moduleOffset + 4;

  const distanceData = [];
  const distanceStartOffset = channelDataOffset + 24; // 디폴트 위치

  // Distance 데이터 읽기 (float32)
  for (let i = 0; i < numChannels; i++) {
    const dist = buffer.readFloatLE(distanceStartOffset + i * 4);
    distanceData.push(dist); // mm
  }

  // === Distance 데이터로 포인트 변환 ===

  // 현재 스캔 각도 (timestamp 기준으로 phi 계산)
  const timestampMs = timestamp / 1e6; // ns → ms 변환
  const phiDeg = (timestampMs % ROTATION_PERIOD_MS) / ROTATION_PERIOD_MS * 360;
  const phiRad = phiDeg * Math.PI / 180;

  for (let beamId = 0; beamId < beamAnglesDeg.length; beamId++) {
    const thetaDeg = beamAnglesDeg[beamId];
    const thetaRad = thetaDeg * Math.PI / 180;

    const r = distanceData[beamId]; // Beam 별 Distance
    if (r <= 0 || r > 120000) continue; // 0이나 비정상 거리 필터

    const x = r * Math.cos(thetaRad) * Math.cos(phiRad);
    const y = r * Math.cos(thetaRad) * Math.sin(phiRad);
    const z = r * Math.sin(thetaRad);

    points.push({ x, y, z });
  }

  return points;
}
