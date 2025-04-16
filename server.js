const dgram = require('dgram');
const server = dgram.createSocket('udp4');

const PORT = 2115;
const HOST = '169.254.199.100';

server.on('listening', () => {
  const address = server.address();
  console.log(`✅ 수신 대기 중: ${address.address}:${address.port}`);
});

server.on('message', (msg, rinfo) => {
  console.log(`📡 수신: ${rinfo.address}:${rinfo.port} → ${msg.length} bytes`);
  console.log(msg.toString('hex').slice(0, 64)); // 일부 출력
});

server.on('error', (err) => {
  console.error(`❌ 에러 발생: ${err}`);
});

server.bind(PORT, HOST);
