import dgram from 'dgram'
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import path from 'path'
import { fileURLToPath } from 'url'

// __dirname 설정
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// UDP 리스너
const udpSocket = dgram.createSocket('udp4')
udpSocket.bind(2115)

// Express + HTTP + WebSocket
const app = express()
const httpServer = http.createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

// 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')))
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// 클라이언트 연결
io.on('connection', socket => {
  console.log('Client connected:', socket.id)
})

// UDP 메시지 수신 → 파싱 → WebSocket 전송
udpSocket.on('message', (msg, rinfo) => {
  console.log(`UDP ${rinfo.address}:${rinfo.port} ${msg.length} bytes`)
  const points = parseCompactFormat(msg)
  console.log(`Sending ${points.length} points`)
  io.emit('lidar-points', points)
})

// 서버 시작
httpServer.listen(3000, () => {
  console.log('HTTP on http://localhost:3000')
})

// Compact Format 파서
function parseCompactFormat(buf) {
  let o = 0
  // 프레임 시작 검사
  if (buf.readUInt32BE(o) !== 0x02020202) return []
  o += 4 + 4 + 8 + 8 + 4 + 4 + 8 + 8 + 4

  // 모듈 메타데이터
  const nL = buf.readUInt32LE(o); o += 4
  const nB = buf.readUInt32LE(o); o += 4
  o += 4 + nL * 8 * 2

  // 각 라인별 elevation
  const phi = []
  for (let i = 0; i < nL; i++) {
    phi.push(buf.readFloatLE(o)); o += 4
  }
  o += nL * 4 * 2

  // 거리 스케일
  const scale = buf.readFloatLE(o); o += 4
  o += 4 + 1
  const ech = buf.readUInt8(o); o += 1
  const bm  = buf.readUInt8(o); o += 1
  o += 1

  const hasD = !!(ech & 1), hasR = !!(ech & 2)
  const hasP = !!(bm  & 1), hasT = !!(bm  & 2)
  const pts = []

  // 데이터 파싱
  for (let l = 0; l < nL; l++) {
    const p = phi[l]
    for (let b = 0; b < nB; b++) {
      let d = 0
      if (hasD) { d = buf.readUInt16LE(o) * scale; o += 2 }
      if (hasR) o += 2
      if (hasP) o += 1
      let t = 0
      if (hasT) { t = (buf.readUInt16LE(o) - 16384) / 5215; o += 2 }

      // Polar→Cartesian
      const x = d * Math.cos(p) * Math.cos(t)
      const y = d * Math.cos(p) * Math.sin(t)
      const z = d * Math.sin(p)

      if (d > 100 && d < 120000) pts.push({ x, y, z })
    }
  }
  return pts
}
