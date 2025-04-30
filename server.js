// server.js
import dgram from 'dgram'
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import path from 'path'
import { fileURLToPath } from 'url'

// __dirname 세팅
const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

// SICK Compact Format 파서: Buffer → [{x,y,z},…]
function parseCompactBuffer(buf) {
  let offset = 0
  // ── Header (32 bytes) ──
  const header = {
    startOfFrame:      buf.readUInt32LE(offset),
    commandId:         buf.readUInt32LE(offset += 4),
    telegramCounter:   Number(buf.readBigUInt64LE(offset += 4)),
    timeStampTransmit: Number(buf.readBigUInt64LE(offset += 8)),
    telegramVersion:   buf.readUInt32LE(offset += 8),
    sizeModule0:       buf.readUInt32LE(offset += 4),
  }
  offset += 4

  const modules = []
  let moduleSize = header.sizeModule0

  // ── 모듈 루프
  while (moduleSize > 0 && offset + moduleSize <= buf.length) {
    const modStart = offset
    const meta = {}

    // 메타데이터 읽기
    meta.SegmentCounter = Number(buf.readBigUInt64LE(offset)); offset += 8
    meta.FrameNumber    = Number(buf.readBigUInt64LE(offset)); offset += 8
    meta.SenderId       = buf.readUInt32LE(offset);            offset += 4
    meta.numberOfLines  = buf.readUInt32LE(offset);            offset += 4
    meta.beamsPerLine   = buf.readUInt32LE(offset);            offset += 4
    meta.echoesPerBeam  = buf.readUInt32LE(offset);            offset += 4

    const L = meta.numberOfLines
    // per-line arrays
    meta.timeStampStart = Array.from({ length: L }, (_,i) =>
      Number(buf.readBigUInt64LE(offset + 8*i))
    )
    offset += 8 * L
    meta.timeStampStop = Array.from({ length: L }, (_,i) =>
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

    // scaling factor & next module size
    meta.distanceScalingFactor = buf.readFloatLE(offset); offset += 4
    const nextModuleSize        = buf.readUInt32LE(offset); offset += 4

    // data-content 플래그
    const dataContentEchos = buf.readUInt8(offset++)
    const dataContentBeams = buf.readUInt8(offset++)
    offset++ // reserved

    // ── 빔 데이터 읽기
    const beams = Array.from({ length: L }, () => Array(meta.beamsPerLine))
    for (let beamIdx = 0; beamIdx < meta.beamsPerLine; beamIdx++) {
      for (let line = 0; line < L; line++) {
        const tuple = {}
        // echoes
        for (let echo = 0; echo < meta.echoesPerBeam; echo++) {
          if (dataContentEchos & 0x01) {
            tuple[`dist${echo}`] = buf.readUInt16LE(offset); offset += 2
          }
          if (dataContentEchos & 0x02) {
            tuple[`rssi${echo}`] = buf.readUInt16LE(offset); offset += 2
          }
        }
        // properties
        if (dataContentBeams & 0x01) {
          tuple.properties = buf.readUInt8(offset++)
        }
        // azimuth
        if (dataContentBeams & 0x02) {
          const a_uint = buf.readUInt16LE(offset); offset += 2
          tuple.theta  = (a_uint - 16384) / 5215
        } else {
          // direct azimuth 미제공 시 thetaStart/Stop 으로 보간
          const θ0 = meta.thetaStart[line]
          const θ1 = meta.thetaStop[line]
          tuple.theta = θ0 + beamIdx * (θ1 - θ0) / (meta.beamsPerLine - 1)
        }
        beams[line][beamIdx] = tuple
      }
    }

    modules.push({ metadata: meta, beams, nextModuleSize })
    moduleSize = nextModuleSize
    offset    = modStart + moduleSize
  }

  // ── 3D 포인트 계산
  return modules.flatMap(mod =>
    mod.beams.flatMap((line, lineIdx) =>
      line.map(pt => {
        const d      = pt.dist0 * mod.metadata.distanceScalingFactor
        const vAng   = mod.metadata.phi[lineIdx] || 0   // vertical
        const hAng   = pt.theta                         // horizontal
        const cosV   = Math.cos(vAng)
        return {
          x: d * cosV * Math.cos(hAng),
          y: d * cosV * Math.sin(hAng),
          z: d * Math.sin(vAng)
        }
      })
    )
  )
}

// ── 서버 세팅
const udpSocket = dgram.createSocket('udp4')
udpSocket.bind(2115)

const app        = express()
const httpServer = http.createServer(app)
const io         = new Server(httpServer, { cors: { origin: '*' } })

app.use(express.static(path.join(__dirname, 'public')))
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

io.on('connection', sock => {
  console.log('Client connected:', sock.id)
})

udpSocket.on('message', (msg, rinfo) => {
  console.log(`UDP ${rinfo.address}:${rinfo.port} ${msg.length} bytes`)
  let pts = []
  try {
    pts = parseCompactBuffer(msg)
    console.log(`→ parsed ${pts.length} points`)
  } catch (e) {
    console.error('parse error', e)
    return
  }
  io.emit('lidar-points', pts)
})

httpServer.listen(3000, () => {
  console.log('http://localhost:3000 running')
})
