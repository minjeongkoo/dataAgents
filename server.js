const express = require('express');
const http = require('http');
const { OPCUAClient, AttributeIds, makeNodeId } = require("node-opcua");
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

// OPC UA 엔드포인트
const endpointUrl = "opc.tcp://192.168.0.102:4840";

// 모니터링할 노드 리스트
const monitoredNodes = [
  { name: "붐 선회 속도", nodeId: makeNodeId(92, 4), type: "INT" },
  { name: "Heartbeat", nodeId: makeNodeId(108, 4), type: "BIT" },
  { name: "크레인 컨트롤 켜짐", nodeId: makeNodeId(109, 4), type: "BIT" },
  { name: "충돌방지 바이패스 켜짐", nodeId: makeNodeId(112, 4), type: "BIT" },
  { name: "충돌방지 켜짐", nodeId: makeNodeId(113, 4), type: "BIT" },
  { name: "비상정지(시스템에러)", nodeId: makeNodeId(114, 4), type: "BIT" },
  { name: "3D 라이다 차단기 에러", nodeId: makeNodeId(116, 4), type: "BIT" },
  { name: "크레인 PLC 통신 에러", nodeId: makeNodeId(124, 4), type: "BIT" }
];

let client;
let session;
let isConnected = false;
let retryCount = 0;
const MAX_RETRIES = 5;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OPC UA 초기화
async function initOPCUA() {
  try {
    if (client) {
      await client.disconnect();
    }

    client = OPCUAClient.create({
      endpointMustExist: true,
      connectionStrategy: {
        maxRetry: MAX_RETRIES,
        initialDelay: 2000,
        maxDelay: 10 * 1000
      },
      keepSessionAlive: true,
      securityMode: 1,
      securityPolicy: "None"
    });

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

    await readAllPLCData();
  } catch (err) {
    isConnected = false;
    retryCount++;
    console.error(`[${new Date().toISOString()}] OPC UA 연결 오류: ${err.message}`);
    if (retryCount < MAX_RETRIES) {
      setTimeout(initOPCUA, retryCount * 1000);
    }
  }
}

// 모든 PLC 데이터 읽기
async function readAllPLCData() {
  if (!isConnected || !session) {
    throw new Error("OPC UA 연결이 되어있지 않습니다");
  }

  const results = [];

  for (const item of monitoredNodes) {
    try {
      const dataValue = await session.read({
        nodeId: item.nodeId,
        attributeId: AttributeIds.Value
      });

      const value = dataValue.value.value;

      results.push({
        이름: item.name,
        값: value,
        상태: dataValue.statusCode.toString(),
        타임스탬프: dataValue.serverTimestamp
      });
    } catch (err) {
      results.push({
        이름: item.name,
        오류: err.message
      });
    }
  }

  return results;
}

// 주기적인 데이터 수집
async function startDataCollection() {
  try {
    const dataList = await readAllPLCData();
    console.log(`[${new Date().toISOString()}] PLC 데이터 수집 결과:`);
    for (const data of dataList) {
      console.log(data);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] 데이터 수집 오류: ${err.message}`);
  }
}

// 연결 상태 점검
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

// API 라우트
app.get('/', (req, res) => {
  res.json({ message: 'Network Agents Server is running!' });
});

app.get('/plc-data', async (req, res) => {
  try {
    const data = await readAllPLCData();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 서버 시작
server.listen(port, async () => {
  await initOPCUA();
  console.log(`[${new Date().toISOString()}] Server is running on port ${port}`);
  console.log(`[${new Date().toISOString()}] PLC 데이터 수집 시작...`);

  setInterval(startDataCollection, 1000);   // 1초마다 데이터 수집
  setInterval(checkConnectionStatus, 5000); // 5초마다 상태 확인
});
