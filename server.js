// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dgram from 'dgram';
import { WebSocketServer } from 'ws';

// ES 모듈에서 __dirname 복원
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
const httpServer = app.listen(HTTP_PORT, () =>
  console.log(`HTTP ▶ http://localhost:${HTTP_PORT}`)
);
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {
  console.log('🌐 WS client connected');
});

// 3) UDP 수신 → Compact 파싱 → WS 브로드캐스트
const udp = dgram.createSocket('udp4');
udp.bind(UDP_PORT, () =>
  console.log(`📡 UDP listening on port ${UDP_PORT}`)
);
udp.on('message', buffer => {
  const pts = parseCompact(buffer);
  if (!pts || !pts.length) return;
  const msg = JSON.stringify(pts);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(msg);
  }
});

/**
 * Compact Format Parser
 * - 프레임 헤더(32바이트)에서 SOF, commandId, telegramCounter, timestamp, sizeModule0 파싱
 * - sizeModule0 → nextModuleSize 로 모듈 루프
 * - metadata: numLines, numBeams, numEchos, Phi[], ThetaStart[], ThetaStop[], scalingFactor 등
 * - measurement: 모든 에코(echo) 채널 순회, 거리(raw) * scaling → m 단위, φ/θ 보간 → x,y,z
 */
function parseCompact(buffer) {
  if (buffer.length < 32) return null;
  // 1) SOF
  if (buffer.readUInt32BE(0) !== 0x02020202) return null;
  // 2) commandId
  if (buffer.readUInt32LE(4) !== 1) return null;

  let moduleSize = buffer.readUInt32LE(28);
  let offset     = 32;
  const points   = [];

  while (moduleSize > 0 && offset + moduleSize <= buffer.length) {
    const m = buffer.slice(offset, offset + moduleSize);

    // --- metadata ---
    const numLines = m.readUInt32LE(20);
    const numBeams = m.readUInt32LE(24);
    const numEchos = m.readUInt32LE(28);
    let mo = 32;

    // skip TimeStampStart/Stop (16 bytes * numLines)
    mo += numLines * 16;

    // Phi
    const phi = Array.from({ length: numLines }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLines;

    // ThetaStart
    const thetaStart = Array.from({ length: numLines }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLines;

    // ThetaStop
    const thetaStop = Array.from({ length: numLines }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLines;

    // scaling factor
    const scaling = m.readFloatLE(mo);
    mo += 4;

    // 다음 모듈 크기
    const nextModuleSize = m.readUInt32LE(mo);
    mo += 4;

    // reserved + dataContentEchos + dataContentBeams + reserved
    mo += 1;
    const dataContentEchos = m.readUInt8(mo++);
    const dataContentBeams = m.readUInt8(mo++);
    mo += 1;

    // echoSize, beamPropSize, beamAngleSize 계산
    const echoSize      = ((dataContentEchos & 1) ? 2 : 0) + ((dataContentEchos & 2) ? 2 : 0);
    const beamPropSize  = (dataContentBeams & 1) ? 1 : 0;
    const beamAngleSize = (dataContentBeams & 2) ? 2 : 0;
    const beamSize      = echoSize * numEchos + beamPropSize + beamAngleSize;

    // --- 점 읽기 (layer × beam × echo) ---
    for (let i = 0; i < numLines; i++) {
      const φ    = phi[i];
      const θ0   = thetaStart[i];
      const θend = thetaStop[i];
      for (let j = 0; j < numBeams; j++) {
        const base = mo + (i * numBeams + j) * beamSize;
        for (let e = 0; e < numEchos; e++) {
          const raw = echoSize > 0
            ? m.readUInt16LE(base + e * echoSize)
            : 0;
          const d = raw * scaling / 1000; // mm → m
          const θ = θ0 + j * ((θend - θ0) / (numBeams - 1) || 0);
          points.push({ x: d*Math.cos(φ)*Math.cos(θ),
                        y: d*Math.cos(φ)*Math.sin(θ),
                        z: d*Math.sin(φ),
                        layer: i,
                        channel: e });
        }
      }
    }

    // 다음 모듈로
    moduleSize = nextModuleSize;
    offset    += m.length;
  }

  return points;
}
