// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dgram from 'dgram';
import { WebSocketServer } from 'ws';
import msgpack from 'msgpack-lite';

// ES 모듈 환경에서 __dirname 복원
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// 설정
const UDP_PORT  = 2115;
const HTTP_PORT = 3000;

// 1) HTTP 서버: public 폴더 서빙
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2) HTTP + WebSocket
const httpServer = app.listen(HTTP_PORT, () => {
  console.log(`HTTP server ▶ http://localhost:${HTTP_PORT}`);
});
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {
  console.log('🌐 WebSocket client connected');
});

// 3) UDP 소켓: 모든 인터페이스에서 바인드
const udp = dgram.createSocket('udp4');
udp.bind(UDP_PORT, () => {
  console.log(`📡 UDP listening on port ${UDP_PORT} (all interfaces)`);
});

// 4) UDP 메시지 수신 & 디코딩 & 브로드캐스트
udp.on('message', (raw, rinfo) => {
  console.log(`📥 UDP packet from ${rinfo.address}:${rinfo.port}, ${raw.length} bytes`);

  // STX(4) + length(4) + payload + CRC32(4)
  const len     = raw.readUInt32LE(4);
  const payload = raw.slice(8, 8 + len);

  let data;
  try {
    data = msgpack.decode(payload);
  } catch (err) {
    console.warn('⚠️ msgpack decode failed:', err.message);
    return;
  }

  if (!data) {
    console.warn('⚠️ decoded data is null');
    return;
  }
  if (!Array.isArray(data.ScanSegment)) {
    console.warn('⚠️ no ScanSegment field:', Object.keys(data));
    return;
  }

  // 포인트 계산
  const pts = [];
  for (const seg of data.ScanSegment) {
    for (const scan of seg.Scan || []) {
      const phis    = scan.Phi;
      const th0s    = scan.ThetaStart;
      const thEnds  = scan.ThetaStop;
      const distsA  = scan.Distances;
      for (let i = 0; i < phis.length; i++) {
        const φ    = phis[i], θ0 = th0s[i], θend = thEnds[i];
        const ds   = distsA[i] || [];
        for (let j = 0; j < ds.length; j++) {
          const d    = ds[j] / 1000;
          const θ    = θ0 + j * ((θend - θ0) / (ds.length - 1) || 1);
          pts.push({
            x: d * Math.cos(φ) * Math.cos(θ),
            y: d * Math.cos(φ) * Math.sin(θ),
            z: d * Math.sin(φ),
          });
        }
      }
    }
  }

  // WebSocket 브로드캐스트
  const msg = JSON.stringify(pts);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }

  console.log(`✅ Broadcast ${pts.length} points to ${wss.clients.size} client(s)`);
});
