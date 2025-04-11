const { OPCUAClient, AttributeIds, makeNodeId } = require("node-opcua");

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

    await client.connect(endpointUrl);
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
        n: item.name,
        v: value,
        s: dataValue.statusCode.toString(),
        t: dataValue.serverTimestamp
      });
    } catch (err) {
      results.push({
        n: item.name,
        e: err.message
      });
    }
  }

  return results;
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

    if (!status.connected || !status.sessionActive) {
      console.log(`[${new Date().toISOString()}] 재연결 시도 중...`);
      await initOPCUA();
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] 상태 확인 오류: ${err.message}`);
  }
}

module.exports = {
  initOPCUA,
  readAllPLCData,
  checkConnectionStatus,
  isConnected
}; 