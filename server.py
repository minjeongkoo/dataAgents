#!/usr/bin/env python3
import asyncio, math, struct, json, logging
from aiohttp import web
from sklearn.cluster import DBSCAN
from typing import Dict, Tuple, List, Set, Any
from scipy.spatial import KDTree

UDP_PORT: int = 2115
HTTP_PORT: int = 3000

DBSCAN_EPS: float = 0.25
DBSCAN_MIN_SAMPLES: int = 20
MAX_MATCH_DIST: float = 0.4
FRAME_TIME_GAP_SEC: float = 0.3
MAX_CLUSTER_ID: int = 10000
CLUSTER_RADIUS: float = 3.0

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s', datefmt='%H:%M:%S')
clients: Set[web.WebSocketResponse] = set()

next_cluster_id: int = 0
prev_centroids: Dict[int, Tuple[float, float, float]] = {}
prev_speeds: Dict[int, Tuple[float, float, float]] = {}
reusable_ids: Set[int] = set()

def get_next_cluster_id() -> int:
    global next_cluster_id, reusable_ids
    if reusable_ids:
        return min(reusable_ids)
    # 사용되지 않은 가장 작은 ID를 찾아 할당
    for cid in range(MAX_CLUSTER_ID):
        if cid not in prev_centroids:
            return cid
    # 모든 ID가 사용 중이면 순환 방식으로 fallback
    cid: int = next_cluster_id
    next_cluster_id = (next_cluster_id + 1) % MAX_CLUSTER_ID
    return cid

def assign_stable_ids(raw_clusters: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], Dict[int, Dict[str, Any]], List[str]]:
    global next_cluster_id, prev_centroids, prev_speeds, reusable_ids

    assignments: Dict[int, int] = {}
    used_ids: Set[int] = set()
    new_centroids: Dict[int, Tuple[float, float, float]] = {}
    collision_alerts: List[str] = []
    cluster_info: Dict[int, Dict[str, Any]] = {}

    prev_ids = list(prev_centroids.keys())
    prev_coords = [prev_centroids[pid] for pid in prev_ids]
    tree = KDTree(prev_coords) if prev_coords else None

    for i, rc in enumerate(raw_clusters):
        cx, cy, cz = rc['centroid']
        cid = None

        if tree:
            dist, idx = tree.query([cx, cy, cz], distance_upper_bound=MAX_MATCH_DIST)
            if idx < len(prev_ids):
                matched_id = prev_ids[idx]
                if matched_id not in used_ids:
                    cid = matched_id
                    used_ids.add(cid)

        if cid is None:
            cid = get_next_cluster_id()

        assignments[i] = cid
        new_centroids[cid] = (cx, cy, cz)

        vx = vy = vz = 0.0
        moved = False
        if cid in prev_centroids:
            px, py, pz = prev_centroids[cid]
            vx, vy, vz = [(c - p) / FRAME_TIME_GAP_SEC for c, p in zip((cx, cy, cz), (px, py, pz))]
            moved = math.dist((cx, cy, cz), (px, py, pz)) > 0.1
        else:
            moved = True

        prev_speeds[cid] = (vx, vy, vz)

        xs = [p['x'] for p in rc['pts']]
        ys = [p['y'] for p in rc['pts']]
        zs = [p['z'] for p in rc['pts']]
        bbox = {
            "min": [min(xs), min(ys), min(zs)],
            "max": [max(xs), max(ys), max(zs)]
        }

        dist_to_origin = math.sqrt(cx**2 + cy**2 + cz**2)
        if dist_to_origin < 0.5:
            msg = (f"Cluster {cid} 위험! 원점 거리 {dist_to_origin:.2f}m, 속도=({vx:.2f},{vy:.2f},{vz:.2f})")
            collision_alerts.append(msg)

        cluster_info[cid] = {
            "centroid": [cx, cy, cz],
            "velocity": [vx, vy, vz],
            "speed": math.sqrt(vx**2 + vy**2 + vz**2),
            "bbox": bbox,
            "moved": moved,
            "count": len(rc['pts'])
        }

    reusable_ids.clear()
    reusable_ids.update(set(prev_centroids.keys()) - set(new_centroids.keys()))
    prev_centroids = new_centroids

    points: List[Dict[str, Any]] = []
    for i, rc in enumerate(raw_clusters):
        cid = assignments[i]
        for p in rc['pts']:
            p['cluster_id'] = cid
            points.append(p)

    return points, cluster_info, collision_alerts

