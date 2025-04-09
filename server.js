const express = require('express');
const http = require('http');
const { OPCUAClient, AttributeIds, makeNodeId } = require("node-opcua");
const cors = require('cors');
const dotenv = require('dotenv');

// 환경 변수 로드
dotenv.config();

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

// OPC UA 노드 ID 설정
const nodeId = makeNodeId(108, 4); // ns=4;i=108
const endpointUrl = "opc.tcp://192.168.0.102:4840"; // PLC의 OPC UA 주소

let session;
let client;
let isConnected = false;
let retryCount = 0;
const MAX_RETRIES = 5;

// 미들웨어 설정
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function initOPCUA() {
  try {
    if (client) {
      await client.disconnect();
    }

    client = OPCUAClient.create({
      endpointMustExist: true, // <-- 수정됨
      connectionStrategy: {
        maxRetry: MAX_RETRIES,
        initialDelay: 2000,
        maxDelay: 10 * 1000
      },
      keepSessionAlive: true,
      securityMode: 1,
      securityPolicy: "None"
    });
    
    // 연결 상태 변경 이벤트 리스너
    client.on("connection_lost", () => {
      isConnected = false;
      console.error(`[${new Date().toISOString()}] OPC UA 연결 끊김`);
    });
    
    client.on("connection_reestablished", () => {
      isConnected = true;
      console.log(`[${new Date().toISOString()}] OPC UA 연결 재설정됨`);
    });

    client.on("backoff", (retry, delay) => {
      console.log(`[${new Date().toISOString()}] 재연결 시도 ${retry}/${MAX_RETRIES}, ${delay}ms 후 재시도`);
    });
    
    console.log(`[${new Date().toISOString()}] OPC UA 서버에 연결 시도 중... (${endpointUrl})`);
    await client.connect(endpointUrl);
    
    console.log(`[${new Date().toISOString()}] 세션 생성 중...`);
    session = await client.createSession({
      requestedSessionTimeout: 60000
    });
    
    isConnected = true;
    retryCount = 0;
    console.log(`[${new Date().toISOString()}] OPC UA 연결됨`);
    
    // 연결 후 첫 데이터 읽기 시도
    await readPLCData();
  } catch (err) {
    isConnected = false;
    retryCount++;
    console.error(`[${new Date().toISOString()}] OPC UA 연결 오류: ${err.message}`);
    
    if (retryCount < MAX_RETRIES) {
      console.log(`[${new Date().toISOString()}] ${retryCount}초 후 재연결 시도...`);
      setTimeout(initOPCUA, retryCount * 1000);
    }
  }
}

async function readPLCData() {
  try {
    if (!isConnected || !session) {
      throw new Error('OPC UA 연결이 되어있지 않습니다');
    }
    
    console.log(`[${new Date().toISOString()}] 노드 ${nodeId.toString()}에서 데이터 읽기 시도`);
    const dataValue = await session.read({
      nodeId: nodeId,
      attributeId: AttributeIds.Value
    });
    
    console.log(`[${new Date().toISOString()}] 읽은 데이터:`, {
      값: dataValue.value.value,
      타입: dataValue.value.dataType.toString(),
      상태: dataValue.statusCode.toString(),
      타임스탬프: dataValue.serverTimestamp
    });
    
    return dataValue.value.value;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] 데이터 읽기 오류: ${err.message}`);
    throw err;
  }
}

// 통신 상태 확인
async function checkConnectionStatus() {
  try {
    const status = {
      connected: isConnected,
      sessionActive: session ? !session.isClosed() : false,
      endpointUrl: endpointUrl,
      retryCount: retryCount
    };
    
    console.log(`[${new Date().toISOString()}] 통신 상태:`, {
      연결상태: status.connected ? '연결됨' : '연결안됨',
      세션상태: status.sessionActive ? '활성화' : '비활성화',
      서버주소: status.endpointUrl,
      재시도횟수: status.retryCount
    });
    
    if (!status.connected || !status.sessionActive) {
      console.log(`[${new Date().toISOString()}] 재연결 시도 중...`);
      await initOPCUA();
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] 상태 확인 오류: ${err.message}`);
  }
}

// PLC 데이터 수집 및 로깅
async function startDataCollection() {
  try {
    const value = await readPLCData();
    console.log(`[${new Date().toISOString()}] Heartbeat 상태: ${value ? 'ON' : 'OFF'}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] 데이터 수집 오류: ${err.message}`);
  }
}

// 1초마다 데이터 수집
setInterval(startDataCollection, 1000);

// 5초마다 통신 상태 확인
setInterval(checkConnectionStatus, 5000);

// 기본 라우트
app.get('/', (req, res) => {
  res.json({ message: 'Network Agents Server is running!' });
});

server.listen(port, async () => {
  await initOPCUA();
  console.log(`[${new Date().toISOString()}] Server is running on port ${port}`);
  console.log(`[${new Date().toISOString()}] Heartbeat 데이터 수집 시작...`);
});
