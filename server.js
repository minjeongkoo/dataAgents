import dgram from 'dgram';
// UDP 소켓 생성
const socket = dgram.createSocket('udp4');

// 데이터를 수신했을 때 처리
socket.on('message', (msg, rinfo) => {
  console.log(`Received UDP message from ${rinfo.address}:${rinfo.port}`);
  console.log('Data:', msg);
});

// 에러 핸들링
socket.on('error', (err) => {
  console.error(`UDP socket error:\n${err.stack}`);
  socket.close();
});

// 192.168.0.100 IP와 포트에 바인딩
const LOCAL_PORT = 2115; // 내가 수신할 포트 (UDP 송신쪽 장비가 보내는 포트 맞춰야 함)
const LOCAL_HOST = '192.168.0.100'; // 이건 내 PC IP가 아니라, **받을 때는 0.0.0.0으로 하는 게 일반적**이야

socket.bind(LOCAL_PORT, '0.0.0.0', () => {
  console.log(`Listening for UDP packets on 0.0.0.0:${LOCAL_PORT}`);
});
