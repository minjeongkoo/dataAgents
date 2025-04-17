@echo off
echo [Windows] Node.js 서버 실행 중...
start "" /B node server.js

echo Python 파서 실행 중...
start "" /B python parser.py

echo 모든 서비스 실행 완료!
pause