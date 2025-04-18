// udp-listener.js
const dgram = require('dgram');
const socket = dgram.createSocket('udp4');

const PORT = 2115;

socket.on('message', (msg, rinfo) => {
  console.log(`[UDP] Received from ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`);
});

socket.bind(PORT, () => {
  console.log(`[UDP] Listening on port ${PORT}`);
});
