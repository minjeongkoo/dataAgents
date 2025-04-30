import dgram from 'dgram'
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const UDP_PORT = 2115
const HTTP_PORT = 3000
const udpSocket = dgram.createSocket('udp4')
const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: "*" }
})

// Static 파일 서빙
app.use(express.static(path.join(__dirname, 'public')))

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// WebSocket 이벤트 처리
io.on('connection', (socket) => {
  console.log('[WebSocket] Client connected')
})

// UDP 수신 및 WebSocket 전달
udpSocket.on('message', (msg, rinfo) => {
  console.log(`[UDP] Message from ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`)

  const points = parseCompactFormat(msg)
  if (points.length > 0) {
    console.log(`[WebSocket] Sending ${points.length} points`)
    io.emit('lidar-points', points)
  } else {
    console.log(`[WebSocket] No valid points`)
  }
})

udpSocket.bind(UDP_PORT)
server.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Server listening on http://localhost:${HTTP_PORT}`)
})

io.on('connection', (socket) => {
  console.log('[WebSocket] Client connected');
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Server listening on http://localhost:${HTTP_PORT}`);
});


// Compact Format 파서 (SICK 문서 기반)
function parseCompactFormat(buffer) {
  let offset = 0;

  // === Compact Frame Header (32 bytes) ===
  const startOfFrame = buffer.readUInt32BE(offset); offset += 4;
  if (startOfFrame !== 0x02020202) {
    console.error("Invalid start of frame");
    return [];
  }

  const commandId = buffer.readUInt32LE(offset); offset += 4;
  const telegramCounter = buffer.readBigUInt64LE(offset); offset += 8;
  const timeStampTransmit = buffer.readBigUInt64LE(offset); offset += 8;
  const telegramVersion = buffer.readUInt32LE(offset); offset += 4;
  const sizeModule0 = buffer.readUInt32LE(offset); offset += 4;

  // === Module Metadata ===
  const segmentCounter = buffer.readBigUInt64LE(offset); offset += 8;
  const frameNumber = buffer.readBigUInt64LE(offset); offset += 8;
  const senderId = buffer.readUInt32LE(offset); offset += 4;
  const numberOfLinesInModule = buffer.readUInt32LE(offset); offset += 4;
  const numberOfBeamsPerScan = buffer.readUInt32LE(offset); offset += 4;
  const numberOfEchosPerBeam = buffer.readUInt32LE(offset); offset += 4;

  const timeStampStart = [];
  const timeStampStop = [];
  const phiArray = [];
  const thetaStartArray = [];
  const thetaStopArray = [];

  // TimeStampStart (µs)
  for (let i = 0; i < numberOfLinesInModule; i++) {
    timeStampStart.push(buffer.readBigUInt64LE(offset)); offset += 8;
  }

  // TimeStampStop (µs)
  for (let i = 0; i < numberOfLinesInModule; i++) {
    timeStampStop.push(buffer.readBigUInt64LE(offset)); offset += 8;
  }

  // Phi (Elevation angles, radians)
  for (let i = 0; i < numberOfLinesInModule; i++) {
    phiArray.push(buffer.readFloatLE(offset)); offset += 4;
  }

  // ThetaStart (Azimuth angles, radians)
  for (let i = 0; i < numberOfLinesInModule; i++) {
    thetaStartArray.push(buffer.readFloatLE(offset)); offset += 4;
  }

  // ThetaStop (Azimuth angles, radians)
  for (let i = 0; i < numberOfLinesInModule; i++) {
    thetaStopArray.push(buffer.readFloatLE(offset)); offset += 4;
  }

  // DistanceScalingFactor
  const distanceScalingFactor = buffer.readFloatLE(offset); offset += 4;

  // NextModuleSize (이번 예시에서는 사용하지 않음)
  offset += 4;

  // Reserved
  offset += 1;

  // DataContentEchos & DataContentBeams
  const dataContentEchos = buffer.readUInt8(offset); offset += 1;
  const dataContentBeams = buffer.readUInt8(offset); offset += 1;

  offset += 1; // Reserved 추가 바이트

  // Echo 구성 정보 (거리와 RSSI)
  const hasDistance = (dataContentEchos & 0x01) !== 0;
  const hasRSSI = (dataContentEchos & 0x02) !== 0;

  // Beam 구성 정보 (특성과 각도)
  const hasProperties = (dataContentBeams & 0x01) !== 0;
  const hasAzimuthAngle = (dataContentBeams & 0x02) !== 0;

  const points = [];

  for (let beamIdx = 0; beamIdx < numberOfBeamsPerScan; beamIdx++) {
    for (let lineIdx = 0; lineIdx < numberOfLinesInModule; lineIdx++) {
      const phi = phiArray[lineIdx];

      let distance = 0;
      if (hasDistance) {
        const distanceRaw = buffer.readUInt16LE(offset); offset += 2;
        distance = distanceRaw * distanceScalingFactor;
      }

      if (hasRSSI) offset += 2; // RSSI는 현재 사용하지 않음
      if (hasProperties) offset += 1; // Properties도 현재 사용하지 않음

      let theta = 0;
      if (hasAzimuthAngle) {
        const thetaRaw = buffer.readUInt16LE(offset); offset += 2;
        theta = (thetaRaw - 16384) / 5215; // radians로 변환
      }

      // 좌표 변환 (Polar → Cartesian)
      const x = distance * Math.cos(phi) * Math.cos(theta);
      const y = distance * Math.cos(phi) * Math.sin(theta);
      const z = distance * Math.sin(phi);

      // 유효한 거리만 점으로 표시 (100mm ~ 120000mm)
      if (distance > 100 && distance < 120000) {
        points.push({ x, y, z });
      }
    }
  }

  return points;
}
