import json
import matplotlib.pyplot as plt
import glob

# 가장 최근 JSON 파일 찾기
files = sorted(glob.glob('module_*.json'))
if not files:
    print("No JSON file found.")
    exit()

filename = files[-1] # 가장 최근 파일 사용
print(f"Loading {filename}")

# JSON 파일 읽기
with open(filename, 'r') as f:
    data = json.load(f)

# 데이터 분리
distances = [p['distance'] for p in data if p['distance'] > 0]
rssi = [p['rssi'] for p in data if p['distance'] > 0]

# Scatter Plot
plt.figure(figsize=(10, 6))
plt.scatter(distances, rssi, s=10, alpha=0.7)
plt.title('Distance vs RSSI')
plt.xlabel('Distance (mm)')
plt.ylabel('RSSI')
plt.grid(True)
plt.show()
