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
const UDP_PORT  = 2115;  // LiDAR 데이터 수신용 UDP 포트
const HTTP_PORT = 3000;  // 웹 서버용 HTTP 포트

// 1) HTTP 서버: public 폴더 서빙
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// 2) HTTP + WebSocket 서버 시작 (모든 인터페이스 바인딩)
const httpServer = app.listen(HTTP_PORT, '0.0.0.0', () =>
  console.log(`HTTP ▶ http://0.0.0.0:${HTTP_PORT}`)
);
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', () =>
  console.log('🌐 WS 클라이언트 연결됨')
);

// 3) UDP 소켓 바인딩
const udp = dgram.createSocket('udp4');
udp.bind(UDP_PORT, () =>
  console.log(`📡 UDP 포트 ${UDP_PORT}번에서 수신 대기 중`)
);

// 현재 프레임 버퍼
let currentFrame  = null;
let framePoints   = [];

udp.on('message', buffer => {
  const result = parseCompact(buffer);
  if (!result) return;

  const { frameNumber, pts } = result;

  // 첫 모듈 도착 시 초기화
  if (currentFrame === null) {
    currentFrame = frameNumber;
    framePoints  = [];
  }

  // 새 프레임 감지 → 이전 프레임 완성본 브로드캐스트
  if (frameNumber !== currentFrame) {
    const msg = JSON.stringify(framePoints);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
    currentFrame = frameNumber;
    framePoints  = [];
  }

  // 같은 프레임이면 누적
  framePoints.push(...pts);
});

/**
 * Compact Format 파서
 * @param {Buffer} buffer
 * @returns {{ frameNumber: number, pts: Array<{x,y,z,layer,channel,beamIdx,theta}> } | null}
 */
function parseCompact(buffer) {
  if (buffer.length < 32) return null;
  // SOF 확인
  if (buffer.readUInt32BE(0) !== 0x02020202) return null;
  // commandId 확인
  if (buffer.readUInt32LE(4) !== 1) return null;

  let offset      = 32;
  let moduleSize  = buffer.readUInt32LE(28);
  const allPts    = [];
  let frameNumber = null;    // ← 여기에 선언

  while (moduleSize > 0 && offset + moduleSize <= buffer.length) {
    const m = buffer.slice(offset, offset + moduleSize);

    // 메타데이터
    frameNumber = Number(m.readBigUInt64LE(8));  // FrameNumber
    const numLayers = m.readUInt32LE(20);
    const numBeams  = m.readUInt32LE(24);
    const numEchos  = m.readUInt32LE(28);
    let mo = 32;

    // TimestampStart/Stop 스킵
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

    // scalingFactor
    const scaling = m.readFloatLE(mo);
    mo += 4;

    // nextModuleSize
    const nextModuleSize = m.readUInt32LE(mo);
    mo += 4;

    // reserved → DataContentEchos → DataContentBeams → reserved
    mo += 1;
    const dataContentEchos = m.readUInt8(mo++);
    const dataContentBeams = m.readUInt8(mo++);
    mo += 1;

    const echoSize      = ((dataContentEchos & 1) ? 2 : 0) + ((dataContentEchos & 2) ? 2 : 0);
    const beamPropSize  = (dataContentBeams & 1) ? 1 : 0;
    const beamAngleSize = (dataContentBeams & 2) ? 2 : 0;
    const beamSize      = echoSize * numEchos + beamPropSize + beamAngleSize;
    const dataOffset    = mo;

    // 측정 데이터 파싱 (beam-major)
    for (let b = 0; b < numBeams; b++) {
      for (let l = 0; l < numLayers; l++) {
        const base = dataOffset + (b * numLayers + l) * beamSize;
        for (let ec = 0; ec < numEchos; ec++) {
          const raw = echoSize > 0
            ? m.readUInt16LE(base + ec * echoSize)
            : 0;
          const d = raw * scaling / 1000;  // mm → m

          const φ = phiArray[l];
          const θ = thetaStart[l] +
                    b * ((thetaStop[l] - thetaStart[l]) / (numBeams - 1));

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

    moduleSize = nextModuleSize;
    offset    += m.length;
  }

  // frameNumber가 설정되지 않았으면 null 반환
  if (frameNumber === null) return null;
  return { frameNumber, pts: allPts };
}
