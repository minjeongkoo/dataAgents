import sys
import struct
import json
import numpy as np

def parse_compact_packet(hex_str):
    try:
        # 디버깅을 위한 입력 데이터 출력
        sys.stderr.write(f"[parser.py] Received hex string length: {len(hex_str)}\n")
        
        # 시작 바이트와 데이터 길이 확인
        if len(hex_str) < 4:
            sys.stderr.write("[parser.py] Error: Input too short\n")
            return { "points": [] }
            
        start_byte = int(hex_str[0:2], 16)
        data_length = int(hex_str[2:6], 16)
        
        sys.stderr.write(f"[parser.py] Start byte: {start_byte}, Data length: {data_length}\n")
        
        if start_byte != 2:
            sys.stderr.write("[parser.py] Error: Invalid start byte\n")
            return { "points": [] }
            
        # 실제 데이터 부분만 추출
        actual_data = hex_str[6:]
        if len(actual_data) < data_length * 2:  # hex 문자열이므로 길이 * 2
            sys.stderr.write("[parser.py] Error: Data length mismatch\n")
            return { "points": [] }
            
        raw = bytes.fromhex(actual_data)

        # 헤더 구조 수정
        header_size = 32
        module_offset = 0  # 헤더 시작 위치 변경

        # Parse scan parameters
        try:
            scan_point_count = struct.unpack_from('<H', raw, module_offset + 2)[0]
            start_angle_raw = struct.unpack_from('<i', raw, module_offset + 4)[0]
            angle_step_raw = struct.unpack_from('<I', raw, module_offset + 8)[0]
            data_offset = module_offset + 12

            sys.stderr.write(f"[parser.py] Raw scan parameters - Count: {scan_point_count}, Start angle: {start_angle_raw}, Step: {angle_step_raw}\n")

            # 값 검증
            if scan_point_count == 0 or angle_step_raw == 0:
                sys.stderr.write("[parser.py] Error: Invalid scan parameters\n")
                return { "points": [] }

            start_angle = (start_angle_raw / 10000.0) * np.pi / 180  # radians
            angle_step = (angle_step_raw / 10000.0) * np.pi / 180

            sys.stderr.write(f"[parser.py] Converted angles - Start: {start_angle}, Step: {angle_step}\n")

            points = []

            for i in range(scan_point_count):
                try:
                    dist = struct.unpack_from('<H', raw, data_offset + i * 2)[0]
                    if dist > 0:
                        angle = start_angle + i * angle_step
                        x = dist * np.cos(angle)
                        y = dist * np.sin(angle)
                        points.append({ "x": float(x), "y": float(y) })
                except struct.error as e:
                    sys.stderr.write(f"[parser.py] Error parsing point {i}: {e}\n")
                    continue

            result = { 
                "points": points
            }
            
            # 디버깅을 위한 결과 출력
            sys.stderr.write(f"[parser.py] Parsed {len(points)} points\n")
            return result

        except struct.error as e:
            sys.stderr.write(f"[parser.py] Struct error: {str(e)}\n")
            return { "points": [] }
        
    except Exception as e:
        # Print error to stderr (not stdout)
        sys.stderr.write(f"[parser.py] Parse error: {str(e)}\n")
        return { "points": [] }

if __name__ == "__main__":
    for line in sys.stdin:
        try:
            parsed = parse_compact_packet(line.strip())
            json_str = json.dumps(parsed)
            sys.stdout.write(json_str + "\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stderr.write(f"[parser.py] Main loop error: {str(e)}\n")
            sys.stdout.write(json.dumps({"points": []}) + "\n")
            sys.stdout.flush()