// udp-logger.js

const dgram = require('dgram');

// 1) 소켓 생성 ('udp4' 또는 'udp6')
const socket = dgram.createSocket('udp4');

// 2) 바인딩할 호스트/IP와 포트
const LISTEN_HOST = '0.0.0.0';     // 모든 인터페이스 수신
const LISTEN_PORT = 2115;         // 예: 2115 포트로 수신

// 3) 소켓이 준비되면 출력
socket.on('listening', () => {
  const { address, port } = socket.address();
  console.log(`[UDP] Listening on ${address}:${port}`);
});

// 4) 패킷 수신 시 메시지와 rinfo 객체를 통해 발신지 정보 로깅
socket.on('message', (msg, rinfo) => {
  // rinfo.address, rinfo.port, rinfo.size (바이트 길이) 등이 포함됨
  console.log(`[UDP] Received ${rinfo.size} bytes from ${rinfo.address}:${rinfo.port}`);
  // 원시 데이터를 헥사 문자열 혹은 UTF-8로 출력
  console.log(`[UDP] Data (hex): ${msg.toString('hex')}`);
  // console.log(`[UDP] Data (utf8): ${msg.toString('utf8')}`);
});

// 5) 에러 처리
socket.on('error', (err) => {
  console.error(`[UDP] Error: ${err.stack}`);
  socket.close();
});

// 6) 소켓 바인딩
socket.bind(LISTEN_PORT, LISTEN_HOST);
