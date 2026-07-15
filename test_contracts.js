const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

// Helper to wait until a condition is met
async function waitUntil(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for contract condition.');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

// Helper to perform HTTP requests
function makeRequest(port, requestPath, method = 'GET', token = null, body = null) {
    return new Promise((resolve, reject) => {
        const headers = { 'Connection': 'close' };
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

async function closeServer(server) {
    await new Promise((resolve) => server.close(resolve));
}

// 1. Import Safety Test (Runs in fresh child process, mocks and verifies umask/file operations)
test('Importing engine.js does not change umask, create files, or bind ports in a fresh process', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-contract-import-'));
    const absoluteEnginePath = path.resolve(__dirname, 'engine.js').replace(/\\/g, '/');

    const script = `
        const fs = require('fs');
        const http = require('http');
        const path = require('path');
        const initialUmask = process.umask ? process.umask() : 0;
        let fileCreated = false;
        let dirCreated = false;
        let serverListening = false;
        const origWrite = fs.writeFileSync;
        fs.writeFileSync = (...args) => {
            fileCreated = true;
            return origWrite(...args);
        };
        const origMkdir = fs.mkdirSync;
        fs.mkdirSync = (...args) => {
            dirCreated = true;
            return origMkdir(...args);
        };
        const origListen = http.Server.prototype.listen;
        http.Server.prototype.listen = (...args) => {
            serverListening = true;
            return origListen(...args);
        };
        require('${absoluteEnginePath}');
        const finalUmask = process.umask ? process.umask() : 0;
        console.log(JSON.stringify({
            umaskMatches: initialUmask === finalUmask,
            fileCreated,
            dirCreated,
            serverListening
        }));
    `;

    try {
        const resultObj = cp.spawnSync(process.execPath, ['-e', script], {
            cwd: tempDir,
            encoding: 'utf8'
        });

        assert.equal(resultObj.status, 0, 'Exit status of the child process must be 0');
        const result = JSON.parse(resultObj.stdout.trim());
        assert.equal(result.umaskMatches, true, 'Umask must remain unchanged');
        assert.equal(result.fileCreated, false, 'No files must be created upon import');
        assert.equal(result.dirCreated, false, 'No directories must be created upon import');
        assert.equal(result.serverListening, false, 'No network ports must be opened upon import');
    } finally {
        try { fs.rmdirSync(tempDir); } catch (e) {}
    }
});

// 2. Concurrency, Locking, Isolation, and Error Release Test
test('createApp instances isolate progress and locks, and handle exceptions release rules', async () => {
    const { createApp } = require('./engine.js');
    const token1 = 'a'.repeat(64);
    const token2 = 'b'.repeat(64);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-contract-'));
    const dummyFile = path.join(tempDir, 'payload.bin');
    fs.writeFileSync(dummyFile, 'dummy content', 'utf8');

    // Controls for app1's socket sendMessage
    let resolveSendMessage;
    let rejectSendMessage;
    let sendMessagePromise = new Promise((resolve, reject) => {
        resolveSendMessage = resolve;
        rejectSendMessage = reject;
    });

    const state1 = { status: 'connected', userInfo: null, qrAvailable: false, groupsSynced: false };
    const state2 = { status: 'connected', userInfo: null, qrAvailable: false, groupsSynced: false };

    const app1 = createApp({
        ipcToken: token1,
        connectionState: state1,
        cachePath: path.join(tempDir, 'contacts_cache_1.json'),
        deleteAuthFolder: () => {},
        fetchGroupsList: async () => [],
        getSock: () => ({
            sendMessage: async (jid, content) => {
                const stream = content.document.stream;
                await new Promise((resolve, reject) => {
                    stream.on('data', () => {});
                    stream.on('end', resolve);
                    stream.on('error', reject);
                });
                await sendMessagePromise;
                return { key: { id: 'msg_id_1' } };
            }
        })
    });

    const app2 = createApp({
        ipcToken: token2,
        connectionState: state2,
        cachePath: path.join(tempDir, 'contacts_cache_2.json'),
        deleteAuthFolder: () => {},
        fetchGroupsList: async () => [],
        getSock: () => ({
            sendMessage: async (jid, content) => {
                const stream = content.document.stream;
                await new Promise((resolve, reject) => {
                    stream.on('data', () => {});
                    stream.on('end', resolve);
                    stream.on('error', reject);
                });
                return { key: { id: 'msg_id_2' } };
            }
        })
    });

    const s1 = await listen(app1);
    const s2 = await listen(app2);

    let sendPromise1;

    try {
        // Start long-running send on App1 (Blocks on sendMessagePromise)
        sendPromise1 = makeRequest(s1.port, '/api/send', 'POST', token1, {
            filePath: dummyFile,
            recipient: '1234567890@s.whatsapp.net'
        });

        // Wait until App1 finishes streaming and enters awaiting_confirmation phase
        await waitUntil(async () => {
            const status = await makeRequest(s1.port, '/api/status', 'GET', token1);
            return status.body.uploadProgress.phase === 'awaiting_confirmation';
        });

        // Assert App1 progress structure snapshot matches schema and phase
        const status1 = await makeRequest(s1.port, '/api/status', 'GET', token1);
        assert.equal(status1.body.uploadProgress.phase, 'awaiting_confirmation');
        assert.equal(status1.body.uploadProgress.fileName, 'payload.bin');
        assert.equal(status1.body.uploadProgress.totalBytes, 13);

        // Capture snapshot before subsequent requests B/C and validation failure
        const snapshot = { ...status1.body.uploadProgress };

        // Assert App2 is not locked or affected (Complete Isolation)
        const status2 = await makeRequest(s2.port, '/api/status', 'GET', token2);
        assert.equal(status2.body.uploadProgress.active, false);

        // Perform instant successful send on App2 while App1 is locked
        const send2 = await makeRequest(s2.port, '/api/send', 'POST', token2, {
            filePath: dummyFile,
            recipient: '1987654321@s.whatsapp.net'
        });
        assert.equal(send2.statusCode, 200, 'App2 must successfully complete send operation');

        // Concurrent request on App1 must fail with 409 Conflict
        const concurrentRes = await makeRequest(s1.port, '/api/send', 'POST', token1, {
            filePath: dummyFile,
            recipient: '1234567890@s.whatsapp.net'
        });
        assert.equal(concurrentRes.statusCode, 409, 'Concurrent upload request on locked instance must yield 409');

        // Validation failure (e.g. payload > 10kb) on App1 must NOT release App1's active lock
        const largeBody = { filePath: dummyFile, recipient: '1234567890@s.whatsapp.net', junk: 'a'.repeat(20 * 1024) };
        const oversizedRes = await makeRequest(s1.port, '/api/send', 'POST', token1, largeBody);
        assert.equal(oversizedRes.statusCode, 413, 'Oversized body must return 413');

        // Verify lock is still held after validation failure
        const concurrentResAfterFail = await makeRequest(s1.port, '/api/send', 'POST', token1, {
            filePath: dummyFile,
            recipient: '1234567890@s.whatsapp.net'
        });
        assert.equal(concurrentResAfterFail.statusCode, 409, 'Lock must be preserved after validation failure');

        // Verify that A's progress snapshot remains unchanged
        const status1AfterRequests = await makeRequest(s1.port, '/api/status', 'GET', token1);
        const snapshotAfter = status1AfterRequests.body.uploadProgress;
        assert.equal(snapshotAfter.active, snapshot.active);
        assert.equal(snapshotAfter.fileName, snapshot.fileName);
        assert.equal(snapshotAfter.bytesSent, snapshot.bytesSent);
        assert.equal(snapshotAfter.totalBytes, snapshot.totalBytes);
        assert.equal(snapshotAfter.phase, snapshot.phase);

        // Fail the active socket operation to test exception rollback release logic
        rejectSendMessage(new Error('Mock socket failure'));

        const resA = await sendPromise1;
        assert.equal(resA.statusCode, 500, 'Request A must return HTTP 500 when mock socket fails');

        // Wait for lock release state
        await waitUntil(async () => {
            const status = await makeRequest(s1.port, '/api/status', 'GET', token1);
            return status.body.uploadProgress.active === false;
        });

        const status1AfterRelease = await makeRequest(s1.port, '/api/status', 'GET', token1);
        assert.equal(status1AfterRelease.body.uploadProgress.phase, 'failed');
        assert.equal(status1AfterRelease.body.uploadProgress.active, false, 'Socket exception must release the upload lock');

        // Verify a new Request D succeeds now that the lock is released
        sendMessagePromise = Promise.resolve(); // Immediately complete this time
        const sendD = await makeRequest(s1.port, '/api/send', 'POST', token1, {
            filePath: dummyFile,
            recipient: '1234567890@s.whatsapp.net'
        });
        assert.equal(sendD.statusCode, 200, 'Subsequent upload must succeed after lock is released');
    } finally {
        // Guaranteed unblocking of any pending promises to prevent teardown deadlocks
        if (resolveSendMessage) {
            try { resolveSendMessage(); } catch (e) {}
        }
        if (sendPromise1) {
            try { await sendPromise1; } catch (e) {}
        }

        // Guaranteed cleanups of servers and files
        await closeServer(s1.server);
        await closeServer(s2.server);
        try { fs.unlinkSync(dummyFile); } catch (e) {}
        try { fs.unlinkSync(path.join(tempDir, 'contacts_cache_1.json')); } catch (e) {}
        try { fs.unlinkSync(path.join(tempDir, 'contacts_cache_2.json')); } catch (e) {}
        try { fs.rmdirSync(tempDir); } catch (e) {}
    }
});

// 3. API Contracts Verification (Schemas, status codes, structures, auth checking, and stubs)
test('API contracts for payload schemas, inputs, and logout stubs verification', async () => {
    const { createApp } = require('./engine.js');
    const token = 'c'.repeat(64);
    const mockState = { status: 'connected', userInfo: null, qrAvailable: false, groupsSynced: true };
    const mockContactsMap = new Map();
    mockContactsMap.set('123456@s.whatsapp.net', { id: '123456@s.whatsapp.net', name: 'Contact A' });

    let logoutCalled = 0;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-contract-api-'));

    const app = createApp({
        ipcToken: token,
        connectionState: mockState,
        contactsMap: mockContactsMap,
        cachePath: path.join(tempDir, 'contacts_cache.json'),
        deleteAuthFolder: () => {
            logoutCalled += 1;
        },
        fetchGroupsList: async () => [],
        getSock: () => ({})
    });

    const { server, port } = await listen(app);

    try {
        // Auth gate tests
        const unauthorizedRes = await makeRequest(port, '/api/status', 'GET', 'invalid_token_pattern_here');
        assert.equal(unauthorizedRes.statusCode, 401);

        // Payload checks
        const contactsRes = await makeRequest(port, '/api/contacts', 'GET', token);
        assert.equal(contactsRes.statusCode, 200);
        assert.ok(Array.isArray(contactsRes.body));
        assert.equal(contactsRes.body[0].id, '123456@s.whatsapp.net');
        assert.equal(contactsRes.body[0].name, 'Contact A');

        // Status checking
        const statusRes = await makeRequest(port, '/api/status', 'GET', token);
        assert.equal(statusRes.statusCode, 200);
        assert.equal(statusRes.body.status, 'connected');
        assert.equal(statusRes.body.qrAvailable, false);
        assert.ok(statusRes.body.uploadProgress);
        assert.equal(typeof statusRes.body.uploadProgress.active, 'boolean');
        assert.equal(typeof statusRes.body.uploadProgress.fileName, 'string');
        assert.equal(typeof statusRes.body.uploadProgress.bytesSent, 'number');
        assert.equal(typeof statusRes.body.uploadProgress.totalBytes, 'number');
        assert.equal(typeof statusRes.body.uploadProgress.percentage, 'number');
        assert.equal(typeof statusRes.body.uploadProgress.phase, 'string');

        // Verify logout stub call increments the call counter
        const logoutRes = await makeRequest(port, '/api/logout', 'POST', token, {});
        assert.equal(logoutRes.statusCode, 200);
        assert.equal(logoutCalled, 1, 'Logout endpoint must invoke deleteAuthFolder injected stub exactly once');
    } finally {
        await closeServer(server);
        try { fs.unlinkSync(path.join(tempDir, 'contacts_cache.json')); } catch (e) {}
        try { fs.rmdirSync(tempDir); } catch (e) {}
    }
});
