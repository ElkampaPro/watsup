const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp, formatJid, loadOrCreateToken } = require('./engine.js');

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

async function closeServer(server) {
    await new Promise((resolve) => server.close(resolve));
}

async function waitUntil(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test('formatJid accepts supported formats and rejects alphabetic manual input', () => {
    assert.equal(formatJid('213661834572'), '213661834572@s.whatsapp.net');
    assert.equal(formatJid('  +1 (234) 567-890  '), '1234567890@s.whatsapp.net');
    assert.equal(formatJid('213661834572@s.whatsapp.net'), '213661834572@s.whatsapp.net');
    assert.equal(formatJid('12345678-90123@g.us'), '12345678-90123@g.us');
    assert.equal(formatJid('12036320293029@g.us'), '12036320293029@g.us');
    assert.equal(formatJid('123456789@lid'), '123456789@lid');
    assert.equal(formatJid('abc123'), null);
    assert.equal(formatJid('john@gmail.com'), null);
    assert.equal(formatJid('12345'), null);
});

test('loadOrCreateToken replaces malformed tokens and fails when it cannot write', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-token-test-'));
    const testTokenPath = path.join(tempDirectory, '.watsup_ipc_token');

    try {
        for (const malformedToken of ['', 'abc123', 'z'.repeat(64)]) {
            fs.writeFileSync(testTokenPath, malformedToken, 'utf8');
            const generatedToken = loadOrCreateToken(testTokenPath);
            assert.match(generatedToken, /^[a-f0-9]{64}$/);
            assert.equal(fs.readFileSync(testTokenPath, 'utf8'), generatedToken);
        }

        const validToken = 'a'.repeat(64);
        fs.writeFileSync(testTokenPath, validToken, 'utf8');
        assert.equal(loadOrCreateToken(testTokenPath), validToken);

        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(testTokenPath).mode & 0o777, 0o600);
        }

        const unwritablePath = path.join(tempDirectory, 'missing-parent', 'token');
        assert.throws(() => loadOrCreateToken(unwritablePath), /Critical:/);
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

test('createApp instances isolate authorization, progress, and send locks', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-factory-test-'));
    const dummyPath = path.join(tempDirectory, 'payload.txt');
    fs.writeFileSync(dummyPath, 'factory isolation payload', 'utf8');

    const tokenA = 'a'.repeat(64);
    const tokenB = 'b'.repeat(64);
    const deferredA = createDeferred();
    let appACalls = 0;
    let appBCalls = 0;

    const appA = createApp({
        ipcToken: tokenA,
        connectionState: { status: 'connected' },
        getSock: () => ({
            sendMessage: async (jid, content) => {
                appACalls += 1;
                content.document.stream.resume();
                return deferredA.promise;
            }
        })
    });
    const appB = createApp({
        ipcToken: tokenB,
        connectionState: { status: 'connected' },
        getSock: () => ({
            sendMessage: async (jid, content) => {
                appBCalls += 1;
                content.document.stream.resume();
            }
        })
    });

    const listenerA = await listen(appA);
    const listenerB = await listen(appB);
    try {
        const requestA = makeRequest(listenerA.port, '/api/send', 'POST', tokenA, {
            filePath: dummyPath,
            recipient: '213661834572'
        });
        await waitUntil(() => appACalls === 1);

        const responseB = await makeRequest(listenerB.port, '/api/send', 'POST', tokenB, {
            filePath: dummyPath,
            recipient: '213661834572'
        });
        assert.equal(responseB.statusCode, 200, 'App B must not share App A send lock.');
        assert.equal(appBCalls, 1);

        const statusA = await makeRequest(listenerA.port, '/api/status', 'GET', tokenA);
        const statusB = await makeRequest(listenerB.port, '/api/status', 'GET', tokenB);
        assert.equal(statusA.body.uploadProgress.active, true);
        assert.equal(statusB.body.uploadProgress.active, false);

        const crossTokenResponse = await makeRequest(listenerB.port, '/api/status', 'GET', tokenA);
        assert.equal(crossTokenResponse.statusCode, 401);

        deferredA.resolve();
        assert.equal((await requestA).statusCode, 200);
    } finally {
        deferredA.resolve();
        await closeServer(listenerA.server);
        await closeServer(listenerB.server);
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

test('send lock survives rejected requests and releases after socket failure', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-lock-test-'));
    const dummyPath = path.join(tempDirectory, 'payload.txt');
    fs.writeFileSync(dummyPath, 'concurrency payload', 'utf8');

    const token = '1'.repeat(64);
    const deferredA = createDeferred();
    let sendCalls = 0;
    let sendImplementation = () => deferredA.promise;
    const app = createApp({
        ipcToken: token,
        connectionState: { status: 'connected' },
        getSock: () => ({
            sendMessage: async (...args) => {
                sendCalls += 1;
                args[1].document.stream.resume();
                return sendImplementation(...args);
            }
        })
    });
    const listener = await listen(app);

    const sendBody = { filePath: dummyPath, recipient: '213661834572' };
    try {
        const requestA = makeRequest(listener.port, '/api/send', 'POST', token, sendBody);
        await waitUntil(() => sendCalls === 1);

        const initialStatus = await makeRequest(listener.port, '/api/status', 'GET', token);
        assert.equal(initialStatus.body.uploadProgress.active, true);
        assert.equal(initialStatus.body.uploadProgress.fileName, 'payload.txt');
        assert.equal(initialStatus.body.uploadProgress.totalBytes, fs.statSync(dummyPath).size);

        const responseB = await makeRequest(listener.port, '/api/send', 'POST', token, sendBody);
        const responseC = await makeRequest(listener.port, '/api/send', 'POST', token, sendBody);
        assert.equal(responseB.statusCode, 409);
        assert.equal(responseC.statusCode, 409);

        const validationFailure = await makeRequest(listener.port, '/api/send', 'POST', token, {
            filePath: path.join(tempDirectory, 'missing.txt'),
            recipient: '213661834572'
        });
        assert.equal(validationFailure.statusCode, 400);

        const statusAfterRejectedRequests = await makeRequest(listener.port, '/api/status', 'GET', token);
        assert.equal(statusAfterRejectedRequests.body.uploadProgress.active, true);
        assert.equal(statusAfterRejectedRequests.body.uploadProgress.fileName, initialStatus.body.uploadProgress.fileName);
        assert.equal(statusAfterRejectedRequests.body.uploadProgress.totalBytes, initialStatus.body.uploadProgress.totalBytes);
        assert.equal(sendCalls, 1);

        deferredA.reject(new Error('Mock socket failure'));
        const failedA = await requestA;
        assert.equal(failedA.statusCode, 500);

        const statusAfterFailure = await makeRequest(listener.port, '/api/status', 'GET', token);
        assert.equal(statusAfterFailure.body.uploadProgress.active, false);

        sendImplementation = async () => {};
        const responseD = await makeRequest(listener.port, '/api/send', 'POST', token, sendBody);
        assert.equal(responseD.statusCode, 200);
        assert.equal(sendCalls, 2);

        const missingTokenResponse = await makeRequest(listener.port, '/api/status');
        const wrongTokenResponse = await makeRequest(listener.port, '/api/status', 'GET', 'short');
        assert.equal(missingTokenResponse.statusCode, 401);
        assert.equal(wrongTokenResponse.statusCode, 401);
    } finally {
        deferredA.resolve();
        await closeServer(listener.server);
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});
