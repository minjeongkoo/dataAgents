#!/usr/bin/env python3
import asyncio
import math
import struct
import json
import logging
from aiohttp import web

# 설정
USE_LAYER_BASED = False   # False: FrameNumber 기준, True: 레이어별 θ 커버리지 기준
TOTAL_LAYERS    = 16      # 센서 레이어 수에 맞게 조정
UDP_PORT        = 2115
HTTP_PORT       = 3000

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s %(message)s',
    datefmt='%H:%M:%S'
)

clients = set()

def parse_compact(buffer: bytes):
    if len(buffer) < 32:
        return None
    if struct.unpack_from('>I', buffer, 0)[0] != 0x02020202:
        return None
    if struct.unpack_from('<I', buffer, 4)[0] != 1:
        return None

    offset      = 32
    module_size = struct.unpack_from('<I', buffer, 28)[0]
    all_pts     = []
    frame_number= None

    while module_size > 0 and offset + module_size <= len(buffer):
        m = buffer[offset : offset + module_size]

        frame_number = int.from_bytes(m[8:16], 'little')
        num_layers   = struct.unpack_from('<I', m, 20)[0]
        num_beams    = struct.unpack_from('<I', m, 24)[0]
        num_echos    = struct.unpack_from('<I', m, 28)[0]
        mo = 32

        # Timestamp 배열 건너뛰기
        mo += num_layers * 16

        # Phi 배열
        phi = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers

        # ThetaStart / ThetaStop
        theta_start = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers
        theta_stop  = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers

        # Scaling factor
        scaling = struct.unpack_from('<f', m, mo)[0]; mo += 4

        # NextModuleSize
        next_module = struct.unpack_from('<I', m, mo)[0]; mo += 4

        # Flags
        mo += 1  # reserved
        data_echos = m[mo]; mo += 1
        data_beams = m[mo]; mo += 1
        mo += 1  # reserved

        # 크기 계산
        echo_size       = (2 if (data_echos & 1) else 0) + (2 if (data_echos & 2) else 0)
        beam_prop_size  = 1 if (data_beams & 1) else 0
        beam_angle_size = 2 if (data_beams & 2) else 0
        beam_size       = echo_size * num_echos + beam_prop_size + beam_angle_size
        data_offset     = mo

        # 포인트 파싱
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
                        'layer':   l,
                        'channel': ec,
                        'beamIdx': b,
                        'theta':   θ
                    })

        offset      += module_size
        module_size = next_module

    if frame_number is None:
        return None
    return frame_number, all_pts


class FrameProtocol(asyncio.DatagramProtocol):
    """FrameNumber 변화 시 전체 360° 스캔 데이터 전송"""
    def __init__(self):
        self.last_frame = None
        self.accum_pts  = []

    def datagram_received(self, data, addr):
        parsed = parse_compact(data)
        if not parsed:
            return
        frame_num, pts = parsed

        if self.last_frame is None:
            self.last_frame = frame_num

        # FrameNumber가 바뀌면 이전 한 바퀴 데이터 전송
        if frame_num != self.last_frame:
            msg = json.dumps(self.accum_pts)
            for ws in list(clients):
                if not ws.closed:
                    asyncio.create_task(ws.send_str(msg))
            logging.info(f"Sent frame {self.last_frame} ({len(self.accum_pts)} pts)")
            self.accum_pts  = []
            self.last_frame = frame_num

        self.accum_pts.extend(pts)


class LayerProtocol(asyncio.DatagramProtocol):
    """각 레이어 θ 범위(0~2π) 커버 시마다 데이터 전송"""
    def __init__(self, total_layers):
        self.total_layers = total_layers
        self.layer_pts    = {l: [] for l in range(total_layers)}
        self.min_theta    = {l: math.inf for l in range(total_layers)}
        self.max_theta    = {l: -math.inf for l in range(total_layers)}

    def datagram_received(self, data, addr):
        parsed = parse_compact(data)
        if not parsed:
            return
        _, pts = parsed

        # 레이어별 업데이트
        for p in pts:
            l = p['layer']; θ = p['theta']
            self.layer_pts[l].append(p)
            self.min_theta[l] = min(self.min_theta[l], θ)
            self.max_theta[l] = max(self.max_theta[l], θ)

        # 모든 레이어가 360° 커버했는지 확인
        done = all((self.max_theta[l] - self.min_theta[l]) >= 2 * math.pi
                   for l in range(self.total_layers))
        if not done:
            return

        # 완전 스캔 데이터 전송
        full_scan = []
        for l in range(self.total_layers):
            full_scan.extend(self.layer_pts[l])
        msg = json.dumps(full_scan)
        for ws in list(clients):
            if not ws.closed:
                asyncio.create_task(ws.send_str(msg))
        logging.info(f"Sent layer-based full scan ({len(full_scan)} pts)")

        # 초기화
        for l in range(self.total_layers):
            self.layer_pts[l].clear()
            self.min_theta[l] = math.inf
            self.max_theta[l] = -math.inf


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
    try:
        import aiohttp  # noqa
    except ImportError:
        logging.error("aiohttp not installed. Run: pip install aiohttp")
        exit(1)

    loop = asyncio.get_event_loop()

    proto = LayerProtocol(TOTAL_LAYERS) if USE_LAYER_BASED else FrameProtocol()
    listen = loop.create_datagram_endpoint(lambda: proto, local_addr=('0.0.0.0', UDP_PORT))
    loop.run_until_complete(listen)

    runner = web.AppRunner(app)
    loop.run_until_complete(runner.setup())
    site   = web.TCPSite(runner, '0.0.0.0', HTTP_PORT)
    loop.run_until_complete(site.start())

    logging.info(f"HTTP ▶ http://0.0.0.0:{HTTP_PORT}")
    logging.info(f"📡 UDP listening on port {UDP_PORT}")
    loop.run_forever()
