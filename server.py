#!/usr/bin/env python3
import asyncio
import math
import struct
import json
import logging
from aiohttp import web
from sklearn.cluster import DBSCAN
import numpy as np

# 설정
UDP_PORT     = 2115
HTTP_PORT    = 3000
TOTAL_LAYERS = 16

latest_fullframe = None  # 가장 최근 fullframe JSON 저장

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(message)s',
    datefmt='%H:%M:%S'
)

def parse_compact(buffer: bytes):
    if len(buffer) < 32:
        return None
    if struct.unpack_from('>I', buffer, 0)[0] != 0x02020202:
        return None
    if struct.unpack_from('<I', buffer, 4)[0] != 1:
        return None

    offset = 32
    module_size = struct.unpack_from('<I', buffer, 28)[0]
    all_pts = []
    frame_number = None
    last_module = False

    while module_size > 0 and offset + module_size <= len(buffer):
        m = buffer[offset : offset + module_size]

        frame_number = int.from_bytes(m[8:16], 'little')
        num_layers   = struct.unpack_from('<I', m, 20)[0]
        num_beams    = struct.unpack_from('<I', m, 24)[0]
        num_echos    = struct.unpack_from('<I', m, 28)[0]
        mo = 32
        mo += num_layers * 16  # TimestampStart/Stop 생략

        phi         = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo         += 4 * num_layers
        theta_start = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo         += 4 * num_layers
        theta_stop  = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo         += 4 * num_layers

        scaling     = struct.unpack_from('<f', m, mo)[0]; mo += 4
        next_module = struct.unpack_from('<I', m, mo)[0]; mo += 4
        last_module = (next_module == 0)

        mo += 1
        data_echos  = m[mo]; mo += 1
        data_beams  = m[mo]; mo += 1
        mo += 1

        echo_size       = (2 if (data_echos & 1) else 0) + (2 if (data_echos & 2) else 0)
        beam_prop_size  = 1 if (data_beams & 1) else 0
        beam_angle_size = 2 if (data_beams & 2) else 0
        beam_size       = echo_size * num_echos + beam_prop_size + beam_angle_size
        data_offset     = mo

        for b in range(num_beams):
            for l in range(num_layers):
                base = data_offset + (b * num_layers + l) * beam_size
                for ec in range(num_echos):
                    idx = base + ec * echo_size
                    if echo_size > 0 and idx + echo_size > len(m):
                        continue
                    raw = struct.unpack_from('<H', m, idx)[0] if echo_size else 0
                    d   = raw * scaling / 1000.0
                    φ   = phi[l]
                    θ   = theta_start[l] + b * ((theta_stop[l] - theta_start[l]) / max(1, num_beams - 1))
                    all_pts.append({
                        'x': d * math.cos(φ) * math.cos(θ),
                        'y': d * math.cos(φ) * math.sin(θ),
                        'z': d * math.sin(φ),
                        'layer': l,
                        'channel': ec,
                        'beamIdx': b,
                        'theta': θ
                    })

        offset      += module_size
        module_size  = next_module

    return frame_number, all_pts, last_module

def clusterize(points):
    coords = np.array([[p['x'], p['y'], p['z']] for p in points])
    if len(coords) == 0:
        return points
    db = DBSCAN(eps=0.3, min_samples=10).fit(coords)
    labels = db.labels_
    for i, label in enumerate(labels):
        points[i]['cluster_id'] = int(label)
    return points

class FrameProtocol(asyncio.DatagramProtocol):
    def __init__(self):
        self.frame = None
        self.accum = []

    def datagram_received(self, data, addr):
        parsed = parse_compact(data)
        if not parsed:
            return
        frame_num, pts, is_last = parsed

        if self.frame is None:
            self.frame = frame_num

        if frame_num == self.frame:
            self.accum.extend(pts)
            if is_last:
                clustered = clusterize(self.accum)
                global latest_fullframe
                latest_fullframe = json.dumps(clustered)  # 메모리에 저장
                logging.info(f"✅ Full 360° scan frame {self.frame} saved ({len(clustered)} pts)")
                self.frame = None
                self.accum.clear()
        else:
            logging.warning(f"⚠️ Frame mismatch: {frame_num} ≠ {self.frame}, discarding")
            self.frame = frame_num
            self.accum = list(pts)

async def get_latest_scan(request):
    global latest_fullframe
    if latest_fullframe:
        return web.Response(text=latest_fullframe, content_type='application/json')
    else:
        return web.Response(status=204, text='No data yet')

def main():
    import os
    if not os.path.isdir("public"):
        os.mkdir("public")
    app = web.Application()
    app.router.add_get('/scan', get_latest_scan)
    app.router.add_static('/', path='public', show_index=True)

    loop = asyncio.get_event_loop()
    listen = loop.create_datagram_endpoint(lambda: FrameProtocol(), local_addr=('0.0.0.0', UDP_PORT))
    loop.run_until_complete(listen)

    runner = web.AppRunner(app)
    loop.run_until_complete(runner.setup())
    loop.run_until_complete(web.TCPSite(runner, '0.0.0.0', HTTP_PORT).start())

    logging.info(f"🌐 http://0.0.0.0:{HTTP_PORT}")
    logging.info(f"📡 UDP listening on {UDP_PORT}")
    loop.run_forever()

if __name__ == '__main__':
    main()
