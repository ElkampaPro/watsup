const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
    createApp,
    formatJid,
    loadOrCreateToken,
    secureAtomicWriteFile,
    secureAtomicWriteJson,
    writeQrSecurely,
    enforceSecurePermissions,
    fetchGroupsList,
    rotateEngineLog,
    formatErrorBriefly,
    getSocketGeneration,
    setSocketGeneration,
    getLastSyncedGeneration,
    setLastSyncedGeneration,
    getCurrentGroupSyncPromise,
    getCurrentGroupSyncPromiseGen,
    setCurrentGroupSyncPromiseGen,
    setSock,
    getConnectionState
} = require('./engine.js');

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

test('all /api/* endpoints reject requests with missing or invalid token with 401', async () => {
    const token = 'c'.repeat(64);
    const app = createApp({
        ipcToken: token,
        connectionState: { status: 'connected' },
        getSock: () => ({})
    });
    const { server, port } = await listen(app);
    try {
        const endpoints = [
            { path: '/api/status', method: 'GET', body: null },
            { path: '/api/contacts', method: 'GET', body: null },
            { path: '/api/logout', method: 'POST', body: {} },
            { path: '/api/send', method: 'POST', body: { filePath: 'foo.txt', recipient: '123' } }
        ];
        for (const ep of endpoints) {
            // 1. Missing token
            const res1 = await makeRequest(port, ep.path, ep.method, null, ep.body);
            assert.equal(res1.statusCode, 401, `Endpoint ${ep.path} must reject missing token`);

            // 2. Invalid token
            const res2 = await makeRequest(port, ep.path, ep.method, 'invalid_token_here', ep.body);
            assert.equal(res2.statusCode, 401, `Endpoint ${ep.path} must reject invalid token`);
        }
    } finally {
        await closeServer(server);
    }
});

test('JSON payload exceeding 10kb is rejected with 413 Payload Too Large', async () => {
    const token = 'd'.repeat(64);
    const app = createApp({
        ipcToken: token,
        connectionState: { status: 'connected' },
        getSock: () => ({})
    });
    const { server, port } = await listen(app);
    try {
        // Create a body larger than 10kb
        const heavyBody = { data: 'x'.repeat(11 * 1024) };
        const res = await makeRequest(port, '/api/send', 'POST', token, heavyBody);
        assert.equal(res.statusCode, 413);
        assert.deepEqual(res.body, {
            success: false,
            error: 'Payload Too Large: Maximum allowed size is 10kb'
        });
    } finally {
        await closeServer(server);
    }
});

