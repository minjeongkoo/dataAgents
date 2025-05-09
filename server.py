#!/usr/bin/env python3
import asyncio
import math
import struct
import json
import logging
from aiohttp import web

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s %(message)s',
    datefmt='%H:%M:%S'
)

# WS 클라이언트
clients = set()
# 현재 프레임 누적용
current_frame = None
frame_points = []

def parse_compact(buffer: bytes):
    if len(buffer) < 32:
        return None
    # SOF
    if struct.unpack_from('>I', buffer, 0)[0] != 0x02020202:
        return None
    # commandId
    if struct.unpack_from('<I', buffer, 4)[0] != 1:
        return None

    offset = 32
    module_size = struct.unpack_from('<I', buffer, 28)[0]
    all_pts = []
    frame_number = None

    while module_size > 0 and offset + module_size <= len(buffer):
        m = buffer[offset:offset + module_size]
        frame_number = int.from_bytes(m[8:16], 'little')
        num_layers = struct.unpack_from('<I', m, 20)[0]
        num_beams  = struct.unpack_from('<I', m, 24)[0]
        num_echos  = struct.unpack_from('<I', m, 28)[0]
        mo = 32

        # skip Timestamp arrays
        mo += num_layers * 16

        phi = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers

        theta_start = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers
        theta_stop  = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers

        scaling     = struct.unpack_from('<f', m, mo)[0]; mo += 4
        next_module = struct.unpack_from('<I', m, mo)[0]; mo += 4
        mo += 1
        data_echos = m[mo]; mo += 1
        data_beams = m[mo]; mo += 1
        mo += 1

        echo_size       = ((data_echos & 1) * 2) + ((data_echos & 2) * 2)
        beam_prop_size  = 1 if (data_beams & 1) else 0
        beam_angle_size = 2 if (data_beams & 2) else 0
        beam_size       = echo_size * num_echos + beam_prop_size + beam_angle_size
        data_offset     = mo

        for b in range(num_beams):
            for l in range(num_layers):
                base = data_offset + (b * num_layers + l) * beam_size
                for ec in range(num_echos):
                    raw = (struct.unpack_from('<H', m, base + ec * echo_size)[0]
                           if echo_size else 0)
                    d = raw * scaling / 1000.0
                    φ = phi[l]
                    θ = theta_start[l] + b * ((theta_stop[l] - theta_start[l]) / (num_beams - 1))
                    all_pts.append({
                        'x': d * math.cos(φ) * math.cos(θ),
                        'y': d * math.cos(φ) * math.sin(θ),
                        'z': d * math.sin(φ),
                        'layer':   l,
                        'channel': ec,
                        'beamIdx': b,
                        'theta':   θ
                    })

        module_size = next_module
        offset     += len(m)

    if frame_number is None:
        return None
    return frame_number, all_pts

class LiDARProtocol(asyncio.DatagramProtocol):
    def datagram_received(self, data, addr):
        global current_frame, frame_points

        try:
            parsed = parse_compact(data)
        except Exception:
            logging.exception("parse_compact error")
            return

        if not parsed:
            return

        frame_number, pts = parsed

        if current_frame is None:
            current_frame = frame_number
            frame_points  = []

        if frame_number != current_frame:
            msg = json.dumps(frame_points)
            for ws in list(clients):
                if not ws.closed:
                    asyncio.create_task(ws.send_str(msg))
            logging.info(f"Frame {current_frame} sent, pts={len(frame_points)}")
            current_frame = frame_number
            frame_points  = []

        frame_points.extend(pts)

async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    clients.add(ws)
    logging.info("WS client connected")
    async for _ in ws:
        pass
    clients.discard(ws)
    logging.info("WS client disconnected")
    return ws

app = web.Application()
app.router.add_get('/ws', websocket_handler)
app.router.add_static('/', path='public', show_index=True)

if __name__ == '__main__':
    # 의존성 확인
    try:
        import aiohttp  # noqa
    except ImportError:
        logging.error("aiohttp가 설치되어 있지 않습니다. pip install aiohttp")
        exit(1)

    loop = asyncio.get_event_loop()
    # UDP 서버
    coro = loop.create_datagram_endpoint(
        LiDARProtocol, local_addr=('0.0.0.0', 2115)
    )
    loop.run_until_complete(coro)

    # HTTP+WS 서버
    runner = web.AppRunner(app)
    loop.run_until_complete(runner.setup())
    site = web.TCPSite(runner, '0.0.0.0', 3000)
    loop.run_until_complete(site.start())

    logging.info("HTTP ▶ http://0.0.0.0:3000")
    logging.info("📡 UDP listening on port 2115")
    loop.run_forever()
