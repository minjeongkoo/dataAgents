// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dgram from 'dgram';
import { WebSocketServer } from 'ws';

// ES 모듈에서 __dirname 복원
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// 서버 설정
const UDP_PORT  = 2115;  // LiDAR 데이터 수신용 UDP 포트
const HTTP_PORT = 3000;  // 웹 서버용 HTTP 포트

// 1) HTTP Server: public 폴더 서빙
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2) HTTP + WebSocket 서버 시작
const httpServer = app.listen(HTTP_PORT, () =>
  console.log(`HTTP ▶ http://localhost:${HTTP_PORT}`)
);
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {
  console.log('🌐 WS 클라이언트 연결됨');
});

// 3) UDP 수신 → Compact 파싱 → 스캔별 누적 → WS 브로드캐스트
const udp = dgram.createSocket('udp4');
udp.bind(UDP_PORT, () =>
  console.log(`📡 UDP 포트 ${UDP_PORT} 번에서 수신 대기 중`)
);

// 현재 스캔 버퍼
let currentCounter = null;
let currentPoints  = [];

udp.on('message', buffer => {
  const result = parseCompact(buffer);
  if (!result) return;

  const { telegramCounter, pts } = result;

  // 첫 모듈일 때 초기화
  if (currentCounter === null) {
    currentCounter = telegramCounter;
    currentPoints  = [];
  }

  // telegramCounter가 바뀌면, 이전 스캔 완성 → 브로드캐스트
  if (telegramCounter !== currentCounter) {
    const msg = JSON.stringify(currentPoints);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
    // 새로운 스캔 시작
    currentCounter = telegramCounter;
    currentPoints  = [];
  }

  // 같은 스캔이라면 포인트 누적
  currentPoints.push(...pts);
});

// parseCompact: buffer → { telegramCounter, pts } or null
function parseCompact(buffer) {
  if (buffer.length < 32) return null;

  // 1) SOF 검증
  if (buffer.readUInt32BE(0) !== 0x02020202) return null;
  // 2) commandId 검증
  if (buffer.readUInt32LE(4) !== 1) return null;

  // telegramCounter (8바이트 LE)
  const telegramCounter = Number(buffer.readBigUInt64LE(8));

  let offset     = 32;
  let moduleSize = buffer.readUInt32LE(28);
  const points   = [];

  while (moduleSize > 0 && offset + moduleSize <= buffer.length) {
    const m = buffer.slice(offset, offset + moduleSize);

    // ─── 메타데이터 파싱 ───
    const numLayers = m.readUInt32LE(20);  // NumberOfLinesInModule
    const numBeams  = m.readUInt32LE(24);  // NumberOfBeamsPerScan
    const numEchos  = m.readUInt32LE(28);  // NumberOfEchosPerBeam
    let mo = 32;

    // TimeStampStart/Stop 스킵 (16바이트 × numLayers)
    mo += numLayers * 16;

    // Phi 배열
    const phiArray = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    // ThetaStart 배열
    const thetaStart = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    // ThetaStop 배열
    const thetaStop = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    // scalingFactor 파싱
    const scaling = m.readFloatLE(mo);
    mo += 4;

    // nextModuleSize 파싱
    const nextModuleSize = m.readUInt32LE(mo);
    mo += 4;

    // reserved → DataContentEchos → DataContentBeams → reserved
    mo += 1;
    const dataContentEchos = m.readUInt8(mo++);
    const dataContentBeams = m.readUInt8(mo++);
    mo += 1;

    // echo/beam 크기 계산
    const echoSize      = ((dataContentEchos & 1) ? 2 : 0) + ((dataContentEchos & 2) ? 2 : 0);
    const beamPropSize  = (dataContentBeams & 1) ? 1 : 0;
    const beamAngleSize = (dataContentBeams & 2) ? 2 : 0;
    const beamSize      = echoSize * numEchos + beamPropSize + beamAngleSize;

    const dataOffset = mo;

    // ─── 측정 데이터 파싱: “빔 우선 → 레이어” 순서 ───
    for (let beamIdx = 0; beamIdx < numBeams; beamIdx++) {
      for (let layerIdx = 0; layerIdx < numLayers; layerIdx++) {
        const base = dataOffset + (beamIdx * numLayers + layerIdx) * beamSize;
        for (let echoIdx = 0; echoIdx < numEchos; echoIdx++) {
          const raw = echoSize > 0
            ? m.readUInt16LE(base + echoIdx * echoSize)
            : 0;
          const d = raw * scaling / 1000;  // mm → m

          const φ = phiArray[layerIdx];
          const θ = thetaStart[layerIdx]
                    + beamIdx * ((thetaStop[layerIdx] - thetaStart[layerIdx]) / (numBeams - 1));

          points.push({ x: d * Math.cos(φ) * Math.cos(θ),
                        y: d * Math.cos(φ) * Math.sin(θ),
                        z: d * Math.sin(φ),
                        layer: layerIdx,
                        channel: echoIdx,
                        beamIdx,
                        theta: θ });
        }
      }
    }

    // 다음 모듈로 이동
    moduleSize = nextModuleSize;
    offset    += m.length;
  }

  return { telegramCounter, pts: points };
}
