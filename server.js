// server.js
const dgram = require('dgram');
const server = dgram.createSocket('udp4');

const PORT = 2115;

server.on('message', (msg, rinfo) => {
  console.log(`📡 ${rinfo.address}:${rinfo.port} → ${msg.length} bytes`);
  // console.log(msg.toString('hex')); // 필요시 메시지 내용 출력
});

server.on('listening', () => {
  const address = server.address();
  console.log(`✅ UDP 수신 중: ${address.address}:${address.port}`);
});

server.bind(PORT);
