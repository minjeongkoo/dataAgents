// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dgram from 'dgram';
import { WebSocketServer } from 'ws';
import msgpack from 'msgpack-lite';

// — ES 모듈에서 __dirname 복원 —
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// 설정
const UDP_HOST = '192.168.0.100';
const UDP_PORT = 2115;
const HTTP_PORT = 3000;

// 1) HTTP 서버: public 디렉토리 서빙
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2) HTTP → WebSocket
const httpServer = app.listen(HTTP_PORT, () => {
  console.log(`HTTP server running at http://localhost:${HTTP_PORT}`);
});
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {
  console.log('WebSocket client connected');
});

// 3) UDP 수신 → msgpack 디코딩 → 브로드캐스트
const udp = dgram.createSocket('udp4');
udp.bind(UDP_PORT, UDP_HOST, () => {
  console.log(`UDP listening on ${UDP_HOST}:${UDP_PORT}`);
});

udp.on('message', raw => {
  // STX(4) + length(4) + payload + CRC32(4)
  const len = raw.readUInt32LE(4);
  const payload = raw.slice(8, 8 + len);

  let data;
  try {
    data = msgpack.decode(payload);
  } catch {
    return; // 디코딩 실패 시 무시
  }

  // data가 null이거나 ScanSegment가 배열이 아니면 스킵
  if (!data || !Array.isArray(data.ScanSegment)) {
    return;
  }

  // 포인트 계산
  const pts = [];
  for (const seg of data.ScanSegment) {
    for (const scan of seg.Scan || []) {
      const phis    = scan.Phi;
      const th0s    = scan.ThetaStart;
      const thStops = scan.ThetaStop;
      const distsA  = scan.Distances;
      for (let i = 0; i < phis.length; i++) {
        const φ    = phis[i];
        const θ0   = th0s[i];
        const θend = thStops[i];
        const ds   = distsA[i];
        for (let j = 0; j < ds.length; j++) {
          const d    = ds[j] / 1000; // mm → m
          const θ    = θ0 + j * ((θend - θ0) / (ds.length - 1));
          pts.push({
            x: d * Math.cos(φ) * Math.cos(θ),
            y: d * Math.cos(φ) * Math.sin(θ),
            z: d * Math.sin(φ),
          });
        }
      }
    }
  }

  const msg = JSON.stringify(pts);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
});
