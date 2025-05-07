// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dgram from 'dgram';
import { WebSocketServer } from 'ws';

// ES 모듈에서 __dirname 복원
// Restore __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// 서버 설정
// Server Configuration
const UDP_PORT  = 2115;  // 라이다 데이터 수신용 UDP 포트 / UDP port for LiDAR data reception
const HTTP_PORT = 3000;  // 웹 서버용 HTTP 포트 / HTTP port for web server

// 1) HTTP 서버: public 폴더 서빙
// 1) HTTP Server: Serving public folder
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2) HTTP + WebSocket 서버 설정
// 2) HTTP + WebSocket Server Configuration
const httpServer = app.listen(HTTP_PORT, () =>
  console.log(`HTTP ▶ http://localhost:${HTTP_PORT}`)
);
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {
  console.log('🌐 WS client connected');
});

// 3) UDP 수신 → Compact 파싱 → WS 브로드캐스트
// 3) UDP Reception → Compact Parsing → WS Broadcast
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
 * 포인트 클라우드 데이터 스무딩 함수
 * Point Cloud Data Smoothing Function
 * 
 * @param {Array} points - 원본 포인트 클라우드 데이터 / Original point cloud data
 * @param {number} windowSize - 스무딩 윈도우 크기 (기본값: 3) / Smoothing window size (default: 3)
 * @returns {Array} 스무딩된 포인트 클라우드 데이터 / Smoothed point cloud data
 * 
 */

function smoothPoints(points, windowSize = 3) {
  if (points.length < windowSize) return points;
  
  const smoothedPoints = [];
  const halfWindow = Math.floor(windowSize / 2);
  
  for (let i = 0; i < points.length; i++) {
    let sumX = 0, sumY = 0, sumZ = 0;
    let count = 0;
    
    // 주변 포인트들의 평균 계산
    // Calculate average of surrounding points
    for (let j = -halfWindow; j <= halfWindow; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < points.length) {
        sumX += points[idx].x;
        sumY += points[idx].y;
        sumZ += points[idx].z;
        count++;
      }
    }
    
    smoothedPoints.push({
      x: sumX / count,
      y: sumY / count,
      z: sumZ / count,
      layer: points[i].layer,
      channel: points[i].channel
    });
  }
  
  return smoothedPoints;
}

/**
 * 라이다 Compact Format 파서
 * LiDAR Compact Format Parser
 * 
 * 데이터 구조 / Data Structure:
 * 1. 프레임 헤더 (32바이트) / Frame Header (32 bytes)
 *    - SOF (Start of Frame): 0x02020202
 *    - commandId: 1
 *    - telegramCounter
 *    - timestamp
 *    - sizeModule0
 * 
 * 2. 모듈 데이터 / Module Data
 *    - 메타데이터 / Metadata:
 *      * numLines: 레이어 수 / Number of layers
 *      * numBeams: 빔 수 / Number of beams
 *      * numEchos: 에코 수 / Number of echoes
 *      * Phi[]: 각 레이어의 수직 각도 / Vertical angle for each layer
 *      * ThetaStart[]: 각 레이어의 시작 수평 각도 / Starting horizontal angle for each layer
 *      * ThetaStop[]: 각 레이어의 종료 수평 각도 / Ending horizontal angle for each layer
 *      * scalingFactor: 거리 스케일링 계수 / Distance scaling factor
 * 
 *    - 측정 데이터 / Measurement Data:
 *      * 각 에코 채널별 거리 데이터 / Distance data for each echo channel
 *      * 거리(raw) * scaling → 미터 단위로 변환 / Convert raw distance * scaling to meters
 *      * φ/θ 보간을 통한 x,y,z 좌표 계산 / Calculate x,y,z coordinates through φ/θ interpolation
 * 
 * @param {Buffer} buffer - 수신된 UDP 데이터 버퍼 / Received UDP data buffer
 * @returns {Array|null} 파싱된 포인트 클라우드 데이터 또는 null / Parsed point cloud data or null
 * 
 */
