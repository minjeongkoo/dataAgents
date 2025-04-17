import sys
import struct
import matplotlib.pyplot as plt
import numpy as np

plt.ion()
fig, ax = plt.subplots()
sc = ax.scatter([], [], s=2, c='lime')
ax.set_facecolor('black')
ax.set_xlim(-10000, 10000)
ax.set_ylim(-10000, 10000)

def parse_compact_packet(hex_str):
    raw = bytes.fromhex(hex_str.strip())

    try:
        header_size = 32
        module_offset = header_size

        layer_count = raw[module_offset]
        echo_count = raw[module_offset + 1]
        scan_point_count = struct.unpack_from('<H', raw, module_offset + 2)[0]

        start_angle_raw = struct.unpack_from('<i', raw, module_offset + 4)[0]
        angle_step_raw = struct.unpack_from('<I', raw, module_offset + 8)[0]

        data_offset = module_offset + 12
        angles = []
        dists = []
        for i in range(scan_point_count):
            dist = struct.unpack_from('<H', raw, data_offset + i * 2)[0]
            if dist > 0:
                angle_deg = (start_angle_raw + i * angle_step_raw) / 10000.0
                angle_rad = np.radians(angle_deg)
                x = dist * np.cos(angle_rad)
                y = dist * np.sin(angle_rad)
                dists.append((x, y))
        return dists
    except Exception as e:
        print(f'파싱 실패: {e}', file=sys.stderr)
        return []

def update_plot(points):
    if not points:
        return
    x, y = zip(*points)
    sc.set_offsets(np.column_stack((x, y)))
    plt.draw()
    plt.pause(0.001)

if __name__ == "__main__":
    for line in sys.stdin:
        points = parse_compact_packet(line)
        update_plot(points)
        print(f"✔ {len(points)} points 시각화 완료")
