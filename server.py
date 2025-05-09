#!/usr/bin/env python3
import asyncio
import json
import math
import os
import struct
from aiohttp import web

# Configuration
UDP_PORT = 2115    # LiDAR 데이터 수신용 UDP 포트
HTTP_PORT = 3000   # 웹 서버용 HTTP 포트

# Globals for frame assembly
current_frame = None
frame_points = []
clients = set()    # Set of active WebSocketResponse objects

def parse_compact(buffer: bytes):
    """
    Compact Format 파서 (JS parseCompact → Python)
    Returns (frame_number, [pts...]) or None if packet invalid.
    """
    if len(buffer) < 32:
        return None
    # SOF 확인 (big-endian)
    if struct.unpack(">I", buffer[0:4])[0] != 0x02020202:
        return None
    # commandId 확인 (little-endian)
    if struct.unpack("<I", buffer[4:8])[0] != 1:
        return None

    offset = 32
    module_size = struct.unpack("<I", buffer[28:32])[0]
    all_pts = []
    frame_number = None

    while module_size > 0 and offset + module_size <= len(buffer):
        m = buffer[offset:offset + module_size]

        # Meta
        frame_number = struct.unpack("<Q", m[8:16])[0]
        num_layers = struct.unpack("<I", m[20:24])[0]
        num_beams  = struct.unpack("<I", m[24:28])[0]
        num_echos  = struct.unpack("<I", m[28:32])[0]

        mo = 32
        # skip TimestampStart/Stop
        mo += num_layers * 16

        # Phi 배열
        phi_fmt = f"<{num_layers}f"
        phi_array = list(struct.unpack_from(phi_fmt, m, mo))
        mo += 4 * num_layers

        # ThetaStart 배열
        theta_start = list(struct.unpack_from(phi_fmt, m, mo))
        mo += 4 * num_layers

        # ThetaStop 배열
        theta_stop  = list(struct.unpack_from(phi_fmt, m, mo))
        mo += 4 * num_layers

        # scalingFactor
        scaling = struct.unpack_from("<f", m, mo)[0]
        mo += 4

        # nextModuleSize
        next_module_size = struct.unpack_from("<I", m, mo)[0]
        mo += 4

        # reserved, DataContentEchos, DataContentBeams, reserved
        mo += 1
        data_content_echos = m[mo]; mo += 1
        data_content_beams = m[mo]; mo += 1
        mo += 1

        # compute sizes
        echo_size      = (2 if (data_content_echos & 1) else 0) + (2 if (data_content_echos & 2) else 0)
        beam_prop_size = 1 if (data_content_beams & 1) else 0
        beam_ang_size  = 2 if (data_content_beams & 2) else 0
        beam_size      = echo_size * num_echos + beam_prop_size + beam_ang_size
        data_offset    = mo

        # parse measurements
        for b in range(num_beams):
            for l in range(num_layers):
                for ec in range(num_echos):
                    base = data_offset + (b * num_layers + l) * beam_size
                    raw = struct.unpack_from("<H", m, base)[0] if echo_size > 0 else 0
                    d = raw * scaling / 1000.0  # mm→m

                    φ = phi_array[l]
                    θ = theta_start[l] + b * ((theta_stop[l] - theta_start[l]) / (num_beams - 1))

                    x = d * math.cos(φ) * math.cos(θ)
                    y = d * math.cos(φ) * math.sin(θ)
                    z = d * math.sin(φ)

                    all_pts.append({
                        "x": x,
                        "y": y,
                        "z": z,
                        "layer": l,
                        "channel": ec,
                        "beamIdx": b,
                        "theta": θ
                    })

        module_size = next_module_size
        offset += len(m)

    if frame_number is None:
        return None

    return frame_number, all_pts


class UDPProtocol(asyncio.DatagramProtocol):
    def datagram_received(self, data, addr):
        global current_frame, frame_points

        result = parse_compact(data)
        if not result:
            return

        frame_number, pts = result

        # 첫 모듈 도착 시 초기화
        if current_frame is None:
            current_frame = frame_number
            frame_points = []

        # 새 프레임 감지 → 이전 프레임 완성본 브로드캐스트
        if frame_number != current_frame:
            msg = json.dumps(frame_points)
            for ws in clients:
                asyncio.ensure_future(ws.send_str(msg))
            current_frame = frame_number
            frame_points = []

        # 같은 프레임이면 누적
        frame_points.extend(pts)


async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    print("🌐 WS 클라이언트 연결됨")
    clients.add(ws)
    try:
        async for msg in ws:
            # we're only broadcasting from UDP → WS, so ignore incoming messages
            pass
    finally:
        clients.remove(ws)

    return ws


async def init_app():
    app = web.Application()
    here = os.path.dirname(__file__)
    public_dir = os.path.join(here, "public")

    # 1) HTTP 서버: public 폴더 서빙
    app.router.add_static("/", public_dir, show_index=True)
    # 2) WebSocket 엔드포인트 (e.g. ws://host:3000/ws)
    app.router.add_get("/ws", websocket_handler)

    return app


def main():
    loop = asyncio.get_event_loop()

    # start UDP server
    print(f"📡 UDP 포트 {UDP_PORT}번에서 수신 대기 중")
    listen = loop.create_datagram_endpoint(
        UDPProtocol, local_addr=("0.0.0.0", UDP_PORT))
    loop.run_until_complete(listen)

    # start HTTP+WS server
    app = loop.run_until_complete(init_app())
    runner = web.AppRunner(app)
    loop.run_until_complete(runner.setup())
    site = web.TCPSite(runner, "0.0.0.0", HTTP_PORT)
    loop.run_until_complete(site.start())
    print(f"HTTP ▶ http://0.0.0.0:{HTTP_PORT}")

    try:
        loop.run_forever()
    except KeyboardInterrupt:
        pass
    finally:
        loop.close()


if __name__ == "__main__":
    main()
