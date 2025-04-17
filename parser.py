import sys
import struct
import json
import numpy as np

def parse_compact_packet(hex_str):
    raw = bytes.fromhex(hex_str.strip())

    try:
        header_size = 32
        module_offset = header_size
        scan_point_count = struct.unpack_from('<H', raw, module_offset + 2)[0]
        start_angle_raw = struct.unpack_from('<i', raw, module_offset + 4)[0]
        angle_step_raw = struct.unpack_from('<I', raw, module_offset + 8)[0]
        data_offset = module_offset + 12

        start_angle = (start_angle_raw / 10000.0) * np.pi / 180
        angle_step = (angle_step_raw / 10000.0) * np.pi / 180

        points = []
        for i in range(scan_point_count):
            dist = struct.unpack_from('<H', raw, data_offset + i*2)[0]
            if dist > 0:
                angle = start_angle + i * angle_step
                x = dist * np.cos(angle)
                y = dist * np.sin(angle)
                points.append({'x': x, 'y': y})

        return points
    except Exception as e:
        return []

if __name__ == "__main__":
    for line in sys.stdin:
        result = parse_compact_packet(line)
        print(json.dumps({ "points": result }), flush=True)
