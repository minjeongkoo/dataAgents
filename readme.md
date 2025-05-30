# LiDAR 360° Cluster Viewer

SICK LiDAR가 출력하는 Compact Format 데이터를 실시간으로 수집하고 시각화하는 Web 기반 클러스터 뷰어입니다.

---

## 환경 요구사항

- Python 3.7 이상 (권장: Python 3.10+)
- pip (패키지 관리자)
- 인터넷 브라우저

---

## 설치 및 실행

### MacOS

1. **Python 설치 유무 확인**
   ```bash
   python3 --version
   ```

2. **가상환경(선택 사항) 생성**
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```

3. **필수 패키지 설치**
   ```bash
   pip install aiohttp scikit-learn numpy
   ```

4. **서버 실행**
   ```bash
   python3 server.py
   ```

---

### Windows

1. **Python 설치 유무 확인**
   - 명령 프롬프트(CMD)에서:
     ```cmd
     python --version
     ```

2. **가상환경(선택 사항) 생성**
   ```cmd
   python -m venv venv
   venv\Scripts\activate
   ```

3. **필수 패키지 설치**
   ```cmd
   pip install aiohttp scikit-learn numpy
   ```

4. **서버 실행**
   ```cmd
   python server.py
   ```

---

## 접속 안내

| 항목 | 주소 |
|------|------|
| 웹 브라우저 (시각화 뷰어) | [http://localhost:3000](http://localhost:3000) |
| WebSocket 통신 주소 | `ws://localhost:3000/ws` |

> 센서 데이터가 수신되지 않으면 화면이 비어 있을 수 있습니다. UDP 포트가 열려 있는지 확인해주세요.

---

## 주요 라이브러리

- `aiohttp`: WebSocket 및 HTTP 서버 구현
- `scikit-learn`: DBSCAN 클러스터링
- `numpy`: 수치 계산 및 베터 처리

---

## 문제 해결

- **UDP 데이터가 수신되지 않음**: 라이다 장비의 대상 IP가 `localhost` 또는 현재 PC의 IP인지 확인

---

## 참고

- 데이터 형식에 대한 자세한 내용은 SICK에서 제공하는 관련 문서를 참고해주세요.
