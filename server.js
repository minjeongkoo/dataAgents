import dgram from 'dgram'
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import path from 'path'
import { fileURLToPath } from 'url'

// __dirname 설정
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Compact Format 파서: Buffer → 포인트 배열
function parseCompactBuffer(buf) {
  let offset = 0

  // 헤더 (32 bytes)
  const header = {
    startOfFrame:       buf.readUInt32LE(offset),
    commandId:          buf.readUInt32LE(offset += 4),
    telegramCounter:    Number(buf.readBigUInt64LE(offset += 4)),
    timeStampTransmit:  Number(buf.readBigUInt64LE(offset += 8)),
    telegramVersion:    buf.readUInt32LE(offset += 8),
    sizeModule0:        buf.readUInt32LE(offset += 4),
  }
  offset += 4

  const modules = []
  let moduleSize = header.sizeModule0

  // 모듈 루프
  while (moduleSize > 0 && offset + moduleSize <= buf.length) {
    const modStart = offset
    const meta = {}

    // 메타데이터
    meta.SegmentCounter = Number(buf.readBigUInt64LE(offset)); offset += 8
    meta.FrameNumber    = Number(buf.readBigUInt64LE(offset)); offset += 8
    meta.SenderId       = buf.readUInt32LE(offset);            offset += 4
    meta.numberOfLines  = buf.readUInt32LE(offset);            offset += 4
    meta.beamsPerLine   = buf.readUInt32LE(offset);            offset += 4
    meta.echoesPerBeam  = buf.readUInt32LE(offset);            offset += 4

    const L = meta.numberOfLines
    meta.timeStampStart = Array.from({ length: L }, (_,i) =>
      Number(buf.readBigUInt64LE(offset + 8*i))
    )
    offset += 8 * L

    meta.timeStampStop  = Array.from({ length: L }, (_,i) =>
      Number(buf.readBigUInt64LE(offset + 8*i))
    )
    offset += 8 * L

    meta.phi = Array.from({ length: L }, (_,i) =>
      buf.readFloatLE(offset + 4*i)
    )
    offset += 4 * L

    meta.thetaStart = Array.from({ length: L }, (_,i) =>
      buf.readFloatLE(offset + 4*i)
    )
    offset += 4 * L

    meta.thetaStop = Array.from({ length: L }, (_,i) =>
      buf.readFloatLE(offset + 4*i)
    )
    offset += 4 * L

    meta.distanceScalingFactor = buf.readFloatLE(offset); offset += 4
    const nextModuleSize        = buf.readUInt32LE(offset); offset += 4

    const dataContentEchos = buf.readUInt8(offset++)
    const dataContentBeams = buf.readUInt8(offset++)
    offset++ // reserved

    // 빔 데이터 읽기
    const beams = Array.from({ length: L }, () => Array(meta.beamsPerLine).fill(null))
    for (let beamIdx = 0; beamIdx < meta.beamsPerLine; beamIdx++) {
      for (let line = 0; line < L; line++) {
        const tuple = {}
        // 에코별
        for (let echo = 0; echo < meta.echoesPerBeam; echo++) {
          if (dataContentEchos & 0x01) {
            tuple[`dist${echo}`] = buf.readUInt16LE(offset); offset += 2
          }
          if (dataContentEchos & 0x02) {
            tuple[`rssi${echo}`] = buf.readUInt16LE(offset); offset += 2
          }
        }
        // 빔별
        if (dataContentBeams & 0x01) {
          tuple.properties = buf.readUInt8(offset++)
        }
        if (dataContentBeams & 0x02) {
          const a_uint = buf.readUInt16LE(offset); offset += 2
          tuple.theta  = (a_uint - 16384) / 5215
        }
        beams[line][beamIdx] = tuple
      }
    }

    modules.push({ metadata: meta, beams, nextModuleSize })
    moduleSize = nextModuleSize
    offset    = modStart + moduleSize
  }

  // 포인트 배열(flat)
  return modules.flatMap(mod =>
    mod.beams.flatMap(line =>
      line.map(pt => {
        const d     = pt.dist0 * mod.metadata.distanceScalingFactor
        const angle = pt.theta + (mod.metadata.phi[0] || 0)
        return { x: d * Math.cos(angle), y: d * Math.sin(angle) }
      })
    )
  )
}

// UDP 소켓
const udpSocket = dgram.createSocket('udp4')
udpSocket.bind(2115)

// Express + HTTP + Socket.IO
const app        = express()
const httpServer = http.createServer(app)
const io         = new Server(httpServer, { cors: { origin: '*' } })

// 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')))
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// 클라이언트 연결
io.on('connection', socket => {
  console.log('Client connected:', socket.id)
})

// UDP 수신 시 파싱 → 전송
udpSocket.on('message', (msg, rinfo) => {
  console.log(`UDP ${rinfo.address}:${rinfo.port} ${msg.length} bytes`)
  let points = []
  try {
    points = parseCompactBuffer(msg)
  } catch (err) {
    console.error('Parsing error:', err)
    return
  }
  console.log(`Sending ${points.length} points`)
  io.emit('lidar-points', points)
})

// 서버 시작
httpServer.listen(3000, () => {
  console.log('HTTP on http://localhost:3000')
})
