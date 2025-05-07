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

// 3) UDP 수신 → Compact 파싱 → WS 브로드캐스트
const udp = dgram.createSocket('udp4');
udp.bind(UDP_PORT, () =>
  console.log(`📡 UDP 포트 ${UDP_PORT} 번에서 수신 대기 중`)
);
udp.on('message', buffer => {
  const pts = parseCompact(buffer);
  if (!pts || !pts.length) return;
  const msg = JSON.stringify(pts);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(msg);
  }
});

// 포인트 클라우드 스무딩 함수 (예시)
function smoothPoints(points, windowSize = 3) {
  if (points.length < windowSize) return points;
  const smoothed = [];
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < points.length; i++) {
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (let j = -half; j <= half; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < points.length) {
        sx += points[idx].x;
        sy += points[idx].y;
        sz += points[idx].z;
        cnt++;
      }
    }
    smoothed.push({
      x: sx / cnt,
      y: sy / cnt,
      z: sz / cnt,
      layer: points[i].layer,
      channel: points[i].channel
    });
  }
  return smoothed;
}

/**
 * LiDAR Compact Format 파서
 * - 프레임 헤더: 32바이트 (SOF, commandId, telegramCounter, timestamp, moduleSize)
 * - 그 뒤 모듈별로 메타데이터 + 측정데이터
 */
function parseCompact(buffer) {
  if (buffer.length < 32) return null;

  // 1) SOF 검증
  if (buffer.readUInt32BE(0) !== 0x02020202) return null;
  // 2) commandId 검증
  if (buffer.readUInt32LE(4) !== 1) return null;

  let offset      = 32;
  let moduleSize  = buffer.readUInt32LE(28);
  const points    = [];

  while (moduleSize > 0 && offset + moduleSize <= buffer.length) {
    const m = buffer.slice(offset, offset + moduleSize);

    // --- 메타데이터 파싱 ---
    let mo = 0;  // m 내부 오프셋

    // numLayers, numBeams, numEchos
    const numLayers = m.readUInt32LE(20);
    const numBeams  = m.readUInt32LE(24);
    const numEchos  = m.readUInt32LE(28);
    mo = 32;

    // TimeStampStart/Stop 건너뛰기 (16바이트 × numLayers)
    mo += numLayers * 16;

    // Phi 배열 (수직각)
    const phiArray = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    // ThetaStart 배열 (시작 수평각)
    const thetaStart = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    // ThetaStop 배열 (종료 수평각)
    const thetaStop = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    // scalingFactor 파싱
    const scaling = m.readFloatLE(mo);
    mo += 4;

    // 다음 모듈 크기 파싱
    const nextModuleSize = m.readUInt32LE(mo);
    mo += 4;

    // --- 여기서부터 정확히 4바이트를 처리합니다 ---
    // 1) reserved (1바이트) 건너뛰기
    mo += 1;
    // 2) DataContentEchos (1바이트)
    const dataContentEchos = m.readUInt8(mo++);
    // 3) DataContentBeams (1바이트)
    const dataContentBeams = m.readUInt8(mo++);
    // 4) reserved (1바이트) 건너뛰기
    mo += 1;
    // ----------------------------------------------

    // echoSize, beamPropSize, beamAngleSize 계산
    const echoSize      = ((dataContentEchos & 1) ? 2 : 0) + ((dataContentEchos & 2) ? 2 : 0);
    const beamPropSize  = (dataContentBeams & 1) ? 1 : 0;
    const beamAngleSize = (dataContentBeams & 2) ? 2 : 0;
    const beamSize      = echoSize * numEchos + beamPropSize + beamAngleSize;

    // 레이어별 데이터 크기 계산
    const layerSizes = Array.from({ length: numLayers }, (_, idx) => {
      const span = thetaStop[idx] - thetaStart[idx];
      const step = (thetaStop[0] - thetaStart[0]) / (numBeams - 1);
      const layerBeams = Math.floor(span / step) + 1;
      return layerBeams * beamSize;
    });

    // --- 측정 데이터(beam × layer × echo) 파싱 ---
    let dataOffset = mo;
    for (let layerIdx = 0; layerIdx < numLayers; layerIdx++) {
      const span = thetaStop[layerIdx] - thetaStart[layerIdx];
      const step = (thetaStop[0] - thetaStart[0]) / (numBeams - 1) || 0;
      const layerBeams = Math.floor(span / step) + 1;

      const layerPoints = [];
      for (let beamIdx = 0; beamIdx < layerBeams; beamIdx++) {
        const base = dataOffset + beamIdx * beamSize;
        for (let echoIdx = 0; echoIdx < numEchos; echoIdx++) {
          const raw = echoSize > 0
            ? m.readUInt16LE(base + echoIdx * echoSize)
            : 0;
          const d = raw * scaling / 1000;  // mm → m

          const φ = phiArray[layerIdx];
          const θ = thetaStart[layerIdx] + beamIdx * (step);

          layerPoints.push({
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

      // beamIdx 순서로 정렬 후 points 배열에 추가
      layerPoints.sort((a, b) => a.beamIdx - b.beamIdx);
      points.push(...layerPoints);

      dataOffset += layerSizes[layerIdx];
    }

    // 다음 모듈로 이동
    moduleSize = nextModuleSize;
    offset    += m.length;
  }

  return points;
}
