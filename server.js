// server.js
import express from 'express';
import path from 'path';
import dgram from 'dgram';
import { WebSocketServer } from 'ws';
import msgpack from 'msgpack-lite';

const UDP_HOST = '192.168.0.100';
const UDP_PORT = 2115;
const HTTP_PORT = 3000;

// --- 1) HTTP 서버 (Express) 설정 & index.html 서빙 ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const httpServer = app.listen(HTTP_PORT, () => {
  console.log(`HTTP server running at http://localhost:${HTTP_PORT}`);
});

// --- 2) WebSocket 서버를 HTTP 서버에 붙이기 ---
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {
  console.log('WebSocket client connected');
});

// --- 3) UDP 소켓: LiDAR → 수신 → msgpack 디코딩 → 브로드캐스트 ---
const udp = dgram.createSocket('udp4');
udp.on('listening', () =>
  console.log(`UDP listening on ${UDP_HOST}:${UDP_PORT}`)
);
udp.bind(UDP_PORT, UDP_HOST);

udp.on('message', raw => {
  // MSGPACK: STX(4) + length(4) + payload + CRC32(4)
  const len = raw.readUInt32LE(4);
  const payload = raw.slice(8, 8 + len);

  let data;
  try { data = msgpack.decode(payload); }
  catch { return; }

  // 포인트 계산 (Compact 예제와 동일 로직)
  const pts = [];
  for (const seg of data.ScanSegment || []) {
    for (const scan of seg.Scan || []) {
      const phis = scan.Phi, thetas0 = scan.ThetaStart, stops = scan.ThetaStop;
      const distsArr = scan.Distances;
      for (let i = 0; i < phis.length; i++) {
        const phi = phis[i], th0 = thetas0[i], thStop = stops[i];
        const dists = distsArr[i];
        for (let j = 0; j < dists.length; j++) {
          const d = dists[j] / 1000;
          const theta = th0 + j * ((thStop - th0) / (dists.length - 1));
          pts.push({
            x: d * Math.cos(phi) * Math.cos(theta),
            y: d * Math.cos(phi) * Math.sin(theta),
            z: d * Math.sin(phi),
          });
        }
      }
    }
  }

  const msg = JSON.stringify(pts);
  wss.clients.forEach(c =>
    c.readyState === 1 && c.send(msg)
  );
});
