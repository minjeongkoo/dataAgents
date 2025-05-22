#!/usr/bin/env python3
import asyncio
import math
import struct
import json
import logging
from aiohttp import web
import os

# —— 설정 —— #
UDP_PORT  = 2115
HTTP_PORT = 3000

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(message)s',
    datefmt='%H:%M:%S'
)

# WebSocket 클라이언트들
clients = set()
# UDP raw 데이터 큐
udp_queue = asyncio.Queue()
# 마지막 완성된 프레임
latest_frame = []

def parse_compact(buffer: bytes):
    """SICK Compact format 파싱 (0,0,0 포인트는 버림)"""
    if len(buffer) < 32: return None
    if struct.unpack_from('>I', buffer, 0)[0] != 0x02020202: return None
    if struct.unpack_from('<I', buffer, 4)[0] != 1:      return None

    offset      = 32
    module_size = struct.unpack_from('<I', buffer, 28)[0]
    pts = []
    frame_num = None

    while module_size > 0 and offset + module_size <= len(buffer):
        m = buffer[offset:offset + module_size]

        # FrameNumber
        frame_num = int.from_bytes(m[8:16], 'little')
        num_layers = struct.unpack_from('<I', m, 20)[0]
        num_beams  = struct.unpack_from('<I', m, 24)[0]
        num_echos  = struct.unpack_from('<I', m, 28)[0]

        # 메타데이터 스킵
        mo = 32 + num_layers*16

        # Phi
        phi = [struct.unpack_from('<f', m, mo+4*i)[0] for i in range(num_layers)]
        mo += 4*num_layers
        # ThetaStart/Stop
        theta_start = [struct.unpack_from('<f', m, mo+4*i)[0] for i in range(num_layers)]
        mo += 4*num_layers
        theta_stop  = [struct.unpack_from('<f', m, mo+4*i)[0] for i in range(num_layers)]
        mo += 4*num_layers

        # scaling, next_module
        scaling     = struct.unpack_from('<f', m, mo)[0]; mo += 4
        next_module = struct.unpack_from('<I', m, mo)[0]; mo += 4

        # flags
        mo += 1
        data_echos  = m[mo]; mo += 1
        data_beams  = m[mo]; mo += 2

        # beam byte 크기
        echo_size       = (2 if data_echos & 1 else 0) + (2 if data_echos & 2 else 0)
        beam_prop_size  = 1 if data_beams & 1 else 0
        beam_angle_size = 2 if data_beams & 2 else 0
        beam_size       = echo_size*num_echos + beam_prop_size + beam_angle_size
        data_offset     = mo

        # 포인트 생성
        for b in range(num_beams):
            for l in range(num_layers):
                base = data_offset + (b*num_layers + l)*beam_size
                for ec in range(num_echos):
                    idx = base + ec*echo_size
                    if echo_size and idx+echo_size>len(m): continue
                    raw = struct.unpack_from('<H', m, idx)[0] if echo_size else 0
                    d   = raw * scaling / 1000.0
                    φ   = phi[l]
                    θ   = theta_start[l] + b * ((theta_stop[l] - theta_start[l]) / max(1, num_beams-1))
                    x = d*math.cos(φ)*math.cos(θ)
                    y = d*math.cos(φ)*math.sin(θ)
                    z = d*math.sin(φ)
                    if x==0 and y==0 and z==0:  # 0,0,0 포인트 제거
                        continue
                    pts.append({'x':x,'y':y,'z':z,'layer':l,'theta':θ})

        offset      += module_size
        module_size = next_module

    if frame_num is None:
        return None
    return frame_num, pts

class FrameAccumulator:
    """FrameNumber 바뀔 때까지 누적, 바뀌면 이전 프레임 pts 반환"""
    def __init__(self):
        self.last_frame = None
        self.accum_pts  = []

    def add(self, frame_num, pts):
        if self.last_frame is None:
            self.last_frame = frame_num
        if frame_num != self.last_frame:
            completed = self.accum_pts
            self.accum_pts = pts.copy()
            self.last_frame = frame_num
            return completed
        else:
            self.accum_pts.extend(pts)
            return None

class UDPProtocol(asyncio.DatagramProtocol):
    """수신된 UDP 메시지는 바로 큐에 넣기만"""
    def datagram_received(self, data, addr):
        udp_queue.put_nowait(data)

async def consume_udp():
    """UDP 큐에서 꺼내 파싱 + 누적 + full-frame 완성 시 WebSocket broadcast"""
    global latest_frame
    accum = FrameAccumulator()
    while True:
        data = await udp_queue.get()
        parsed = parse_compact(data)
        if not parsed:
            continue
        frame_num, pts = parsed
        done = accum.add(frame_num, pts)
        if done is not None:
            latest_frame = done
            msg = json.dumps(latest_frame)
            for ws in list(clients):
                if not ws.closed:
                    asyncio.create_task(ws.send_str(msg))
            logging.info(f"✅ Full frame {frame_num} sent, {len(done)} pts")

async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    clients.add(ws)
    logging.info("🟢 WS connected")
    async for _ in ws:
        pass
    clients.discard(ws)
    logging.info("🔴 WS disconnected")
    return ws

async def get_latest(request):
    if latest_frame:
        return web.json_response(latest_frame)
    raise web.HTTPNoContent()

def main():
    # public 폴더 체크
    if not os.path.isdir('public'):
        os.mkdir('public')
        logging.info("📁 public/ 폴더 생성 후 index.html을 넣어주세요.")

    loop = asyncio.get_event_loop()
    # 1) UDP 리스너
    loop.run_until_complete(
        loop.create_datagram_endpoint(
            lambda: UDPProtocol(),
            local_addr=('0.0.0.0', UDP_PORT)
        )
    )
    loop.create_task(consume_udp())

    # 2) HTTP + WebSocket 서버
    app = web.Application()
    app.router.add_get('/ws', websocket_handler)
    app.router.add_get('/latest', get_latest)
    app.router.add_static('/', path='./public', show_index=True)

    runner = web.AppRunner(app)
    loop.run_until_complete(runner.setup())
    loop.run_until_complete(web.TCPSite(runner, '0.0.0.0', HTTP_PORT).start())

    logging.info(f"📡 UDP listening on {UDP_PORT}")
    logging.info(f"🌐 HTTP ▶ http://0.0.0.0:{HTTP_PORT}/")
    loop.run_forever()

if __name__ == '__main__':
    main()
