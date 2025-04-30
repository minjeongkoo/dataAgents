// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dgram from 'dgram';
import { WebSocketServer } from 'ws';

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
const httpServer = app.listen(HTTP_PORT, () =>
  console.log(`HTTP server ▶ http://localhost:${HTTP_PORT}`)
);
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {
  console.log('🌐 WebSocket client connected');
});

// 3) UDP 수신 → Compact 파서 → WebSocket 브로드캐스트
const udp = dgram.createSocket('udp4');
udp.bind(UDP_PORT, () => {
  console.log(`📡 UDP listening on port ${UDP_PORT}`);
});
udp.on('message', buffer => {
  const pts = parseCompact(buffer);
  if (!pts) return;
  const msg = JSON.stringify(pts);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(msg);
  }
});

/**
 * Compact Format 파서
 * - 32바이트 프레임 헤더(sof, commandId, sizeModule0 등) 파싱
 * - sizeModule0 만큼 각 모듈 읽고, 다음 모듈 크기를 nextModuleSize로 갱신 반복 :contentReference[oaicite:0]{index=0}
 * - 모듈 안에서는 metadata(레이어 수, 빔 수, 각도 배열 등) 읽고 :contentReference[oaicite:1]{index=1}
 * - measurement data에서 첫 에코 거리(raw), scaling factor 적용 → m 단위 변환
 * - elevation(phi), azimuth(thetaStart→thetaStop 보간) 사용해 x,y,z 계산
 */
function parseCompact(buffer) {
  if (buffer.length < 32) return null;
  if (buffer.readUInt32BE(0) !== 0x02020202) return null;        // startOfFrame :contentReference[oaicite:2]{index=2}&#8203;:contentReference[oaicite:3]{index=3}
  if (buffer.readUInt32LE(4) !== 1) return null;                  // commandId 1 확인 :contentReference[oaicite:4]{index=4}&#8203;:contentReference[oaicite:5]{index=5}

  let moduleSize = buffer.readUInt32LE(28);                       // sizeModule0 (리틀엔디언) :contentReference[oaicite:6]{index=6}&#8203;:contentReference[oaicite:7]{index=7}
  let offset     = 32;
  const points   = [];

  while (moduleSize > 0 && offset + moduleSize <= buffer.length) {
    const m = buffer.slice(offset, offset + moduleSize);

    // --- metadata 파싱 ---
    const numLines = m.readUInt32LE(20);
    const numBeams = m.readUInt32LE(24);
    const numEchos = m.readUInt32LE(28);

    let mo = 32;  // metadata start after header fields

    // TimeStampStart/Stop 스킵
    mo += numLines * 16;

    // Phi 배열
    const phi = [];
    for (let i = 0; i < numLines; i++) {
      phi.push(m.readFloatLE(mo + 4*i));
    }
    mo += 4 * numLines;

    // ThetaStart 배열
    const thetaStart = [];
    for (let i = 0; i < numLines; i++) {
      thetaStart.push(m.readFloatLE(mo + 4*i));
    }
    mo += 4 * numLines;

    // ThetaStop 배열
    const thetaStop = [];
    for (let i = 0; i < numLines; i++) {
      thetaStop.push(m.readFloatLE(mo + 4*i));
    }
    mo += 4 * numLines;

    // 거리 스케일링 계수
    const scaling = m.readFloatLE(mo);
    mo += 4;

    // 다음 모듈 크기
    const nextModuleSize = m.readUInt32LE(mo);
    mo += 4;

    // reserved + DataContentEchos + DataContentBeams + reserved
    mo += 1;
    const dataContentEchos = m.readUInt8(mo++);
    const dataContentBeams = m.readUInt8(mo++);
    mo += 1;

    // measurement data offset = mo
    const echoSize      = (dataContentEchos & 1 ? 2 : 0) + (dataContentEchos & 2 ? 2 : 0);
    const beamPropSize  = (dataContentBeams & 1 ? 1 : 0);
    const beamAngleSize = (dataContentBeams & 2 ? 2 : 0);
    const beamSize      = echoSize * numEchos + beamPropSize + beamAngleSize;

    // --- 실제 포인트 계산 ---
    for (let i = 0; i < numLines; i++) {
      const φ   = phi[i];
      const th0 = thetaStart[i];
      const th1 = thetaStop[i];
      for (let j = 0; j < numBeams; j++) {
        const idx = i * numBeams + j;
        const pos = mo + idx * beamSize;

        // 첫 에코 거리(raw)
        const raw = echoSize > 0
          ? m.readUInt16LE(pos)
          : 0;
        const d = raw * scaling / 1000; // mm → m

        // 빔별 각도 보간
        const θ = th0 + j * ((th1 - th0) / (numBeams - 1));

        points.push({
          x: d * Math.cos(φ) * Math.cos(θ),
          y: d * Math.cos(φ) * Math.sin(θ),
          z: d * Math.sin(φ),
        });
      }
    }

    // 다음 모듈로
    moduleSize = nextModuleSize;
    offset    += m.length;
  }

  return points;
}
