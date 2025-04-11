class SickParser {
    constructor() {
        this.START_BYTE = 0x02;
        this.END_BYTE = 0x03;
    }

    parseData(data) {
        try {
            // 데이터 버퍼 확인
            if (!Buffer.isBuffer(data)) {
                throw new Error('Invalid data format: expected Buffer');
            }

            // 시작/종료 바이트 확인
            if (data[0] !== this.START_BYTE || data[data.length - 1] !== this.END_BYTE) {
                throw new Error('Invalid data format: missing start/end bytes');
            }

            // 데이터 길이 추출
            const dataLength = data.readUInt16LE(1);
            
            // 실제 데이터 부분 추출
            const payload = data.slice(3, 3 + dataLength);
            
            // 데이터 파싱
            const parsedData = {
                timestamp: new Date().toISOString(),
                dataLength: dataLength,
                payload: payload,
                rawData: data
            };

            return parsedData;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] SICK 데이터 파싱 오류: ${error.message}`);
            return null;
        }
    }
}

module.exports = SickParser; 