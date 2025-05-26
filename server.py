#!/usr/bin/env python3
import asyncio, math, struct, json, logging
from aiohttp import web
from sklearn.cluster import DBSCAN

UDP_PORT, HTTP_PORT = 2115, 3000
DBSCAN_EPS, DBSCAN_MIN_SAMPLES, MAX_MATCH_DIST = 0.3, 10, 0.5
FRAME_TIME_GAP_SEC = 0.1
MAX_CLUSTER_ID = 10000

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s', datefmt='%H:%M:%S')
clients = set()

next_cluster_id = 0
prev_centroids = {}      # {cluster_id: (x,y,z)}
prev_speeds = {}         # {cluster_id: (vx, vy, vz)}
reusable_ids = set()

def get_next_cluster_id():
    global next_cluster_id, reusable_ids
    if reusable_ids:
        return reusable_ids.pop()
    cid = next_cluster_id
    next_cluster_id = (next_cluster_id + 1) % MAX_CLUSTER_ID
    return cid

def assign_stable_ids(raw_clusters):
    global next_cluster_id, prev_centroids, prev_speeds, reusable_ids

    new_centroids, assignments = {}, {}
    used_ids = set()

    for i, rc in enumerate(raw_clusters):
        cx, cy, cz = rc['centroid']
        best_id, best_dist = None, float('inf')
        for old_id, (ox, oy, oz) in prev_centroids.items():
            d = math.dist((cx, cy, cz), (ox, oy, oz))
            if d < best_dist and old_id not in used_ids:
                best_dist, best_id = d, old_id
        if best_id is not None and best_dist < MAX_MATCH_DIST:
            assignments[i] = best_id
            used_ids.add(best_id)
            new_centroids[best_id] = (cx, cy, cz)
        else:
            cid = get_next_cluster_id()
            assignments[i] = cid
            used_ids.add(cid)
            new_centroids[cid] = (cx, cy, cz)

    reusable_ids = set(prev_centroids.keys()) - set(new_centroids.keys())

    cluster_info = {}
    for i, rc in enumerate(raw_clusters):
        cid = assignments[i]
        cx, cy, cz = rc['centroid']

        vx = vy = vz = 0
        moved = False
        if cid in prev_centroids:
            px, py, pz = prev_centroids[cid]
            vx, vy, vz = [(c - p) / FRAME_TIME_GAP_SEC for c, p in zip((cx, cy, cz), (px, py, pz))]
            moved = math.dist((cx, cy, cz), (px, py, pz)) > 0.1  # 10cm 이상 이동
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

        cluster_info[cid] = {
            "centroid": [cx, cy, cz],
            "velocity": [vx, vy, vz],
            "speed": math.sqrt(vx**2 + vy**2 + vz**2),
            "bbox": bbox,
            "moved": moved
        }

    prev_centroids = new_centroids

    points = []
    for i, rc in enumerate(raw_clusters):
        cid = assignments[i]
        for p in rc['pts']:
            p['cluster_id'] = cid
            points.append(p)

    return points, cluster_info

def parse_compact(buffer: bytes):
    if len(buffer) < 32 or struct.unpack_from('>I', buffer)[0] != 0x02020202 or struct.unpack_from('<I', buffer, 4)[0] != 1:
        return None
    offset, module_size = 32, struct.unpack_from('<I', buffer, 28)[0]
    all_pts, frame_number = [], None

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
                    ϕ, θ = phi[l], theta_start[l] + b*((theta_stop[l]-theta_start[l])/max(1, num_beams-1))
                    all_pts.append({'x': d*math.cos(ϕ)*math.cos(θ),
                                    'y': d*math.cos(ϕ)*math.sin(θ),
                                    'z': d*math.sin(ϕ),
                                    'theta': θ})
        offset += module_size
        module_size = next_module

    return (frame_number, all_pts) if frame_number is not None else None

def process_frame(pts):
    pts = [p for p in pts if not (p['x']==0 and p['y']==0 and p['z']==0)]
    if not pts: return [], {}
    coords = [[p['x'], p['y'], p['z']] for p in pts]
    labels = DBSCAN(eps=DBSCAN_EPS, min_samples=DBSCAN_MIN_SAMPLES).fit(coords).labels_

    clusters = {}
    for p, lbl in zip(pts, labels):
        clusters.setdefault(lbl, []).append(p)

    raw_clusters = []
    noise_pts = clusters.pop(-1, [])
    for p in noise_pts: p['cluster_id'] = -1

    for lbl, cpts in clusters.items():
        cx = sum(p['x'] for p in cpts)/len(cpts)
        cy = sum(p['y'] for p in cpts)/len(cpts)
        cz = sum(p['z'] for p in cpts)/len(cpts)
        raw_clusters.append({'pts': cpts, 'centroid': (cx, cy, cz)})

    stable_pts, cluster_info = assign_stable_ids(raw_clusters)
    stable_pts.extend(noise_pts)
    return stable_pts, cluster_info

class FrameProtocol(asyncio.DatagramProtocol):
    def __init__(self):
        self.last_frame = None
        self.accum_pts = []

    def datagram_received(self, data, addr):
        parsed = parse_compact(data)
        if not parsed: return
        frame_num, pts = parsed

        if self.last_frame is None:
            self.last_frame = frame_num

        if frame_num != self.last_frame:
            stable_pts, cluster_info = process_frame(self.accum_pts)
            msg = json.dumps({"points": stable_pts, "clusters": cluster_info})
            for ws in list(clients):
                if not ws.closed:
                    asyncio.create_task(ws.send_str(msg))
            logging.info(f"Sent frame {self.last_frame} → {len(stable_pts)} pts, {len(cluster_info)} clusters")
            self.accum_pts = []
            self.last_frame = frame_num
        else:
            self.accum_pts.extend(pts)

async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    clients.add(ws)
    logging.info("WS client connected")
    async for _ in ws: pass
    clients.discard(ws)
    logging.info("WS client disconnected")
    return ws

def main():
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