#!/usr/bin/env python3
import asyncio
import struct
import json
import logging
from aiohttp import web

# ----- 설정 -----
UDP_PORT = 2115            # LiDAR 데이터 수신용 UDP 포트
HTTP_PORT = 3000           # HTTP & WS 서버 포트
EXPECTED_POINTS = 16 * 270  # layers × beams × echoes (=4320)

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(message)s',
    datefmt='%H:%M:%S'
)

# 전역 버퍼 및 WS 연결 관리
scan_buffer = []
WS_CLIENTS = set()

def parse_compact(buffer: bytes):
    """
    Compact Format 버퍼를 파싱하여
    [{'x': float, 'y': float, 'z': float, 'cluster_id': int}, ...] 반환
    실제 파싱 로직을 여기에 붙여넣으세요.
    """
    # TODO: 실제 SICK Compact Format 파싱 코드 삽입
    return []

class LiDARProtocol(asyncio.DatagramProtocol):
    def datagram_received(self, data, addr):
        global scan_buffer
        pts = parse_compact(data)
        if not pts:
            return
        scan_buffer.extend(pts)

        # 완전한 스캔(4320포인트) 단위로 전송
        if len(scan_buffer) >= EXPECTED_POINTS:
            full_scan = scan_buffer[:EXPECTED_POINTS]
            msg = json.dumps(full_scan)
            for ws in list(WS_CLIENTS):
                asyncio.create_task(ws.send_str(msg))
            del scan_buffer[:EXPECTED_POINTS]

async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    WS_CLIENTS.add(ws)
    logging.info(f'WS 연결: {request.remote}')

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.ERROR:
                logging.error(f'WS 에러: {ws.exception()}')
    finally:
        WS_CLIENTS.remove(ws)
        logging.info(f'WS 연결 끊김: {request.remote}')
    return ws

async def init_app():
    app = web.Application()
    app.router.add_get('/ws', websocket_handler)
    app.router.add_static('/', path='public', show_index=True)
    return app

async def main():
    loop = asyncio.get_running_loop()
    await loop.create_datagram_endpoint(
        lambda: LiDARProtocol(),
        local_addr=('0.0.0.0', UDP_PORT)
    )
    app = await init_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', HTTP_PORT)
    await site.start()
    logging.info(f'HTTP + WS 서비스 시작: http://0.0.0.0:{HTTP_PORT}')
    await asyncio.Future()

if __name__ == '__main__':
    asyncio.run(main())