#!/usr/bin/env python3
import asyncio, math, struct, json, logging, os, sys
from aiohttp import web
from sklearn.cluster import DBSCAN
from typing import Dict, Tuple, List, Set, Any
from scipy.spatial import KDTree

CONFIG_FILE = 'config.json'

def load_config() -> dict:
    with open(CONFIG_FILE, 'r') as f:
        return json.load(f)

def save_config(data: dict):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(data, f, indent=2)

def restart_server():
    os.execv(sys.executable, [sys.executable] + sys.argv)

config = load_config()

UDP_PORT = 2115
HTTP_PORT = 3000

DBSCAN_EPS = config["DBSCAN_EPS"]
DBSCAN_MIN_SAMPLES = config["DBSCAN_MIN_SAMPLES"]
MAX_MATCH_DIST = config["MAX_MATCH_DIST"]
FRAME_TIME_GAP_SEC = config["FRAME_TIME_GAP_SEC"]
MAX_CLUSTER_ID = config["MAX_CLUSTER_ID"]
USE_CONE_SHAPE = config["USE_CONE_SHAPE"]
CLUSTER_RADIUS = config["CLUSTER_RADIUS"]
ANGLE_TOLERANCE_DEG = config["ANGLE_TOLERANCE_DEG"]
ANGLE_TOLERANCE = math.radians(ANGLE_TOLERANCE_DEG)
CONICAL_CENTER_THETA = config["CONICAL_CENTER_THETA"]
CONICAL_CENTER_PHI = config["CONICAL_CENTER_PHI"]

def is_within_cone(p):
    d = math.sqrt(p['x']**2 + p['y']**2 + p['z']**2)
    if d > CLUSTER_RADIUS or d == 0:
        return False
    vx, vy, vz = p['x']/d, p['y']/d, p['z']/d
    dx = math.cos(CONICAL_CENTER_PHI) * math.cos(CONICAL_CENTER_THETA)
    dy = math.cos(CONICAL_CENTER_PHI) * math.sin(CONICAL_CENTER_THETA)
    dz = math.sin(CONICAL_CENTER_PHI)
    dot = vx*dx + vy*dy + vz*dz
    angle = math.acos(max(min(dot, 1.0), -1.0))
    return angle < ANGLE_TOLERANCE

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s', datefmt='%H:%M:%S')
clients: Set[web.WebSocketResponse] = set()

next_cluster_id = 0
prev_centroids = {}
prev_speeds = {}
reusable_ids = set()

def get_next_cluster_id() -> int:
    global next_cluster_id, reusable_ids
    if reusable_ids:
        return min(reusable_ids)
    for cid in range(MAX_CLUSTER_ID):
        if cid not in prev_centroids:
            return cid
    cid = next_cluster_id
    next_cluster_id = (next_cluster_id + 1) % MAX_CLUSTER_ID
    return cid

def assign_stable_ids(raw_clusters):
    global next_cluster_id, prev_centroids, prev_speeds, reusable_ids
    assignments = {}
    used_ids = set()
    new_centroids = {}
    collision_alerts = []
    cluster_info = {}

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
    points = []
    for i, rc in enumerate(raw_clusters):
        cid = assignments[i]
        for p in rc['pts']:
            p['cluster_id'] = cid
            points.append(p)
    return points, cluster_info, collision_alerts

def parse_compact(buffer):
    if len(buffer) < 32 or struct.unpack_from('>I', buffer)[0] != 0x02020202 or struct.unpack_from('<I', buffer, 4)[0] != 1:
        return None
    offset = 32
    module_size = struct.unpack_from('<I', buffer, 28)[0]
    all_pts = []
    frame_number = None
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

def process_frame(pts):
    pts = [p for p in pts if not (p['x'] == 0 and p['y'] == 0 and p['z'] == 0)]
    if not pts:
        return [], {}, []
    if USE_CONE_SHAPE:
        cluster_targets = [p for p in pts if is_within_cone(p)]
    else:
        cluster_targets = [p for p in pts if math.sqrt(p['x']**2 + p['y']**2 + p['z']**2) <= CLUSTER_RADIUS]
    if not cluster_targets:
        return [], {}, []
    coords = [[p['x'], p['y'], p['z']] for p in cluster_targets]
    labels = DBSCAN(eps=DBSCAN_EPS, min_samples=DBSCAN_MIN_SAMPLES).fit(coords).labels_
    clusters = {}
    for p, lbl in zip(cluster_targets, labels):
        clusters.setdefault(lbl, []).append(p)
    raw_clusters = []
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
        self.last_frame = None
        self.accum_pts = []

    def datagram_received(self, data, addr):
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

async def get_config(request):
    return web.json_response(load_config())

async def post_config(request):
    data = await request.json()
    save_config(data)
    logging.info("Config updated. Restarting...")
    asyncio.get_event_loop().call_later(1.0, restart_server)
    return web.json_response({"status": "ok"})

def main():
    app = web.Application()
    app.router.add_get('/ws', websocket_handler)
    app.router.add_get('/config', get_config)
    app.router.add_post('/config', post_config)
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
