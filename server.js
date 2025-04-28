import dgram from 'dgram';
import fs from 'fs';

// UDP 소켓 생성
const socket = dgram.createSocket('udp4');

// 수신 처리
socket.on('message', (msg, rinfo) => {
  console.log(`\n[UDP] Message from ${rinfo.address}:${rinfo.port}`);

  if (msg.length < 32) {
    console.error('Invalid packet: too short');
    return;
  }

  const header = parseCompactHeader(msg.slice(0, 32));

  console.log('--- Header ---');
  console.log(header);

  const modules = parseModules(msg.slice(32));

  console.log('--- Modules ---');
  modules.forEach((module, idx) => {
    console.log(`Module ${idx}:`);
    console.log(`  Distance values (mm):`, module.distances);
    console.log(`  RSSI values:`, module.rssi);
  });

  modules.forEach((module, idx) => {
    const points = module.distances.map((d, i) => ({
      index: i,
      distance: d,
      rssi: module.rssi[i]
    }));

    // Save as JSON File
    fs.writeFileSync(`module_${idx}.json`, JSON.stringify(points, null, 2));
    console.log(`Saved module_${idx}.json`);
  });
});

// 에러 처리
socket.on('error', (err) => {
  console.error(`UDP socket error:\n${err.stack}`);
  socket.close();
});

// 바인딩
const LOCAL_PORT = 2115;
socket.bind(LOCAL_PORT, '0.0.0.0', () => {
  console.log(`Listening for UDP packets on 0.0.0.0:${LOCAL_PORT}`);
});


// -------------------- 파싱 함수들 --------------------

// Compact Format 헤더 파싱
function parseCompactHeader(buffer) {
  return {
    startOfFrame: buffer.readUInt32LE(0),
    commandId: buffer.readUInt32LE(4),
    telegramCounter: buffer.readBigUInt64LE(8),
    timeStampTransmit: buffer.readBigUInt64LE(16),
    telegramVersion: buffer.readUInt32LE(24),
    sizeModule0: buffer.readUInt32LE(28)
  };
}

// 모듈 파싱
function parseModules(buffer) {
  const modules = [];
  let offset = 0;

  while (offset < buffer.length) {
    const module = {};

    // 최소 Metadata는 84 bytes
    if (offset + 84 > buffer.length) {
      console.error('Unexpected end of buffer while reading module metadata');
      break;
    }

    // 메타데이터 읽기
    const segmentCounter = buffer.readBigUInt64LE(offset + 0);
    const frameNumber = buffer.readBigUInt64LE(offset + 8);
    const senderId = buffer.readUInt32LE(offset + 16);
    const numberOfLines = buffer.readUInt32LE(offset + 20);
    const numberOfBeams = buffer.readUInt32LE(offset + 24);
    const numberOfEchos = buffer.readUInt32LE(offset + 28);
    const distanceScalingFactor = buffer.readFloatLE(offset + 76); // 4바이트 float
    const nextModuleSize = buffer.readUInt32LE(offset + 80);

    const dataContentEchos = buffer.readUInt8(offset + 82);  // 거리(RSSI) 유무
    const dataContentBeams = buffer.readUInt8(offset + 83);  // 각도(Property) 유무

    // console.log(`Meta: #Lines=${numberOfLines}, #Beams=${numberOfBeams}, #Echos=${numberOfEchos}, Scaling=${distanceScalingFactor}`);

    // Measurement data 시작 지점
    const measurementStart = offset + 84;

    // Beam당 데이터 구조 해석
    const echoFields = []; // 거리, RSSI 읽을지 여부
    if (dataContentEchos & 0b00000001) echoFields.push('distance');
    if (dataContentEchos & 0b00000010) echoFields.push('rssi');

    const beamFields = []; // Beam당 한번 읽을 데이터
    if (dataContentBeams & 0b00000001) beamFields.push('property');
    if (dataContentBeams & 0b00000010) beamFields.push('theta');

    const tupleSizePerEcho = echoFields.length * 2; // 각 echo당 2 bytes (distance, rssi 각각 uint16)
    const tupleSizePerBeam = beamFields.reduce((sum, field) => sum + (field === 'property' ? 1 : 2), 0);

    const tupleSize = numberOfEchos * tupleSizePerEcho + tupleSizePerBeam;

    const totalTuples = numberOfLines * numberOfBeams;
    const expectedMeasurementSize = totalTuples * tupleSize;

    if (measurementStart + expectedMeasurementSize > buffer.length) {
      console.error('Measurement data exceeds buffer size');
      break;
    }

    // 거리, RSSI 수집
    const distances = [];
    const rssi = [];
    let pointer = measurementStart;

    for (let beamIdx = 0; beamIdx < numberOfBeams; beamIdx++) {
      for (let lineIdx = 0; lineIdx < numberOfLines; lineIdx++) {
        for (let echoIdx = 0; echoIdx < numberOfEchos; echoIdx++) {
          if (echoFields.includes('distance')) {
            const rawDistance = buffer.readUInt16LE(pointer);
            distances.push(rawDistance); // <-- 수정
            pointer += 2;
          }
          if (echoFields.includes('rssi')) {
            const rawRssi = buffer.readUInt16LE(pointer);
            rssi.push(rawRssi);
            pointer += 2;
          }
        }

        for (const field of beamFields) {
          if (field === 'property') {
            pointer += 1; // 1바이트
          } else if (field === 'theta') {
            pointer += 2; // 2바이트
          }
        }
      }
    }

    modules.push({ distances, rssi });

    // 다음 모듈로 이동
    if (nextModuleSize === 0) break;
    offset += nextModuleSize;
  }

  return modules;
}