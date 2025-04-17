import sys
import struct
import json
import numpy as np

def parse_compact_packet(hex_str):
    try:
        # 디버깅을 위한 입력 데이터 출력
        sys.stderr.write(f"[parser.py] Received hex string: {hex_str}\n")
        
        raw = bytes.fromhex(hex_str.strip())

        header_size = 32
        module_offset = header_size

        # Parse scan parameters
        scan_point_count = struct.unpack_from('<H', raw, module_offset + 2)[0]
        start_angle_raw = struct.unpack_from('<i', raw, module_offset + 4)[0]
        angle_step_raw = struct.unpack_from('<I', raw, module_offset + 8)[0]
        data_offset = module_offset + 12

        start_angle = (start_angle_raw / 10000.0) * np.pi / 180  # radians
        angle_step = (angle_step_raw / 10000.0) * np.pi / 180

        points = []

        for i in range(scan_point_count):
            dist = struct.unpack_from('<H', raw, data_offset + i * 2)[0]
            if dist > 0:
                angle = start_angle + i * angle_step
                x = dist * np.cos(angle)
                y = dist * np.sin(angle)
                points.append({ "x": float(x), "y": float(y) })  # numpy float를 Python float로 변환

        result = { 
            "points": points
        }
        
        # 디버깅을 위한 결과 출력
        sys.stderr.write(f"[parser.py] Parsed result: {json.dumps(result)}\n")
        return result
        
    except Exception as e:
        # Print error to stderr (not stdout)
        sys.stderr.write(f"[parser.py] Parse error: {e}\n")
        return { "points": [] }

if __name__ == "__main__":
    for line in sys.stdin:
        try:
            parsed = parse_compact_packet(line)
            json_str = json.dumps(parsed)
            sys.stdout.write(json_str + "\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stderr.write(f"[parser.py] Main loop error: {e}\n")
            sys.stdout.write(json.dumps({"points": []}) + "\n")
            sys.stdout.flush()