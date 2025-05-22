#!/usr/bin/env python3
import asyncio
import math
import struct
import json
import logging
from aiohttp import web
from sklearn.cluster import DBSCAN

# ─── 설정 ─────────────────────────────────────────────────────────
UDP_PORT            = 2115
HTTP_PORT           = 3000
DBSCAN_EPS          = 0.3    # DBSCAN 반경 (미터)
DBSCAN_MIN_SAMPLES  = 10     # DBSCAN 최소 샘플
MAX_MATCH_DIST      = 0.5    # Stable ID 매칭 최대 거리 (미터)
# ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(message)s',
    datefmt='%H:%M:%S'
)

clients = set()

# Stable ID 글로벌 상태
next_cluster_id = 0
prev_centroids  = {}   # {stable_id: (x,y,z)}

def assign_stable_ids(raw_clusters):
    """
    raw_clusters: List of {'pts': [...], 'centroid': (x,y,z)}
    noise cluster은 label=-1로 이미 처리된 상태여야 함.
    반환: 각 p 에 p['cluster_id'] 가 달린 flat list
    """
    global next_cluster_id, prev_centroids

    new_centroids = {}
    assignments   = {}

    # 1) 기존 centroids와 가장 가까운 것 매칭
    for i, rc in enumerate(raw_clusters):
        cx, cy, cz = rc['centroid']
        best_id, best_dist = None, float('inf')
        for old_id, (ox,oy,oz) in prev_centroids.items():
            d = math.dist((cx,cy,cz),(ox,oy,oz))
            if d < best_dist:
                best_dist, best_id = d, old_id
        if best_id is not None and best_dist < MAX_MATCH_DIST:
            assignments[i] = best_id
            new_centroids[best_id] = (cx,cy,cz)

    # 2) 매칭 안 된 새 클러스터에 신 ID 부여
    for i, rc in enumerate(raw_clusters):
        if i not in assignments:
            assignments[i] = next_cluster_id
            new_centroids[next_cluster_id] = rc['centroid']
            next_cluster_id += 1

    # 3) 상태 갱신 (사라진 old_id 자동 제거)
    prev_centroids = new_centroids

    # 4) pts 에 cluster_id 부착
    output = []
    for i, rc in enumerate(raw_clusters):
        cid = assignments[i]
        for p in rc['pts']:
            p['cluster_id'] = cid
            output.append(p)
    return output

