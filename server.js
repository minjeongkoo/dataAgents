// server.js
import dgram from 'dgram'

const UDP_PORT = 2115
const LISTEN_ADDR = '0.0.0.0'  // 모든 인터페이스에서 수신

const socket = dgram.createSocket('udp4')

socket.on('listening', () => {
  const addr = socket.address()
  console.log(`Listening on ${addr.address}:${addr.port}`)
})

socket.on('message', (msg, rinfo) => {
  const ts = new Date().toISOString()
  // 수신 정보 + 패킷 크기
  console.log(`[${ts}] Received ${msg.length} bytes from ${rinfo.address}:${rinfo.port}`)
  // 바이너리 데이터를 16진수로 출력 (원하면 toString() 으로 문자열 출력 가능)
  console.log(msg.toString('hex'))
})

socket.on('error', (err) => {
  console.error('UDP socket error:', err)
  socket.close()
})

socket.bind(UDP_PORT, LISTEN_ADDR)
