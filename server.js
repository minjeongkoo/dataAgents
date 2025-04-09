const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { OPCUAClient } = require('node-opcua');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const endpointUrl = "opc.tcp://192.168.0.5:4840"; // PLC의 OPC UA 주소
const nodeId = "ns=1;s=Temperature"; // 수집할 데이터 노드 ID

let session;

async function initOPCUA() {
  const client = OPCUAClient.create({ endpoint_must_exist: false });
  await client.connect(endpointUrl);
  session = await client.createSession();
  console.log("OPC UA 연결됨");
}

async function readPLCData() {
  const dataValue = await session.readVariableValue(nodeId);
  return dataValue.value.value;
}

wss.on('connection', (ws) => {
  console.log('Vue 클라이언트 연결됨');

  const interval = setInterval(async () => {
    try {
      const value = await readPLCData();
      ws.send(JSON.stringify({ value }));
    } catch (err) {
      ws.send(JSON.stringify({ error: err.message }));
    }
  }, 1000); // 1초 주기

  ws.on('close', () => {
    console.log('클라이언트 연결 종료');
    clearInterval(interval);
  });
});

app.get('/', (req, res) => res.send('OPC UA WebSocket Server Running'));

server.listen(3000, async () => {
  await initOPCUA();
  console.log('서버 실행 중: http://localhost:3000');
});
