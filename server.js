// server.js
const dgram = require('dgram');
const server = dgram.createSocket('udp4');

const PORT = 2115;

server.on('error', (err) => {
  console.error(`UDP 서버 오류: ${err}`);
  server.close();
});

server.on('message', (msg, rinfo) => {
  console.log(`📡 ${rinfo.address}:${rinfo.port}로부터 ${msg.length}바이트 수신`);
  // Compact 포맷 디코딩은 여기서 추가
  // 예: console.log(msg.toString('hex'));
});

server.on('listening', () => {
  const address = server.address();
  console.log(`✅ UDP 서버 대기 중: ${address.address}:${address.port}`);
});

server.bind(PORT); // SOPAS에서 지정한 포트
