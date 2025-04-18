import dgram from 'node:dgram';

const socket = dgram.createSocket('udp4');
const PORT = 2115;

socket.on('message', (msg, rinfo) => {
  console.log(`[UDP] Received from ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`);
});

socket.bind(PORT, '169.254.199.100', () => {
  console.log(`[UDP] Listening on 169.254.199.100:${PORT}`);
});
