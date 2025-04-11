const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const { initPLC, readAllPLCData, checkPLCConnection } = require('./plc');
const LidarReceiver = require('./lidar');

dotenv.config();

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

// 데이터 수집 모드 설정
const dataCollectionMode = process.env.DATA_COLLECTION_MODE || 'both';
console.log(`[${new Date().toISOString()}] 데이터 수집 모드: ${dataCollectionMode}`);

// Lidar 수신기 초기화 (lidar 또는 both 모드일 때만)
let lidarReceiver;
if (dataCollectionMode === 'lidar' || dataCollectionMode === 'both') {
    lidarReceiver = new LidarReceiver(
        process.env.LIDAR_IP,
        parseInt(process.env.LIDAR_PORT)
    );
    lidarReceiver.init();
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 주기적인 PLC 데이터 수집 (plc 또는 both 모드일 때만)
async function startPLCDataCollection() {
    if (dataCollectionMode === 'plc' || dataCollectionMode === 'both') {
        try {
            const dataList = await readAllPLCData();
            console.log(`[${new Date().toISOString()}] PLC 데이터 수집 결과:`);
            for (const data of dataList) {
                console.log(data);
            }
        } catch (err) {
            console.error(`[${new Date().toISOString()}] PLC 데이터 수집 오류: ${err.message}`);
        }
    }
}

// API 라우트
app.get('/', (req, res) => {
    res.json({ 
        message: 'Network Agents Server is running!',
        status: {
            mode: dataCollectionMode,
            plc: { 
                connected: dataCollectionMode === 'plc' || dataCollectionMode === 'both' ? isConnected : null,
                enabled: dataCollectionMode === 'plc' || dataCollectionMode === 'both'
            },
            lidar: { 
                connected: dataCollectionMode === 'lidar' || dataCollectionMode === 'both' ? lidarReceiver?.isConnected : null,
                enabled: dataCollectionMode === 'lidar' || dataCollectionMode === 'both'
            }
        }
    });
});

app.get('/plc-data', async (req, res) => {
    if (dataCollectionMode === 'plc' || dataCollectionMode === 'both') {
        try {
            const data = await readAllPLCData();
            res.json({ success: true, data });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    } else {
        res.status(400).json({ success: false, message: 'PLC 데이터 수집이 비활성화되어 있습니다' });
    }
});

// 서버 시작
server.listen(port, async () => {
    if (dataCollectionMode === 'plc' || dataCollectionMode === 'both') {
        await initPLC();
    }
    console.log(`[${new Date().toISOString()}] Server is running on port ${port}`);

    if (dataCollectionMode === 'plc' || dataCollectionMode === 'both') {
        setInterval(startPLCDataCollection, 1000);   // 1초마다 PLC 데이터 수집
        setInterval(checkPLCConnection, 5000);       // 5초마다 PLC 상태 확인
    }
});
