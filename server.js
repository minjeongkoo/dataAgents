// server.js
const dgram = require('dgram');
const server = dgram.createSocket('udp4');

const PORT = 2115;
const HOST = '169.254.199.100';

server.on('listening', () => {
  const address = server.address();
  console.log(`✅ 수신 대기 중: ${address.address}:${address.port}`);
});

server.on('message', (msg, rinfo) => {
  console.log(`📡 ${rinfo.address}:${rinfo.port} → ${msg.length} bytes`);
  console.log(`📦 데이터 일부: ${msg.toString('hex').slice(0, 64)}...`);
});

server.on('error', (err) => {
  console.error(`❌ 서버 에러 발생: ${err.stack}`);
  server.close();
});

// 이 부분 중요: try/catch + 콜백 추가
try {
  server.bind(PORT, HOST, () => {
    console.log(`🔗 바인딩 성공 → ${HOST}:${PORT}`);
  });
} catch (err) {
  console.error(`❌ 바인딩 중 에러: ${err}`);
}
