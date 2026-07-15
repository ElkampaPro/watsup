const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { createApp } = require('../engine.js');

function makeRequest(port, requestPath, method = 'GET', token = null, body = null) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (token) headers['X-WatsUp-Token'] = token;
        if (body) headers['Content-Type'] = 'application/json';

        const request = http.request({
            hostname: '127.0.0.1',
            port,
            path: requestPath,
            method,
            headers
        }, (response) => {
            let rawBody = '';
            response.on('data', (chunk) => { rawBody += chunk; });
            response.on('end', () => {
                let parsedBody = rawBody;
                try { parsedBody = JSON.parse(rawBody); } catch (err) {}
                resolve({ statusCode: response.statusCode, body: parsedBody });
            });
        });

        request.on('error', reject);
        if (body) request.write(JSON.stringify(body));
        request.end();
    });
}

async function listen(app) {
    const server = http.createServer(app);
    const port = await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    return { server, port };
}

async function runBenchmark() {
    const token = 'a'.repeat(64);
    const mockState = { status: 'connected', userInfo: null, qrAvailable: false, groupsSynced: true };
    const mockContactsMap = new Map();

    const app = createApp({
        ipcToken: token,
        connectionState: mockState,
        contactsMap: mockContactsMap,
        getSock: () => ({
            sendMessage: async (jid, content) => {
                const stream = content.document.stream;
                await new Promise((resolve, reject) => {
                    stream.on('data', () => {});
                    stream.on('end', resolve);
                    stream.on('error', reject);
                });
                return { key: { id: 'msg_id' } };
            }
        })
    });

    const { server, port } = await listen(app);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-bench-'));
    const tempFile = path.join(tempDir, 'bench_10mb.bin');

    // Generate 10MB file
    const buffer = Buffer.alloc(1 * 1024 * 1024); // 1MB chunk
    const writeStream = fs.createWriteStream(tempFile);
    for (let i = 0; i < 10; i++) {
        writeStream.write(buffer);
    }
    await new Promise(r => writeStream.end(r));

    const durations = [];
    console.log('Running 5 benchmark rounds via Local API pipeline...');
    try {
        for (let round = 1; round <= 5; round++) {
            const start = process.hrtime.bigint();
            const res = await makeRequest(port, '/api/send', 'POST', token, {
                filePath: tempFile,
                recipient: '1234567890@s.whatsapp.net'
            });
            if (res.statusCode !== 200) {
                throw new Error(`API send failed with status ${res.statusCode}: ${JSON.stringify(res.body)}`);
            }
            const end = process.hrtime.bigint();
            const durationMs = Number(end - start) / 1_000_000;
            durations.push(durationMs);
            const speed = (10 / (durationMs / 1000)).toFixed(2);
            console.log(`Round ${round}: ${durationMs.toFixed(2)} ms (${speed} MB/s)`);
        }

        durations.sort((a, b) => a - b);
        const medianDuration = durations[2];
        const medianSpeed = (10 / (medianDuration / 1000)).toFixed(2);

        console.log('\n--- Pipeline Benchmark Results ---');
        console.log(`Median Duration: ${medianDuration.toFixed(2)} ms`);
        console.log(`Median Throughput: ${medianSpeed} MB/s`);
    } finally {
        // Cleanup
        try { fs.unlinkSync(tempFile); } catch (e) {}
        try { fs.rmdirSync(tempDir); } catch (e) {}
        await new Promise((resolve) => server.close(resolve));
    }
}

runBenchmark().catch(console.error);