def parse_compact(buffer: bytes) -> Tuple[int, List[Dict[str, float]]] | None:
    if len(buffer) < 32 or struct.unpack_from('>I', buffer)[0] != 0x02020202 or struct.unpack_from('<I', buffer, 4)[0] != 1:
        return None
    offset: int = 32
    module_size: int = struct.unpack_from('<I', buffer, 28)[0]
    all_pts: List[Dict[str, float]] = []
    frame_number: int | None = None

    while module_size > 0 and offset + module_size <= len(buffer):
        m = buffer[offset:offset+module_size]
        frame_number = int.from_bytes(m[8:16], 'little')
        num_layers, num_beams, num_echos = struct.unpack_from('<III', m, 20)
        mo = 32 + num_layers * 16
        phi = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]; mo += 4 * num_layers
        theta_start = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]; mo += 4 * num_layers
        theta_stop = [struct.unpack_from('<f', m, mo + 4*i)[0] for i in range(num_layers)]; mo += 4 * num_layers
        scaling, next_module = struct.unpack_from('<fI', m, mo); mo += 8
        mo += 1
        data_echos, data_beams = m[mo], m[mo+1]; mo += 3
        echo_size = (2 if data_echos & 1 else 0) + (2 if data_echos & 2 else 0)
        beam_prop_size = 1 if data_beams & 1 else 0
        beam_angle_size = 2 if data_beams & 2 else 0
        beam_size = echo_size * num_echos + beam_prop_size + beam_angle_size
        data_offset = mo

        for b in range(num_beams):
            for l in range(num_layers):
                base = data_offset + (b*num_layers + l)*beam_size
                for ec in range(num_echos):
                    idx = base + ec*echo_size
                    if echo_size > 0 and idx + echo_size > len(m): continue
                    raw = struct.unpack_from('<H', m, idx)[0] if echo_size else 0
                    d = raw * scaling / 1000.0
                    ϕ = phi[l]
                    θ = theta_start[l] + b*((theta_stop[l]-theta_start[l])/max(1, num_beams-1))
                    all_pts.append({
                        'x': d*math.cos(ϕ)*math.cos(θ),
                        'y': d*math.cos(ϕ)*math.sin(θ),
                        'z': d*math.sin(ϕ),
                        'theta': θ
                    })
        offset += module_size
        module_size = next_module

    return (frame_number, all_pts) if frame_number is not None else None

def process_frame(pts: List[Dict[str, float]]) -> Tuple[List[Dict[str, Any]], Dict[int, Dict[str, Any]], List[str]]:
    pts = [p for p in pts if not (p['x'] == 0 and p['y'] == 0 and p['z'] == 0)]
    if not pts:
        return [], {}, []

    cluster_targets = [p for p in pts if math.sqrt(p['x']**2 + p['y']**2 + p['z']**2) <= CLUSTER_RADIUS]
    coords = [[p['x'], p['y'], p['z']] for p in cluster_targets]
    labels = DBSCAN(eps=DBSCAN_EPS, min_samples=DBSCAN_MIN_SAMPLES).fit(coords).labels_

    clusters: Dict[int, List[Dict[str, float]]] = {}
    for p, lbl in zip(cluster_targets, labels):
        clusters.setdefault(lbl, []).append(p)

    raw_clusters: List[Dict[str, Any]] = []
    noise_pts = clusters.pop(-1, [])

    for lbl, cpts in clusters.items():
        cx = sum(p['x'] for p in cpts) / len(cpts)
        cy = sum(p['y'] for p in cpts) / len(cpts)
        cz = sum(p['z'] for p in cpts) / len(cpts)
        raw_clusters.append({'pts': cpts, 'centroid': (cx, cy, cz)})

    stable_pts, cluster_info, alerts = assign_stable_ids(raw_clusters)

    for p in noise_pts:
        p['cluster_id'] = -1

    clustered_ids = {id(p) for p in stable_pts}
    noise_ids = {id(p) for p in noise_pts}
    unprocessed_pts = [p for p in pts if id(p) not in clustered_ids and id(p) not in noise_ids]

    return stable_pts + noise_pts + unprocessed_pts, cluster_info, alerts

class FrameProtocol(asyncio.DatagramProtocol):
    def __init__(self):
        self.last_frame: int | None = None
        self.accum_pts: List[Dict[str, float]] = []

    def datagram_received(self, data: bytes, addr: Tuple[str, int]) -> None:
        parsed = parse_compact(data)
        if not parsed:
            return
        frame_num, pts = parsed

        if self.last_frame is None:
            self.last_frame = frame_num

        if frame_num != self.last_frame:
            stable_pts, cluster_info, alerts = process_frame(self.accum_pts)
            msg = json.dumps({"points": stable_pts, "clusters": cluster_info, "alerts": alerts})
            for ws in list(clients):
                if not ws.closed:
                    asyncio.create_task(ws.send_str(msg))
            logging.info(f"Sent frame {self.last_frame} → {len(stable_pts)} pts, {len(cluster_info)} clusters, {len(alerts)} alerts")
            self.accum_pts = []
            self.last_frame = frame_num
        else:
            self.accum_pts.extend(pts)

async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    clients.add(ws)
    logging.info("WS client connected")
    async for _ in ws:
        pass
    clients.discard(ws)
    logging.info("WS client disconnected")
    return ws

def main() -> None:
    app = web.Application()
    app.router.add_get('/ws', websocket_handler)
    app.router.add_static('/', path='public', show_index=True)

    loop = asyncio.get_event_loop()
    loop.run_until_complete(loop.create_datagram_endpoint(lambda: FrameProtocol(), local_addr=('0.0.0.0', UDP_PORT)))
    runner = web.AppRunner(app)
    loop.run_until_complete(runner.setup())
    loop.run_until_complete(web.TCPSite(runner, '0.0.0.0', HTTP_PORT).start())

    logging.info(f"HTTP http://0.0.0.0:{HTTP_PORT}")
    logging.info(f"UDP listening on {UDP_PORT}")
    loop.run_forever()

if __name__ == '__main__':
    main()