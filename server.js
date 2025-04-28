import dgram from 'dgram';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 서버 생성
const udpSocket = dgram.createSocket('udp4');
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
});

// 기본 세팅 (예시)
const PhiFirstDeg = -30;  // 장비 세팅 기준
const PhiLastDeg = 30;

udpSocket.on('message', (msg, rinfo) => {
  if (msg.length < 32) return;

  const modules = parseModules(msg.slice(32));

  modules.forEach(module => {
    const points = [];
    const numLines = module.numLines;
    const numBeams = module.numBeams;

    if (numBeams === 0 || numLines === 0) return; // 보호

    module.distances.forEach((d, idx) => {
      if (d <= 0 || d > 20000) return; // 무효 거리 필터

      const beamIdx = idx % numBeams;
      const lineIdx = Math.floor(idx / numBeams);

      const thetaDeg = 360 * (beamIdx / numBeams);
      const phiDeg = PhiFirstDeg + (PhiLastDeg - PhiFirstDeg) * (lineIdx / Math.max(1, numLines - 1));

      const theta = thetaDeg * (Math.PI / 180);
      const phi = phiDeg * (Math.PI / 180);

      const x = d * Math.cos(phi) * Math.cos(theta);
      const y = d * Math.cos(phi) * Math.sin(theta);
      const z = d * Math.sin(phi);

      points.push({ x, y, z });
    });

    // WebSocket 전송
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify(points));
      }
    });
  });
});

udpSocket.bind(2115);
server.listen(3000, () => {
  console.log('HTTP/WebSocket 3D server running on http://localhost:3000');
});

// ----------------- 모듈 파싱 ------------------
function parseModules(buffer) {
  const modules = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 84 > buffer.length) break;

    const numLines = buffer.readUInt32LE(offset + 20);
    const numBeams = buffer.readUInt32LE(offset + 24);
    const numEchos = buffer.readUInt32LE(offset + 28);

    const dataContentEchos = buffer.readUInt8(offset + 82);
    const dataContentBeams = buffer.readUInt8(offset + 83);

    const measurementStart = offset + 84;

    const echoFields = [];
    if (dataContentEchos & 0b00000001) echoFields.push('distance');
    if (dataContentEchos & 0b00000010) echoFields.push('rssi');

    const beamFields = [];
    if (dataContentBeams & 0b00000001) beamFields.push('property');
    if (dataContentBeams & 0b00000010) beamFields.push('theta');

    const tupleSizePerEcho = echoFields.length * 2;
    const tupleSizePerBeam = beamFields.reduce((sum, field) => sum + (field === 'property' ? 1 : 2), 0);

    const tupleSize = numEchos * tupleSizePerEcho + tupleSizePerBeam;

    const totalTuples = numLines * numBeams;
    const expectedMeasurementSize = totalTuples * tupleSize;

    if (measurementStart + expectedMeasurementSize > buffer.length) break;

    const distances = [];
    let pointer = measurementStart;

    for (let beamIdx = 0; beamIdx < numBeams; beamIdx++) {
      for (let lineIdx = 0; lineIdx < numLines; lineIdx++) {
        for (let echoIdx = 0; echoIdx < numEchos; echoIdx++) {
          if (echoFields.includes('distance')) {
            const rawDistance = buffer.readUInt16LE(pointer);
            distances.push(rawDistance);
            pointer += 2;
          }
          if (echoFields.includes('rssi')) {
            pointer += 2;
          }
        }
        for (const field of beamFields) {
          if (field === 'property') pointer += 1;
          else if (field === 'theta') pointer += 2;
        }
      }
    }

    modules.push({ distances, numLines, numBeams });

    const nextModuleSize = buffer.readUInt32LE(offset + 80);
    if (nextModuleSize === 0) break;
    offset += nextModuleSize;
  }

  return modules;
}
