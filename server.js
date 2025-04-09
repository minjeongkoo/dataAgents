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
const nodeId = new NodeId(92, 4); // 네임스페이스 4의 노드 92
const endpointUrl = "opc.tcp://192.168.0.102:4840"; // PLC의 OPC UA 주소

let session;

// 미들웨어 설정
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function initOPCUA() {
  try {
    const client = OPCUAClient.create({ endpoint_must_exist: false });
    await client.connect(endpointUrl);
    session = await client.createSession();
    console.log("OPC UA 연결됨");
  } catch (err) {
    console.error("OPC UA 연결 오류:", err.message);
  }
}

async function readPLCData() {
  try {
    const dataValue = await session.readVariableValue(nodeId);
    return dataValue.value.value;
  } catch (err) {
    console.error("데이터 읽기 오류:", err.message);
    throw err;
  }
}

// PLC 데이터 수집 및 로깅
async function startDataCollection() {
  try {
    const value = await readPLCData();
    console.log(`[${new Date().toISOString()}] PLC 데이터: ${value}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] 데이터 수집 오류: ${err.message}`);
  }
}

// 1초마다 데이터 수집
setInterval(startDataCollection, 1000);

// 기본 라우트
app.get('/', (req, res) => {
  res.json({ message: 'Network Agents Server is running!' });
});

server.listen(port, async () => {
  await initOPCUA();
  console.log(`Server is running on port ${port}`);
  console.log('PLC 데이터 수집 시작...');
});