test('importing engine.js does not change umask, create files, or bind ports in a fresh process', () => {
    const cp = require('child_process');
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
        require('./engine.js');
        const finalUmask = process.umask ? process.umask() : 0;
        console.log(JSON.stringify({
            umaskMatches: initialUmask === finalUmask,
            fileCreated,
            dirCreated,
            serverListening
        }));
    `;
    const output = cp.execSync('node -e "' + script.replace(/"/g, '\\"').replace(/\n/g, ' ') + '"', { encoding: 'utf8' }).trim();
    const result = JSON.parse(output);
    assert.equal(result.umaskMatches, true);
    assert.equal(result.fileCreated, false);
    assert.equal(result.dirCreated, false);
    assert.equal(result.serverListening, false);
});

test('failure to apply chmod on token or credentials directory propagates error to fail startup', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-chmod-test-'));
    const testTokenPath = path.join(tempDirectory, '.watsup_ipc_token');
    fs.writeFileSync(testTokenPath, 'e'.repeat(64), 'utf8');

    const originalChmod = fs.chmodSync;
    fs.chmodSync = (filePath, mode) => {
        if (filePath === testTokenPath || filePath === tempDirectory) {
            throw new Error('Chmod failed on simulated locked file');
        }
        return originalChmod(filePath, mode);
    };

    try {
        assert.throws(() => loadOrCreateToken(testTokenPath), /Chmod failed/);
        assert.throws(() => enforceSecurePermissions(tempDirectory), /Chmod failed/);
    } finally {
        fs.chmodSync = originalChmod;
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

test('secureAtomicWriteFile writes content and enforces 0600 permissions', (t) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-write-test-'));
    const testFile = path.join(tempDirectory, 'test_file.txt');
    try {
        secureAtomicWriteFile(testFile, 'hello secure file', { encoding: 'utf8' });
        assert.equal(fs.readFileSync(testFile, 'utf8'), 'hello secure file');

        if (process.platform === 'win32') {
            t.skip('POSIX permission bits are not supported on Windows.');
        } else {
            const stat = fs.statSync(testFile);
            assert.equal(stat.mode & 0o777, 0o600);
        }
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

test('contacts_cache.json and qr.png are written with 0600 permissions on POSIX using temp directory', async (t) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-perm-test-'));
    const tempCachePath = path.join(tempDirectory, 'contacts_cache.json');
    const tempQrPath = path.join(tempDirectory, 'qr.png');

    try {
        const cachedList = [{ id: '123@s.whatsapp.net', name: 'Alice' }];
        secureAtomicWriteJson(tempCachePath, cachedList);

        assert.ok(fs.existsSync(tempCachePath));
        if (process.platform === 'win32') {
            t.skip('POSIX permission bits are not supported on Windows.');
        } else {
            const cacheStat = fs.statSync(tempCachePath);
            assert.equal(cacheStat.mode & 0o777, 0o600);
        }

        await writeQrSecurely('https://whatsapp.com', tempQrPath);
        assert.ok(fs.existsSync(tempQrPath));
        assert.ok(fs.statSync(tempQrPath).size > 0);

        if (process.platform === 'win32') {
            t.skip('POSIX permission bits are not supported on Windows.');
        } else {
            const qrStat = fs.statSync(tempQrPath);
            assert.equal(qrStat.mode & 0o777, 0o600);
        }
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

test('formatErrorBriefly redacts keys, sessions, tokens, and raw buffers', () => {
    const sensitiveToken = 'a'.repeat(64);
    const err1 = new Error('Connection failed because token ' + sensitiveToken + ' is invalid');
    const brief1 = formatErrorBriefly(err1);
    assert.match(brief1, /\[REDACTED_/);
    assert.ok(!brief1.includes(sensitiveToken));

    const err2 = { name: 'BaileysError', message: 'Failed to write session state', statusCode: 403, code: 'WRITE_FAIL' };
    const brief2 = formatErrorBriefly(err2);
    assert.equal(brief2, '[BaileysError] Failed to write [REDACTED_SESSION] state (Status: 403) (Code: WRITE_FAIL)');
});

test('rotateEngineLog copy-and-truncates engine.log if size exceeds 5MB limit', () => {
    const logPath = path.join(__dirname, 'engine.log');
    const backupPath = path.join(__dirname, 'engine.log.1');

    // Cleanup first
    try { fs.unlinkSync(logPath); } catch (_) {}
    try { fs.unlinkSync(backupPath); } catch (_) {}

    // Create a mock large file
    const largeContent = 'A'.repeat(6 * 1024 * 1024); // 6MB
    fs.writeFileSync(logPath, largeContent, { encoding: 'utf8', mode: 0o600 });

    rotateEngineLog();

    assert.ok(fs.existsSync(logPath));
    assert.equal(fs.statSync(logPath).size, 0, 'Original engine.log should be truncated to 0.');
    assert.ok(fs.existsSync(backupPath));
    assert.equal(fs.statSync(backupPath).size, 6 * 1024 * 1024, 'Backup file should contain the original large log content.');

    // Cleanup
    try { fs.unlinkSync(logPath); } catch (_) {}
    try { fs.unlinkSync(backupPath); } catch (_) {}
});

test('fetchGroupsList deduplicates concurrent group sync requests', async () => {
    // Reset internal state
    const state = getConnectionState();
    state.status = 'connected';
    state.groupsSynced = false;
    setSocketGeneration(10);
    setLastSyncedGeneration(-1);
    setCurrentGroupSyncPromiseGen(-1);

    let fetchCount = 0;
    const mockSock = {
        groupFetchAllParticipating: async () => {
            fetchCount++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { '123@g.us': { subject: 'Test Group' } };
        }
    };
    setSock(mockSock);

    // Call fetchGroupsList concurrently
    const p1 = fetchGroupsList();
    const p2 = fetchGroupsList();
    const p3 = fetchGroupsList();

    await Promise.all([p1, p2, p3]);

    assert.equal(fetchCount, 1, 'groupFetchAllParticipating must be called exactly once.');
    assert.equal(getLastSyncedGeneration(), 10, 'lastSyncedGeneration must be set to current socket generation.');
});

test('fetchGroupsList allows new sync on reconnect socket generation change and discards outdated results', async () => {
    // Reset internal state
    const state = getConnectionState();
    state.status = 'connected';
    state.groupsSynced = false;
    setSocketGeneration(20);
    setLastSyncedGeneration(-1);
    setCurrentGroupSyncPromiseGen(-1);

    let resolveFetchPromise;
    const fetchPromise = new Promise((resolve) => {
        resolveFetchPromise = resolve;
    });

    let fetchCount = 0;
    const mockSock1 = {
        groupFetchAllParticipating: async () => {
            fetchCount++;
            await fetchPromise; // Block until we simulate reconnect
            return { '999@g.us': { subject: 'Stale Group' } };
        }
    };
    setSock(mockSock1);

    // Start sync 1 (socket generation 20)
    const p1 = fetchGroupsList();

    // Now simulate reconnect (socket generation changes to 21)
    setSocketGeneration(21);
    
    let fetchCount2 = 0;
    const mockSock2 = {
        groupFetchAllParticipating: async () => {
            fetchCount2++;
            return { '888@g.us': { subject: 'Fresh Group' } };
        }
    };
    setSock(mockSock2);

    // Start sync 2 (socket generation 21)
    const p2 = fetchGroupsList();

    // Resolve first sync promise
    resolveFetchPromise();

    await Promise.all([p1, p2]);

    assert.equal(fetchCount, 1, 'First mock socket fetch must be called.');
    assert.equal(fetchCount2, 1, 'Second mock socket fetch must be called.');
    assert.equal(getLastSyncedGeneration(), 21, 'lastSyncedGeneration should reflect the latest successful generation.');
});

test('POST /api/send transition progress phases correctly', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-send-phase-'));
    const dummyPath = path.join(tempDirectory, 'payload.txt');
    fs.writeFileSync(dummyPath, 'a'.repeat(2 * 1024 * 1024), 'utf8'); // 2MB

    const token = 'c'.repeat(64);
    const deferred = createDeferred();
    
    const app = createApp({
        ipcToken: token,
        connectionState: { status: 'connected' },
        getSock: () => ({
            sendMessage: async (jid, content) => {
                // Read the stream to trigger ProgressStream progress callbacks
                content.document.stream.resume();
                return deferred.promise;
            }
        })
    });

    const listener = await listen(app);
    try {
        const sendPromise = makeRequest(listener.port, '/api/send', 'POST', token, {
            filePath: dummyPath,
            recipient: '213661834572'
        });

        // Let's wait a brief moment for streaming phase to initialize and progress
        await waitUntil(async () => {
            const status = await makeRequest(listener.port, '/api/status', 'GET', token);
            return status.body.uploadProgress.active === true && status.body.uploadProgress.phase === 'streaming';
        });

        // Let the stream finish reading entirely so it transitions to awaiting_confirmation
        await waitUntil(async () => {
            const status = await makeRequest(listener.port, '/api/status', 'GET', token);
            return status.body.uploadProgress.phase === 'awaiting_confirmation';
        }, 3000);

        // Resolve sendMessage call to simulate WhatsApp successfully confirming the receive
        deferred.resolve({ key: { id: 'msg123' } });

        const result = await sendPromise;
        assert.equal(result.statusCode, 200);

        // Ensure status reflects completed
        const finalStatus = await makeRequest(listener.port, '/api/status', 'GET', token);
        assert.equal(finalStatus.body.uploadProgress.active, false);
    } finally {
        deferred.resolve();
        await closeServer(listener.server);
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});
