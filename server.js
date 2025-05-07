// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dgram from 'dgram';
import { WebSocketServer } from 'ws';

// ES 모듈에서 __dirname 복원
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const UDP_PORT  = 2115;
const HTTP_PORT = 3000;

// HTTP 서버 (public 폴더 서빙)
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// HTTP + WS 서버 시작 (0.0.0.0 바인딩)
const httpServer = app.listen(HTTP_PORT, '0.0.0.0', () =>
  console.log(`HTTP ▶ http://0.0.0.0:${HTTP_PORT}`)
);
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', () => console.log('🌐 WebSocket client connected'));

// UDP 소켓
const udp = dgram.createSocket('udp4');
udp.bind(UDP_PORT, () =>
  console.log(`📡 UDP listening on port ${UDP_PORT}`)
);

// 프레임 단위 누적
let currentFrame = null;
let framePoints  = [];

udp.on('message', buffer => {
  const result = parseCompact(buffer);
  if (!result) return;

  const { frameNumber, pts } = result;

  // 새 프레임 시작
  if (currentFrame === null) {
    currentFrame = frameNumber;
    framePoints  = [];
  }

  // FrameNumber가 바뀌면 이전 프레임 완성 → 브로드캐스트
  if (frameNumber !== currentFrame) {
    const msg = JSON.stringify(framePoints);
    for (const c of wss.clients) {
      if (c.readyState === 1) c.send(msg);
    }
    currentFrame = frameNumber;
    framePoints  = [];
  }

  // 같은 프레임이면 누적
  framePoints.push(...pts);
});


/**
 * Compact Format 파서
 * @returns { frameNumber: number, pts: Array<{x,y,z,layer,channel,beamIdx,theta}> }
 */
function parseCompact(buffer) {
  if (buffer.length < 32) return null;
  if (buffer.readUInt32BE(0) !== 0x02020202) return null;  // SOF
  if (buffer.readUInt32LE(4)  !== 1)          return null;  // commandId

  let offset     = 32;
  let moduleSize = buffer.readUInt32LE(28);
  const allPts   = [];

  while (moduleSize > 0 && offset + moduleSize <= buffer.length) {
    const m = buffer.slice(offset, offset + moduleSize);

    // ─── 메타데이터 ───
    const frameNumber = Number(m.readBigUInt64LE(8));      // FrameNumber (8바이트) :contentReference[oaicite:1]{index=1}:contentReference[oaicite:2]{index=2}
    const numLayers   = m.readUInt32LE(20);  // numberOfLinesInModule
    const numBeams    = m.readUInt32LE(24);  // NumberOfBeamsPerScan
    const numEchos    = m.readUInt32LE(28);  // NumberOfEchosPerBeam
    let mo = 32;

    // TimestampStart/Stop 건너뛰기
    mo += numLayers * 16;

    // Phi, ThetaStart, ThetaStop, scalingFactor 파싱
    const phi      = Array.from({ length: numLayers }, (_, i) =>
                     m.readFloatLE(mo + 4 * i));
    mo += 4 * numLayers;

    const thetaS   = Array.from({ length: numLayers }, (_, i) =>
                     m.readFloatLE(mo + 4 * i));
    mo += 4 * numLayers;

    const thetaE   = Array.from({ length: numLayers }, (_, i) =>
                     m.readFloatLE(mo + 4 * i));
    mo += 4 * numLayers;

    const scaling  = m.readFloatLE(mo);
    mo += 4;

    const nextSize = m.readUInt32LE(mo);
    mo += 4;

    // reserved → DataContentEchos → DataContentBeams → reserved
    mo += 1;
    const echos   = m.readUInt8(mo++);
    const beams   = m.readUInt8(mo++);
    mo += 1;

    const echoSz      = ((echos & 1) ? 2 : 0) + ((echos & 2) ? 2 : 0);
    const beamPropSz  = (beams & 1) ? 1 : 0;
    const beamAngleSz = (beams & 2) ? 2 : 0;
    const beamSz      = echoSz * numEchos + beamPropSz + beamAngleSz;

    // ─── 측정 데이터 (beam-major) ───
    const dataOff = mo;
    for (let b = 0; b < numBeams; b++) {
      for (let l = 0; l < numLayers; l++) {
        const base = dataOff + (b * numLayers + l) * beamSz;
        for (let ec = 0; ec < numEchos; ec++) {
          const raw = echoSz > 0
            ? m.readUInt16LE(base + ec * echoSz)
            : 0;
          const d   = raw * scaling / 1000;  // mm→m

          const φ = phi[l];
          const θ = thetaS[l] + b * ((thetaE[l] - thetaS[l]) / (numBeams - 1));

          allPts.push({
            x: d * Math.cos(φ) * Math.cos(θ),
            y: d * Math.cos(φ) * Math.sin(θ),
            z: d * Math.sin(φ),
            layer:   l,
            channel: ec,
            beamIdx: b,
            theta:   θ
          });
        }
      }
    }

    moduleSize = nextSize;
    offset    += m.length;
  }

  return { frameNumber, pts: allPts };
}
