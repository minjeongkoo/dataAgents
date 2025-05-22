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
    last_module = False

    while module_size > 0 and offset + module_size <= len(buffer):
        m = buffer[offset:offset+module_size]
        num_layers = struct.unpack_from('<I', m, 20)[0]
        num_beams  = struct.unpack_from('<I', m, 24)[0]
        num_echos  = struct.unpack_from('<I', m, 28)[0]

        mo = 32 + num_layers*16  # TimestampStart/Stop 건너뛰기

        phi         = [struct.unpack_from('<f', m, mo+4*i)[0] for i in range(num_layers)]
        mo         += 4 * num_layers
        theta_start = [struct.unpack_from('<f', m, mo+4*i)[0] for i in range(num_layers)]
        mo         += 4 * num_layers
        theta_stop  = [struct.unpack_from('<f', m, mo+4*i)[0] for i in range(num_layers)]
        mo         += 4 * num_layers

        scaling     = struct.unpack_from('<f', m, mo)[0]; mo += 4
        next_module = struct.unpack_from('<I', m, mo)[0]; mo += 4
        last_module = (next_module == 0)

        mo += 1
        data_echos  = m[mo]; mo += 1
        data_beams  = m[mo]; mo += 2

        echo_size       = (2 if data_echos & 1 else 0) + (2 if data_echos & 2 else 0)
        beam_prop_size  = 1 if data_beams & 1 else 0
        beam_angle_size = 2 if data_beams & 2 else 0
        beam_size       = echo_size*num_echos + beam_prop_size + beam_angle_size
        data_offset     = mo

        for b in range(num_beams):
            for l in range(num_layers):
                base = data_offset + (b*num_layers + l)*beam_size
                for ec in range(num_echos):
                    idx = base + ec*echo_size
                    if echo_size and idx+echo_size > len(m): continue
                    raw = struct.unpack_from('<H', m, idx)[0] if echo_size else 0
                    dist = raw * scaling / 1000.0
                    φ = phi[l]
                    θ = theta_start[l] + b * ((theta_stop[l] - theta_start[l]) / max(1, num_beams-1))
                    x = dist*math.cos(φ)*math.cos(θ)
                    y = dist*math.cos(φ)*math.sin(θ)
                    z = dist*math.sin(φ)
                    if x==0 and y==0 and z==0: continue  # (0,0,0) 제거
                    pts.append({'x': x, 'y': y, 'z': z, 'layer': l})
        offset += module_size
        module_size = next_module

    return pts, last_module


class FrameProtocol(asyncio.DatagramProtocol):
    def __init__(self):
        self.accum = []

    def datagram_received(self, data, addr):
        parsed = parse_compact(data)
        if not parsed: return
        pts, is_last = parsed

        self.accum.extend(pts)

        if is_last:
            global latest_frame
            latest_frame = list(self.accum)
            logging.info(f"frame ready ({len(latest_frame)} points)")
            self.accum.clear()


async def get_latest(request):
    if latest_frame:
        return web.json_response(latest_frame)
    else:
        raise web.HTTPNoContent()


def main():
    # public 폴더가 없으면 생성
    if not os.path.isdir('public'):
        os.mkdir('public')
        logging.info("📁 Created 'public' directory; please put index.html inside it.")

    # 이벤트 루프에 UDP 프로토콜 등록
    loop = asyncio.get_event_loop()
    loop.run_until_complete(
        loop.create_datagram_endpoint(lambda: FrameProtocol(),
                                      local_addr=('0.0.0.0', UDP_PORT))
    )

    # HTTP 서버 설정
    app = web.Application()
    app.router.add_get('/latest', get_latest)
    # 정적 파일 서빙: public/index.html 등을 제공
    app.router.add_static('/', path='./public', show_index=True)

    runner = web.AppRunner(app)
    loop.run_until_complete(runner.setup())
    loop.run_until_complete(web.TCPSite(runner, '0.0.0.0', HTTP_PORT).start())

    logging.info(f"📡 UDP listening on {UDP_PORT}")
    logging.info(f"🌐 HTTP ▶ http://0.0.0.0:{HTTP_PORT}/")
    loop.run_forever()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    main()
