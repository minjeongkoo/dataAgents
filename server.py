#!/usr/bin/env python3
import asyncio
import math
import struct
import json
import logging
from aiohttp import web
import os

# 설정
UDP_PORT  = 2115
HTTP_PORT = 3000

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(message)s',
    datefmt='%H:%M:%S'
)

# 마지막으로 완성된 full-frame 데이터를 저장
latest_frame = []

def parse_compact(buffer: bytes):
    if len(buffer) < 32: return None
    if struct.unpack_from('>I', buffer, 0)[0] != 0x02020202: return None
    if struct.unpack_from('<I', buffer, 4)[0] != 1: return None

    offset = 32
    module_size = struct.unpack_from('<I', buffer, 28)[0]
    pts = []
    frame_num = None

    while module_size > 0 and offset + module_size <= len(buffer):
        m = buffer[offset:offset + module_size]

        # FrameNumber(8..16), SegmentCounter(0..8) 중 프레임 구분에는 FrameNumber 사용
        frame_num = int.from_bytes(m[8:16], 'little')

        num_layers = struct.unpack_from('<I', m, 20)[0]
        num_beams  = struct.unpack_from('<I', m, 24)[0]
        num_echos  = struct.unpack_from('<I', m, 28)[0]

        # metadata 건너뛰기
        mo = 32 + num_layers*16

        # Phi
        phi = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4*num_layers
        # ThetaStart / ThetaStop
        theta_start = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4*num_layers
        theta_stop  = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4*num_layers

        # Scaling, next_module
        scaling     = struct.unpack_from('<f', m, mo)[0]; mo += 4
        next_module = struct.unpack_from('<I', m, mo)[0]; mo += 4

        # flags
        mo += 1
        data_echos  = m[mo]; mo += 1
        data_beams  = m[mo]; mo += 2

        # beam byte 크기 계산
        echo_size       = (2 if data_echos & 1 else 0) + (2 if data_echos & 2 else 0)
        beam_prop_size  = 1 if data_beams & 1 else 0
        beam_angle_size = 2 if data_beams & 2 else 0
        beam_size       = echo_size*num_echos + beam_prop_size + beam_angle_size
        data_offset     = mo

        # point 생성
        for b in range(num_beams):
            for l in range(num_layers):
                base = data_offset + (b*num_layers + l)*beam_size
                for ec in range(num_echos):
                    idx = base + ec*echo_size
                    if echo_size and idx+echo_size > len(m): continue
                    raw = struct.unpack_from('<H', m, idx)[0] if echo_size else 0
                    d   = raw * scaling / 1000.0
                    φ   = phi[l]
                    θ   = theta_start[l] + b*((theta_stop[l] - theta_start[l]) / max(1, num_beams-1))
                    x = d*math.cos(φ)*math.cos(θ)
                    y = d*math.cos(φ)*math.sin(θ)
                    z = d*math.sin(φ)
                    # (0,0,0) 포인트 제거
                    if x==0 and y==0 and z==0: continue
                    pts.append({'x':x,'y':y,'z':z,'layer':l,'theta':θ})

        offset += module_size
        module_size = next_module

    if frame_num is None:
        return None
    return frame_num, pts


class FrameProtocol(asyncio.DatagramProtocol):
    """FrameNumber 변화 시 전체 360° 스캔 데이터 전송"""
    def __init__(self):
        self.last_frame = None
        self.accum_pts  = []

    def datagram_received(self, data, addr):
        parsed = parse_compact(data)
        if not parsed: return
        frame_num, pts = parsed

        if self.last_frame is None:
            self.last_frame = frame_num

        # FrameNumber가 바뀌면 이전 한 바퀴 데이터 전송
        if frame_num != self.last_frame:
            global latest_frame
            latest_frame = list(self.accum_pts)
            logging.info(f"✅ Full frame {self.last_frame} → {len(latest_frame)} pts")
            self.accum_pts  = []
            self.last_frame = frame_num

        self.accum_pts.extend(pts)


async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    logging.info("🟢 WebSocket connected")
    try:
        async for _ in ws:
            pass
    finally:
        logging.info("🔴 WebSocket disconnected")
    return ws


async def get_latest(request):
    if latest_frame:
        return web.json_response(latest_frame)
    else:
        raise web.HTTPNoContent()


def main():
    # public 폴더 확인
    if not os.path.isdir('public'):
        os.mkdir('public')
        logging.info("📁 ‘public’ 폴더를 생성했습니다. index.html 을 그 안에 넣어주세요.")

    # UDP 리스너
    loop = asyncio.get_event_loop()
    loop.run_until_complete(
        loop.create_datagram_endpoint(
            lambda: FrameProtocol(),
            local_addr=('0.0.0.0', UDP_PORT))
    )

    # HTTP 서버
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
