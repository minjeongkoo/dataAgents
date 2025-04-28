import dgram from 'dgram';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// UDP 소켓
const udpSocket = dgram.createSocket('udp4');

// HTTP + WebSocket 서버
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

// UDP 수신
udpSocket.on('message', (msg, rinfo) => {
  if (msg.length < 32) return;
  const modules = parseModules(msg.slice(32));

  modules.forEach(module => {
    const points = module.distances.map((d, i) => ({
      distance: d,
      rssi: module.rssi[i]
    }));

    wss.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify(points));
      }
    });
  });
});

udpSocket.bind(2115);
server.listen(3000, () => {
  console.log('HTTP/WebSocket server running on http://localhost:3000');
});

// ----------------- 모듈 파싱 함수 ------------------
function parseModules(buffer) {
  const modules = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 84 > buffer.length) break;

    const numberOfLines = buffer.readUInt32LE(offset + 20);
    const numberOfBeams = buffer.readUInt32LE(offset + 24);
    const numberOfEchos = buffer.readUInt32LE(offset + 28);
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

    const tupleSize = numberOfEchos * tupleSizePerEcho + tupleSizePerBeam;

    const totalTuples = numberOfLines * numberOfBeams;
    const expectedMeasurementSize = totalTuples * tupleSize;

    if (measurementStart + expectedMeasurementSize > buffer.length) break;

    const distances = [];
    const rssi = [];
    let pointer = measurementStart;

    for (let beamIdx = 0; beamIdx < numberOfBeams; beamIdx++) {
      for (let lineIdx = 0; lineIdx < numberOfLines; lineIdx++) {
        for (let echoIdx = 0; echoIdx < numberOfEchos; echoIdx++) {
          if (echoFields.includes('distance')) {
            const rawDistance = buffer.readUInt16LE(pointer);
            distances.push(rawDistance);
            pointer += 2;
          }
          if (echoFields.includes('rssi')) {
            const rawRssi = buffer.readUInt16LE(pointer);
            rssi.push(rawRssi);
            pointer += 2;
          }
        }
        for (const field of beamFields) {
          if (field === 'property') pointer += 1;
          else if (field === 'theta') pointer += 2;
        }
      }
    }

    modules.push({ distances, rssi });

    const nextModuleSize = buffer.readUInt32LE(offset + 80);
    if (nextModuleSize === 0) break;
    offset += nextModuleSize;
  }

  return modules;
}
