const express = require('express');
const http = require('http');
const { OPCUAClient, NodeId } = require('node-opcua');
const cors = require('cors');
const dotenv = require('dotenv');

// 환경 변수 로드
dotenv.config();

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

// OPC UA 노드 ID 설정
const nodeId = new NodeId(108, 4); // Heartbeat BIT0 데이터 (ns=4; i=108)
const endpointUrl = "opc.tcp://192.168.0.102:4840"; // PLC의 OPC UA 주소

let session;
let client;

// 미들웨어 설정
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function initOPCUA() {
  try {
    client = OPCUAClient.create({ endpoint_must_exist: false });
    
    // 연결 상태 변경 이벤트 리스너
    client.on("connection_lost", () => {
      console.error(`[${new Date().toISOString()}] OPC UA 연결 끊김`);
    });
    
    client.on("connection_reestablished", () => {
      console.log(`[${new Date().toISOString()}] OPC UA 연결 재설정됨`);
    });
    
    await client.connect(endpointUrl);
    session = await client.createSession();
    console.log(`[${new Date().toISOString()}] OPC UA 연결됨`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] OPC UA 연결 오류: ${err.message}`);
  }
}

async function readPLCData() {
  try {
    const dataValue = await session.readVariableValue(nodeId);
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
      connected: client ? client.isConnected() : false,
      sessionActive: session ? !session.isClosed() : false,
      endpointUrl: endpointUrl
    };
    
    console.log(`[${new Date().toISOString()}] 통신 상태:`, {
      연결상태: status.connected ? '연결됨' : '연결안됨',
      세션상태: status.sessionActive ? '활성화' : '비활성화',
      서버주소: status.endpointUrl
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
