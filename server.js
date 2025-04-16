// server.js
const dgram = require('dgram');
const server = dgram.createSocket('udp4');

const PORT = 2115;

server.on('listening', () => {
  const address = server.address();
  console.log(`✅ UDP 수신 대기 중: ${address.address}:${address.port}`);
});

server.on('message', (msg, rinfo) => {
  console.log(`📡 수신: ${rinfo.address}:${rinfo.port} → ${msg.length} bytes`);
  console.log(msg.toString('hex').slice(0, 64)); // 첫 64바이트를 HEX로 출력 (원시 디코딩 전)
});

server.bind(PORT);
