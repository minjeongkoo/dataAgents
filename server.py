#!/usr/bin/env python3
import asyncio
import math
import struct
import json
import logging
from aiohttp import web

# ----- 설정 -----
UDP_PORT = 2115            # LiDAR 데이터 수신용 UDP 포트
HTTP_PORT = 3000           # HTTP & WS 서버 포트

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(message)s',
    datefmt='%H:%M:%S'
)

# 현재 접속된 WS 클라이언트 집합
WS_CLIENTS = set()


def parse_compact(buffer: bytes):
    """
    SICK Compact Format 한 패킷을 파싱하여
    (pts, num_layers, num_beams, num_echos) 반환.
    pts = [{'x':…, 'y':…, 'z':…, …}, …]
    """
    if len(buffer) < 32:
        return None, None, None, None
    # 프레임 헤더 확인
    if struct.unpack_from('>I', buffer, 0)[0] != 0x02020202:
        return None, None, None, None
    if struct.unpack_from('<I', buffer, 4)[0] != 1:
        return None, None, None, None

    offset = 32
    all_pts = []
    num_layers = num_beams = num_echos = None

    # 여러 모듈이 연속될 수 있음
    while True:
        # 모듈 크기
        module_size = struct.unpack_from('<I', buffer, 28)[0] if offset == 32 else next_module
        if module_size <= 0 or offset + module_size > len(buffer):
            break
        m = buffer[offset: offset + module_size]

        # 메타데이터 추출
        num_layers = struct.unpack_from('<I', m, 20)[0]
        num_beams  = struct.unpack_from('<I', m, 24)[0]
        num_echos  = struct.unpack_from('<I', m, 28)[0]

        # 배열 위치 오프셋
        mo = 32
        # 타임스탬프(각 레이어) 건너뛰기
        mo += num_layers * 16

        # Phi (elevation)
        phi = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers

        # ThetaStart / ThetaStop
        theta_start = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers
        theta_stop  = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers

        # Scaling factor
        scaling = struct.unpack_from('<f', m, mo)[0]; mo += 4
        # 다음 모듈 크기
        next_module = struct.unpack_from('<I', m, mo)[0]; mo += 4

        # Flags
        mo += 1  # reserved
        data_echos = m[mo]; mo += 1
        data_beams = m[mo]; mo += 1
        mo += 1  # reserved

        # 각 빔 요소 크기
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
                    x = d * math.cos(φ) * math.cos(θ)
                    y = d * math.cos(φ) * math.sin(θ)
                    z = d * math.sin(φ)
                    all_pts.append({'x': x, 'y': y, 'z': z})

        offset += module_size

    if num_layers is None or not all_pts:
        return None, None, None, None

    return all_pts, num_layers, num_beams, num_echos


class LiDARProtocol(asyncio.DatagramProtocol):
    """한 프레임(360°)에 해당하는 포인트가 충분히 쌓이면 WS로 전송"""

    def __init__(self):
        self.scan_buffer     = []
        self.expected_points = None

    def datagram_received(self, data, addr):
        pts, nl, nb, ne = parse_compact(data)
        if not pts:
            return

        # 첫 패킷에서 한 프레임 크기 자동 계산
        if self.expected_points is None:
            self.expected_points = nl * nb * ne
            logging.info(f"Expected frame size ▶ {self.expected_points} points "
                         f"({nl}×{nb}×{ne})")

        # 버퍼에 누적
        self.scan_buffer.extend(pts)

        # 한 프레임분이 쌓였으면 전송
        while len(self.scan_buffer) >= self.expected_points:
            frame = self.scan_buffer[:self.expected_points]
            msg   = json.dumps(frame)
            for ws in list(WS_CLIENTS):
                if not ws.closed:
                    asyncio.create_task(ws.send_str(msg))
            logging.info(f"Sent frame ▶ {len(frame)} points")
            del self.scan_buffer[:self.expected_points]


async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    WS_CLIENTS.add(ws)
    logging.info(f'WS connected ▶ {request.remote}')
    try:
        async for _ in ws:
            pass
    finally:
        WS_CLIENTS.remove(ws)
        logging.info(f'WS disconnected ▶ {request.remote}')
    return ws


async def init_app():
    app = web.Application()
    app.router.add_get('/ws', websocket_handler)
    app.router.add_static('/', path='public', show_index=True)
    return app


async def main():
    loop = asyncio.get_running_loop()
    # UDP 리스너
    await loop.create_datagram_endpoint(
        lambda: LiDARProtocol(),
        local_addr=('0.0.0.0', UDP_PORT)
    )

    # HTTP + WS 서버
    app = await init_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site   = web.TCPSite(runner, '0.0.0.0', HTTP_PORT)
    await site.start()

    logging.info(f'HTTP + WS 서비스 ▶ http://0.0.0.0:{HTTP_PORT}')
    await asyncio.Future()  # 무한 대기


if __name__ == '__main__':
    asyncio.run(main())
