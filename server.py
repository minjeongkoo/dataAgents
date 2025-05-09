# server.py
import asyncio
import math
import struct
import json
from aiohttp import web

# 연결된 WebSocket 클라이언트
clients = set()

# 현재 수집 중인 프레임 정보
current_frame = None
frame_points = []

def parse_compact(buffer):
    # 최소 헤더 길이 체크
    if len(buffer) < 32:
        return None
    # SOF 확인
    if struct.unpack_from('>I', buffer, 0)[0] != 0x02020202:
        return None
    # commandId 확인
    if struct.unpack_from('<I', buffer, 4)[0] != 1:
        return None

    offset = 32
    module_size = struct.unpack_from('<I', buffer, 28)[0]
    all_pts = []
    frame_number = None

    while module_size > 0 and offset + module_size <= len(buffer):
        m = buffer[offset:offset + module_size]

        # 메타데이터 추출
        frame_number = int.from_bytes(m[8:16], 'little')
        num_layers = struct.unpack_from('<I', m, 20)[0]
        num_beams  = struct.unpack_from('<I', m, 24)[0]
        num_echos  = struct.unpack_from('<I', m, 28)[0]
        mo = 32

        # TimestampStart/Stop 크기 건너뛰기
        mo += num_layers * 16

        # Phi 배열
        phi = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers

        # ThetaStart, ThetaStop 배열
        theta_start = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers
        theta_stop  = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers

        # scalingFactor, nextModuleSize, flags
        scaling     = struct.unpack_from('<f', m, mo)[0]; mo += 4
        next_module = struct.unpack_from('<I', m, mo)[0]; mo += 4
        mo += 1
        data_echos  = m[mo]; mo += 1
        data_beams  = m[mo]; mo += 1
        mo += 1

        # 데이터 블록 크기 계산
        echo_size       = ((data_echos & 1) * 2) + ((data_echos & 2) * 2)
        beam_prop_size  = 1 if (data_beams & 1) else 0
        beam_angle_size = 2 if (data_beams & 2) else 0
        beam_size       = echo_size * num_echos + beam_prop_size + beam_angle_size
        data_offset     = mo

        # 포인트 계산
        for b in range(num_beams):
            for l in range(num_layers):
                base = data_offset + (b * num_layers + l) * beam_size
                for ec in range(num_echos):
                    raw = struct.unpack_from('<H', m, base + ec * echo_size)[0] if echo_size else 0
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

        parsed = parse_compact(data)
        if parsed is None:
            return
        frame_number, pts = parsed

        # 첫 번째 패킷이면 초기화
        if current_frame is None:
            current_frame = frame_number
            frame_points  = []

        # 프레임이 바뀌면 이전 프레임 전송
        if frame_number != current_frame:
            msg = json.dumps(frame_points)
            for ws in clients.copy():
                if not ws.closed:
                    asyncio.create_task(ws.send_str(msg))
            current_frame = frame_number
            frame_points  = []

        # 같은 프레임이면 포인트 누적
        frame_points.extend(pts)

async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    clients.add(ws)
    async for _ in ws:
        pass
    clients.discard(ws)
    return ws

app = web.Application()
app.router.add_get('/ws', websocket_handler)
app.router.add_static('/', path='public', show_index=True)

if __name__ == '__main__':
    loop = asyncio.get_event_loop()
    # UDP 서버 구동
    listen = loop.create_datagram_endpoint(
        LiDARProtocol, local_addr=('0.0.0.0', 2115)
    )
    loop.run_until_complete(listen)

    # HTTP + WebSocket 서버 구동
    runner = web.AppRunner(app)
    loop.run_until_complete(runner.setup())
    site = web.TCPSite(runner, '0.0.0.0', 3000)
    loop.run_until_complete(site.start())

    print("HTTP ▶ http://0.0.0.0:3000")
    print("📡 UDP listening on port 2115")
    loop.run_forever()