def parse_compact(buffer: bytes):
    """Compact Format 파싱 → frame_number, pts list 반환"""
    if len(buffer) < 32: return None
    if struct.unpack_from('>I', buffer, 0)[0] != 0x02020202: return None
    if struct.unpack_from('<I', buffer, 4)[0] != 1:          return None

    offset      = 32
    module_size = struct.unpack_from('<I', buffer, 28)[0]
    all_pts     = []
    frame_number= None

    while module_size > 0 and offset + module_size <= len(buffer):
        m = buffer[offset:offset+module_size]
        frame_number = int.from_bytes(m[8:16], 'little')
        num_layers   = struct.unpack_from('<I', m, 20)[0]
        num_beams    = struct.unpack_from('<I', m, 24)[0]
        num_echos    = struct.unpack_from('<I', m, 28)[0]
        mo = 32 + num_layers*16

        # Phi
        phi = [struct.unpack_from('<f', m, mo+4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers
        # ThetaStart / ThetaStop
        theta_start = [struct.unpack_from('<f', m, mo+4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers
        theta_stop  = [struct.unpack_from('<f', m, mo+4*i)[0] for i in range(num_layers)]
        mo += 4 * num_layers
        # Scaling
        scaling     = struct.unpack_from('<f', m, mo)[0]; mo += 4
        # NextModule
        next_module = struct.unpack_from('<I', m, mo)[0]; mo += 4
        last_module = (next_module == 0)
        # Flags
        mo += 1
        data_echos  = m[mo]; mo += 1
        data_beams  = m[mo]; mo += 1
        mo += 1

        # 크기 계산
        echo_size       = (2 if (data_echos & 1) else 0) + (2 if (data_echos & 2) else 0)
        beam_prop_size  = 1 if (data_beams & 1) else 0
        beam_angle_size = 2 if (data_beams & 2) else 0
        beam_size       = echo_size * num_echos + beam_prop_size + beam_angle_size
        data_offset     = mo

        # 포인트 파싱
        for b in range(num_beams):
            for l in range(num_layers):
                base = data_offset + (b*num_layers + l)*beam_size
                for ec in range(num_echos):
                    idx = base + ec*echo_size
                    if echo_size>0 and idx+echo_size>len(m): continue
                    raw = struct.unpack_from('<H', m, idx)[0] if echo_size else 0
                    d   = raw*scaling/1000.0
                    φ   = phi[l]
                    θ   = theta_start[l] + b*((theta_stop[l]-theta_start[l])/max(1, num_beams-1))
                    all_pts.append({'x':d*math.cos(φ)*math.cos(θ),
                                    'y':d*math.cos(φ)*math.sin(θ),
                                    'z':d*math.sin(φ),
                                    'theta':θ})

        offset      += module_size
        module_size  = next_module

    if frame_number is None:
        return None
    return frame_number, all_pts

def process_frame(pts):
    """1) 잡음 제거(0,0,0) → 2) DBSCAN → 3) Stable ID 부착 → flat pts list 리턴"""
    # 1) (0,0,0) 포인트 제거
    pts = [p for p in pts if not (p['x']==0 and p['y']==0 and p['z']==0)]
    if not pts:
        return []

    # 2) DBSCAN 클러스터링
    coords = [[p['x'], p['y'], p['z']] for p in pts]
    db     = DBSCAN(eps=DBSCAN_EPS, min_samples=DBSCAN_MIN_SAMPLES).fit(coords)
    labels = db.labels_

    # 3) 클러스터별 pts 묶고 centroids 계산
    clusters = {}
    for p, lbl in zip(pts, labels):
        clusters.setdefault(lbl, []).append(p)

    raw_clusters = []
    # noise(-1) → 바로 cluster_id=-1 처리
    noise_pts = clusters.pop(-1, [])
    for p in noise_pts:
        p['cluster_id'] = -1

    # 나머지만 stable ID 할당 대상
    for lbl, cpts in clusters.items():
        cx = sum(p['x'] for p in cpts)/len(cpts)
        cy = sum(p['y'] for p in cpts)/len(cpts)
        cz = sum(p['z'] for p in cpts)/len(cpts)
        raw_clusters.append({'pts': cpts, 'centroid': (cx,cy,cz)})

    stable = []
    stable.extend(noise_pts)
    stable.extend(assign_stable_ids(raw_clusters))
    return stable

class FrameProtocol(asyncio.DatagramProtocol):
    """FrameNumber 가 바뀔 때마다 360° 전체 스캔 처리"""
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

        # 프레임 번호가 바뀌면 이전 쌓인 pts 전체를 클러스터+Stable ID 처리 후 전송
        if frame_num != self.last_frame:
            stable_pts = process_frame(self.accum_pts)
            msg = json.dumps(stable_pts)
            for ws in list(clients):
                if not ws.closed:
                    asyncio.create_task(ws.send_str(msg))
            logging.info(f"✅ Sent frame {self.last_frame} → {len(stable_pts)} pts (clusters)")
            self.accum_pts  = []
            self.last_frame = frame_num

        else:
            self.accum_pts.extend(pts)


async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    clients.add(ws)
    logging.info("🟢 WS client connected")
    async for _ in ws:
        pass
    clients.discard(ws)
    logging.info("🔴 WS client disconnected")
    return ws


def main():
    app = web.Application()
    app.router.add_get('/ws', websocket_handler)
    app.router.add_static('/', path='public', show_index=True)

    loop   = asyncio.get_event_loop()
    # UDP 바인딩
    coro1  = loop.create_datagram_endpoint(lambda: FrameProtocol(),
                                           local_addr=('0.0.0.0', UDP_PORT))
    loop.run_until_complete(coro1)
    # HTTP 서버
    runner = web.AppRunner(app)
    loop.run_until_complete(runner.setup())
    loop.run_until_complete(web.TCPSite(runner, '0.0.0.0', HTTP_PORT).start())

    logging.info(f"🌐 HTTP http://0.0.0.0:{HTTP_PORT}")
    logging.info(f"📡 UDP listening on port {UDP_PORT}")
    loop.run_forever()

if __name__ == '__main__':
    main()