function parseCompact(buffer) {
  if (buffer.length < 32) return null;
  // 1) SOF 검증 / SOF validation
  if (buffer.readUInt32BE(0) !== 0x02020202) return null;
  // 2) commandId 검증 / commandId validation
  if (buffer.readUInt32LE(4) !== 1) return null;

  let moduleSize = buffer.readUInt32LE(28);
  let offset     = 32;
  const points   = [];

  while (moduleSize > 0 && offset + moduleSize <= buffer.length) {
    const m = buffer.slice(offset, offset + moduleSize);

    // --- 메타데이터 파싱 / Metadata parsing ---
    const numLayers = m.readUInt32LE(20);  // 레이어 수 / Number of layers
    const numBeams = m.readUInt32LE(24);   // 빔 수 / Number of beams
    const numEchos = m.readUInt32LE(28);   // 에코 수 / Number of echoes
    let mo = 32;

    // TimeStampStart/Stop 건너뛰기 (16바이트 * numLayers)
    // Skip TimeStampStart/Stop (16 bytes * numLayers)
    mo += numLayers * 16;

    // Phi (수직 각도) 배열 파싱 / Parse Phi (vertical angle) array
    const phiArray = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    // ThetaStart (시작 수평 각도) 배열 파싱 / Parse ThetaStart (starting horizontal angle) array
    const thetaStart = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    // ThetaStop (종료 수평 각도) 배열 파싱 / Parse ThetaStop (ending horizontal angle) array
    const thetaStop = Array.from({ length: numLayers }, (_, i) =>
      m.readFloatLE(mo + 4 * i)
    );
    mo += 4 * numLayers;

    // 스케일링 계수 파싱 / Parse scaling factor
    const scaling = m.readFloatLE(mo);
    mo += 4;

    // 다음 모듈 크기 파싱 / Parse next module size
    const nextModuleSize = m.readUInt32LE(mo);
    mo += 4;

    // 데이터 컨텐츠 설정 파싱 / Parse data content settings
    mo += 1;
    const dataContentEchos = m.readUInt8(mo++);
    const dataContentBeams = m.readUInt8(mo++);
    mo += 1;

    // 데이터 크기 계산 / Calculate data sizes
    const echoSize      = ((dataContentEchos & 1) ? 2 : 0) + ((dataContentEchos & 2) ? 2 : 0);
    const beamPropSize  = (dataContentBeams & 1) ? 1 : 0;
    const beamAngleSize = (dataContentBeams & 2) ? 2 : 0;
    const beamSize      = echoSize * numEchos + beamPropSize + beamAngleSize;

    // 각 레이어별 데이터 크기 계산 / Calculate data size for each layer
    const layerSizes = Array.from({ length: numLayers }, (_, layerIdx) => {
      const layerBeams = Math.floor((thetaStop[layerIdx] - thetaStart[layerIdx]) / 
        ((thetaStop[0] - thetaStart[0]) / (numBeams - 1))) + 1;
      return layerBeams * beamSize;
    });

    // --- 포인트 클라우드 데이터 파싱 (beam × layer × echo) ---
    // --- Point cloud data parsing (beam × layer × echo) ---
    let currentOffset = mo;
    for (let layerIdx = 0; layerIdx < numLayers; layerIdx++) {
      const layerBeams = Math.floor((thetaStop[layerIdx] - thetaStart[layerIdx]) / 
        ((thetaStop[0] - thetaStart[0]) / (numBeams - 1))) + 1;
      
      // 빔 데이터를 임시 배열에 저장
      // Store beam data in temporary array
      const layerPoints = [];
      
      for (let beamIdx = 0; beamIdx < layerBeams; beamIdx++) {
        const base = currentOffset + (beamIdx * beamSize);
        
        for (let echoIdx = 0; echoIdx < numEchos; echoIdx++) {
          // 거리 데이터 읽기 / Read distance data
          const raw = echoSize > 0
            ? m.readUInt16LE(base + echoIdx * echoSize)
            : 0;
          
          // 거리를 미터 단위로 변환 / Convert distance to meters
          const d = raw * scaling / 1000; // mm → m
          
          // 각도 계산 / Calculate angles
          const φ = phiArray[layerIdx];
          const θ = thetaStart[layerIdx] + beamIdx * ((thetaStop[layerIdx] - thetaStart[layerIdx]) / (layerBeams - 1) || 0);
          
          // 3D 좌표 계산 (구면 좌표계 → 직교 좌표계)
          // Calculate 3D coordinates (spherical → cartesian)
          layerPoints.push({
            x: d * Math.cos(φ) * Math.cos(θ),
            y: d * Math.cos(φ) * Math.sin(θ),
            z: d * Math.sin(φ),
            layer: layerIdx,
            channel: echoIdx,
            beamIdx: beamIdx,  // 빔 인덱스 추가 / Add beam index
            theta: θ          // 각도 정보 추가 / Add angle information
          });
        }
      }

      // 빔 인덱스 순서대로 정렬
      // Sort by beam index
      layerPoints.sort((a, b) => a.beamIdx - b.beamIdx);
      
      // 정렬된 포인트를 최종 배열에 추가
      // Add sorted points to final array
      points.push(...layerPoints);
      
      currentOffset += layerSizes[layerIdx];
    }

    // 다음 모듈로 이동 / Move to next module
    moduleSize = nextModuleSize;
    offset    += m.length;
  }

  return points;
}
