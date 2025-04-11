const dgram = require('dgram');
const SickParser = require('./sickParser');

class LidarReceiver {
    constructor(ip = '169.254.193.67', port = 2122) {
        this.ip = ip;
        this.port = port;
        this.parser = new SickParser();
        this.socket = null;
        this.isConnected = false;
    }

    init() {
        try {
            this.socket = dgram.createSocket('udp4');
            
            this.socket.on('error', (err) => {
                console.error(`[${new Date().toISOString()}] Lidar UDP 소켓 오류: ${err.message}`);
                this.isConnected = false;
            });

            this.socket.on('message', (msg, rinfo) => {
                const parsedData = this.parser.parseData(msg);
                if (parsedData) {
                    this.emitData(parsedData);
                }
            });

            this.socket.on('listening', () => {
                const address = this.socket.address();
                console.log(`[${new Date().toISOString()}] Lidar UDP 수신기 시작됨: ${address.address}:${address.port}`);
                this.isConnected = true;
            });

            this.socket.bind(this.port);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Lidar 초기화 오류: ${error.message}`);
            this.isConnected = false;
        }
    }

    emitData(data) {
        // 여기에 데이터 처리 로직 추가
        console.log(`[${new Date().toISOString()}] Lidar 데이터 수신:`, data);
    }

    close() {
        if (this.socket) {
            this.socket.close();
            this.isConnected = false;
            console.log(`[${new Date().toISOString()}] Lidar UDP 수신기 종료됨`);
        }
    }
}

module.exports = LidarReceiver; 