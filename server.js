const dgram = require('dgram');
const { spawn } = require('child_process');

const udp = dgram.createSocket('udp4');
const PORT = 2115;
const HOST = '169.254.199.100';

const python = spawn('python', ['parser.py']);
python.stdout.on('data', data => {
  console.log(`Python 응답: ${data.toString().trim()}`);
});

python.stderr.on('data', err => {
  console.error(`Python 오류: ${err}`);
});

udp.on('listening', () => {
  const addr = udp.address();
  console.log(`수신 대기 중: ${addr.address}:${addr.port}`);
});

udp.on('message', msg => {
  const hex = msg.toString('hex');
  python.stdin.write(hex + '\n');
});

udp.bind(PORT, HOST);
