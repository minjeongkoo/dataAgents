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

// HTTP 서버: public 폴더 서빙
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// HTTP + WebSocket 서버 시작 (모든 인터페이스 바인딩)
const httpServer = app.listen(HTTP_PORT, '0.0.0.0', () =>
  console.log(`HTTP ▶ http://0.0.0.0:${HTTP_PORT}`)
);
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws =>
  console.log('🌐 WS 클라이언트 연결됨')
);

// UDP 소켓 바인딩
const udp = dgram.createSocket('udp4');
udp.bind(UDP_PORT, () =>
  console.log(`📡 UDP 포트 ${UDP_PORT}번에서 수신 대기 중`)
);

// 현재 스캔(telegramCounter) 버퍼
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

  // 새로운 telegramCounter가 감지되면
  // 이전 스캔 완성본을 브로드캐스트
  if (telegramCounter !== currentCounter) {
    const msg = JSON.stringify(currentPoints);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
    // 새 스캔 시작
    currentCounter = telegramCounter;
    currentPoints  = [];
  }

  // 같은 스캔이면 포인트 누적
  currentPoints.push(...pts);
});

/**
 * Compact Format 파서
 * @returns { telegramCounter: number, pts: Array<{x,y,z,layer,channel,beamIdx,theta}> }
 */
function parseCompact(buffer) {
  if (buffer.length < 32) return null;
  // SOF 검증
  if (buffer.readUInt32BE(0) !== 0x02020202) return null;
  // commandId 검증
  if (buffer.readUInt32LE(4) !== 1) return null;

  const telegramCounter = Number(buffer.readBigUInt64LE(8));
  let offset     = 32;
  let moduleSize = buffer.readUInt32LE(28);
  const points   = [];

  while (moduleSize > 0 && offset + moduleSize <= buffer.length) {
    const m = buffer.slice(offset, offset + moduleSize);

    // 메타데이터
    const numLayers = m.readUInt32LE(20);
    const numBeams  = m.readUInt32LE(24);
    const numEchos  = m.readUInt32LE(28);
    let mo = 32;

    // TimestampStart/Stop 스킵
    mo += numLayers * 16;

    // 각종 배열 파싱
    const phiArray = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    const thetaStart = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    const thetaStop = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    // scalingFactor
    const scaling = m.readFloatLE(mo);
    mo += 4;

    // 다음 모듈 크기
    const nextModuleSize = m.readUInt32LE(mo);
    mo += 4;

    // reserved → DataContentEchos → DataContentBeams → reserved
    mo += 1;
    const dataContentEchos = m.readUInt8(mo++);
    const dataContentBeams = m.readUInt8(mo++);
    mo += 1;

    // 크기 계산
    const echoSize      = ((dataContentEchos & 1) ? 2 : 0) + ((dataContentEchos & 2) ? 2 : 0);
    const beamPropSize  = (dataContentBeams & 1) ? 1 : 0;
    const beamAngleSize = (dataContentBeams & 2) ? 2 : 0;
    const beamSize      = echoSize * numEchos + beamPropSize + beamAngleSize;

    const dataOffset = mo;

    // 측정 데이터 파싱 (beam-major 순서)
    for (let beamIdx = 0; beamIdx < numBeams; beamIdx++) {
      for (let layerIdx = 0; layerIdx < numLayers; layerIdx++) {
        const base = dataOffset + (beamIdx * numLayers + layerIdx) * beamSize;
        for (let echoIdx = 0; echoIdx < numEchos; echoIdx++) {
          const raw = echoSize > 0 ? m.readUInt16LE(base + echoIdx * echoSize) : 0;
          const d   = raw * scaling / 1000;  // mm → m

          const φ = phiArray[layerIdx];
          const θ = thetaStart[layerIdx] +
                    beamIdx * ((thetaStop[layerIdx] - thetaStart[layerIdx]) / (numBeams - 1));

          points.push({
            x: d * Math.cos(φ) * Math.cos(θ),
            y: d * Math.cos(φ) * Math.sin(θ),
            z: d * Math.sin(φ),
            layer: layerIdx,
            channel: echoIdx,
            beamIdx,
            theta: θ
          });
        }
      }
    }

    // 다음 모듈로
    moduleSize = nextModuleSize;
    offset    += m.length;
  }

  return { telegramCounter, pts: points };
}
