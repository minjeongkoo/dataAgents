// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';       // ← import this

// — recreate __filename and __dirname —
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

import dgram from 'dgram';
import { WebSocketServer } from 'ws';
import msgpack from 'msgpack-lite';

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
const httpServer = app.listen(HTTP_PORT, () =>
  console.log(`HTTP server running at http://localhost:${HTTP_PORT}`)
);
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => console.log('WebSocket client connected'));

// 3) UDP 수신 → msgpack 디코딩 → 브로드캐스트
const udp = dgram.createSocket('udp4');
udp.bind(UDP_PORT, UDP_HOST, () =>
  console.log(`UDP listening on ${UDP_HOST}:${UDP_PORT}`)
);

udp.on('message', raw => {
  const len     = raw.readUInt32LE(4);
  const payload = raw.slice(8, 8 + len);

  let data;
  try { data = msgpack.decode(payload); }
  catch { return; }

  const pts = [];
  for (const seg of data.ScanSegment || []) {
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
          const d    = ds[j] / 1000;
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
    if (client.readyState === 1) client.send(msg);
  }
});
