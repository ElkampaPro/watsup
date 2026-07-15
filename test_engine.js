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
    createSanitizedLogger,
    formatErrorBriefly,
    sanitizePayload,
    handleBackgroundError,
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
    while (!(await predicate())) {
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


test('fetchGroupsList deduplicates concurrent group sync requests', async () => {
    const cachePath = path.join(__dirname, 'contacts_cache.json');
    const originalCacheExists = fs.existsSync(cachePath);
    const originalCacheContent = originalCacheExists ? fs.readFileSync(cachePath) : null;

    // Reset internal state
    const state = getConnectionState();
    state.status = 'connected';
    state.groupsSynced = false;
    setSocketGeneration(10);
    setLastSyncedGeneration(-1);
    setCurrentGroupSyncPromiseGen(-1);

    const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-contacts-test-'));
    const testCachePath = path.join(testTempDir, 'contacts_cache.json');
    const testContactsMap = new Map();

    let fetchCount = 0;
    const mockSock = {
        groupFetchAllParticipating: async () => {
            fetchCount++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { '123@g.us': { subject: 'Test Group' } };
        }
    };
    setSock(mockSock);

    // Call fetchGroupsList concurrently passing isolated dependencies
    const p1 = fetchGroupsList(testContactsMap, testCachePath);
    const p2 = fetchGroupsList(testContactsMap, testCachePath);
    const p3 = fetchGroupsList(testContactsMap, testCachePath);

    await Promise.all([p1, p2, p3]);

    assert.equal(fetchCount, 1, 'groupFetchAllParticipating must be called exactly once.');
    assert.equal(getLastSyncedGeneration(), 10, 'lastSyncedGeneration must be set to current socket generation.');

    // Assert isolated cache was written to correctly
    assert.ok(fs.existsSync(testCachePath), 'Isolated test cache file must exist');
    const testCacheData = JSON.parse(fs.readFileSync(testCachePath, 'utf8'));
    assert.equal(testCacheData.length, 1, 'Test cache must contain exactly 1 entry');
    assert.equal(testCacheData[0].id, '123@g.us', 'Group JID match');

    // Assert no leakage to production contacts_cache.json
    if (originalCacheExists) {
        assert.ok(fs.existsSync(cachePath), 'Production cache must still exist');
        assert.deepEqual(fs.readFileSync(cachePath), originalCacheContent, 'Production cache content must be unchanged');
    } else {
        assert.ok(!fs.existsSync(cachePath), 'Production cache must not have been created');
    }

    // Clean up test temp dir
    fs.rmSync(testTempDir, { recursive: true, force: true });
});

test('fetchGroupsList allows new sync on reconnect socket generation change and discards outdated results', async () => {
    const cachePath = path.join(__dirname, 'contacts_cache.json');
    const originalCacheExists = fs.existsSync(cachePath);
    const originalCacheContent = originalCacheExists ? fs.readFileSync(cachePath) : null;

    // Reset internal state
    const state = getConnectionState();
    state.status = 'connected';
    state.groupsSynced = false;
    setSocketGeneration(20);
    setLastSyncedGeneration(-1);
    setCurrentGroupSyncPromiseGen(-1);

    const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-contacts-test-'));
    const testCachePath = path.join(testTempDir, 'contacts_cache.json');
    const testContactsMap = new Map();

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

    // Start sync 1 (socket generation 20) with isolated dependencies
    const p1 = fetchGroupsList(testContactsMap, testCachePath);

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

    // Start sync 2 (socket generation 21) with isolated dependencies
    const p2 = fetchGroupsList(testContactsMap, testCachePath);

    // Resolve first sync promise
    resolveFetchPromise();

    await Promise.all([p1, p2]);

    assert.equal(fetchCount, 1, 'First mock socket fetch must be called.');
    assert.equal(fetchCount2, 1, 'Second mock socket fetch must be called.');
    assert.equal(getLastSyncedGeneration(), 21, 'lastSyncedGeneration should reflect the latest successful generation.');

    // Assert only the fresh group (from generation 21) was saved to the test cache
    assert.ok(fs.existsSync(testCachePath), 'Isolated test cache file must exist');
    const testCacheData = JSON.parse(fs.readFileSync(testCachePath, 'utf8'));
    assert.equal(testCacheData.length, 1, 'Test cache must contain exactly 1 entry');
    assert.equal(testCacheData[0].id, '888@g.us', 'Should only keep Fresh Group from generation 21');
    assert.equal(testCacheData[0].name, '👥 [Group] Fresh Group', 'Name match');

    // Assert no leakage to production contacts_cache.json
    if (originalCacheExists) {
        assert.ok(fs.existsSync(cachePath), 'Production cache must still exist');
        assert.deepEqual(fs.readFileSync(cachePath), originalCacheContent, 'Production cache content must be unchanged');
    } else {
        assert.ok(!fs.existsSync(cachePath), 'Production cache must not have been created');
    }

    // Clean up test temp dir
    fs.rmSync(testTempDir, { recursive: true, force: true });
});

test('fetchGroupsList authoritative sync and stale group pruning', async () => {
    const cachePath = path.join(__dirname, 'contacts_cache.json');
    const originalCacheExists = fs.existsSync(cachePath);
    const originalCacheContent = originalCacheExists ? fs.readFileSync(cachePath) : null;

    const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-contacts-prune-'));
    const testCachePath = path.join(testTempDir, 'contacts_cache.json');

    const testContactsMap = new Map();
    testContactsMap.set('111@s.whatsapp.net', { id: '111@s.whatsapp.net', name: '👤 John Doe' });
    testContactsMap.set('old-group@g.us', { id: 'old-group@g.us', name: '👥 [Group] Old Group' });
    testContactsMap.set('keep-group@g.us', { id: 'keep-group@g.us', name: '👥 [Group] Keep Group' });

    const state = getConnectionState();
    state.status = 'connected';
    state.groupsSynced = false;
    setSocketGeneration(30);
    setLastSyncedGeneration(-1);
    setCurrentGroupSyncPromiseGen(-1);

    // 1. Sync returns only keep-group (updated) and a new-group
    const mockSock = {
        groupFetchAllParticipating: async () => {
            return {
                'keep-group@g.us': { subject: 'Keep Group Updated' },
                'new-group@g.us': { subject: 'New Group' }
            };
        }
    };
    setSock(mockSock);

    await fetchGroupsList(testContactsMap, testCachePath);

    // Assertions:
    assert.ok(testContactsMap.has('111@s.whatsapp.net'), 'Personal contact must remain');
    assert.ok(!testContactsMap.has('old-group@g.us'), 'Stale group must be pruned');
    assert.equal(testContactsMap.get('keep-group@g.us').name, '👥 [Group] Keep Group Updated', 'Keep group subject must be updated');
    assert.ok(testContactsMap.has('new-group@g.us'), 'New group must be added');

    // Assert cache was written
    assert.ok(fs.existsSync(testCachePath), 'Test cache must exist');
    let testCacheData = JSON.parse(fs.readFileSync(testCachePath, 'utf8'));
    assert.equal(testCacheData.length, 3, 'Cache must contain exactly 3 contacts');

    // 2. Test empty groups result -> prunes all groups
    setSocketGeneration(31);
    setSock({
        groupFetchAllParticipating: async () => {
            return {};
        }
    });
    await fetchGroupsList(testContactsMap, testCachePath);
    assert.equal(testContactsMap.size, 1, 'Only 1 contact should remain in the map');
    assert.ok(testContactsMap.has('111@s.whatsapp.net'), 'Personal contact must remain');

    // 3. Test outdated generation -> does not modify or write anything
    testContactsMap.set('another-group@g.us', { id: 'another-group@g.us', name: '👥 [Group] Another Group' });
    const cachedList = Array.from(testContactsMap.values());
    fs.writeFileSync(testCachePath, JSON.stringify(cachedList), 'utf8');
    const testCacheBeforeOutdated = fs.readFileSync(testCachePath, 'utf8');

    setSocketGeneration(32);
    let resolveOutdated;
    const outdatedPromise = new Promise((resolve) => { resolveOutdated = resolve; });
    setSock({
        groupFetchAllParticipating: async () => {
            await outdatedPromise;
            return { 'new-outdated-group@g.us': { subject: 'Outdated Group' } };
        }
    });

    const pOutdated = fetchGroupsList(testContactsMap, testCachePath);
    setSocketGeneration(33);
    resolveOutdated();
    await pOutdated;

    assert.ok(!testContactsMap.has('new-outdated-group@g.us'), 'Outdated group must not be added to map');
    assert.equal(fs.readFileSync(testCachePath, 'utf8'), testCacheBeforeOutdated, 'Cache must not be modified by outdated sync');

    // Assert no leakage to production contacts_cache.json
    if (originalCacheExists) {
        assert.ok(fs.existsSync(cachePath), 'Production cache must still exist');
        assert.deepEqual(fs.readFileSync(cachePath), originalCacheContent, 'Production cache content must be unchanged');
    } else {
        assert.ok(!fs.existsSync(cachePath), 'Production cache must not have been created');
    }

    // Clean up test temp dir
    fs.rmSync(testTempDir, { recursive: true, force: true });
});

test('POST /api/send transition progress phases correctly', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-send-phase-'));
    const dummyPath = path.join(tempDirectory, 'payload.txt');
    fs.writeFileSync(dummyPath, 'a'.repeat(2 * 1024 * 1024), 'utf8'); // 2MB

    const token = 'c'.repeat(64);
    const deferred = createDeferred();
    let capturedStream = null;

    const app = createApp({
        ipcToken: token,
        connectionState: { status: 'connected' },
        getSock: () => ({
            sendMessage: async (jid, content) => {
                capturedStream = content.document.stream;
                return deferred.promise;
            }
        })
    });

    const listener = await listen(app);
    try {
        let hasResolved = false;
        const sendPromise = makeRequest(listener.port, '/api/send', 'POST', token, {
            filePath: dummyPath,
            recipient: '213661834572'
        });
        sendPromise.then(() => { hasResolved = true; });

        // 1. Wait for streaming phase (active=true)
        await waitUntil(async () => {
            const status = await makeRequest(listener.port, '/api/status', 'GET', token);
            return status.body.uploadProgress.active === true && status.body.uploadProgress.phase === 'streaming';
        });

        // Ensure capturedStream is now available and resume it
        assert.ok(capturedStream, 'Stream should have been captured');
        capturedStream.resume();

        // 2. Wait for awaiting_confirmation (active=true, percentage=99)
        await waitUntil(async () => {
            const status = await makeRequest(listener.port, '/api/status', 'GET', token);
            return status.body.uploadProgress.phase === 'awaiting_confirmation';
        }, 3000);

        const checkStatus = (await makeRequest(listener.port, '/api/status', 'GET', token)).body.uploadProgress;
        assert.equal(checkStatus.active, true);
        assert.equal(checkStatus.percentage, 99);
        assert.equal(hasResolved, false, 'HTTP request must remain pending before sendMessage resolves');

        // 3. Resolve sendMessage call
        deferred.resolve({ key: { id: 'msg123' } });

        const result = await sendPromise;
        assert.equal(result.statusCode, 200);

        // Ensure status reflects completed (active=false, percentage=100)
        const finalStatus = (await makeRequest(listener.port, '/api/status', 'GET', token)).body.uploadProgress;
        assert.equal(finalStatus.active, false);
        assert.equal(finalStatus.percentage, 100);
        assert.equal(finalStatus.phase, 'completed');
        assert.equal(finalStatus.bytesSent, finalStatus.totalBytes);
    } finally {
        deferred.resolve();
        await closeServer(listener.server);
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

test('POST /api/send handles sendMessage failure and releases lock', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-send-fail-'));
    const dummyPath = path.join(tempDirectory, 'payload.txt');
    fs.writeFileSync(dummyPath, 'a'.repeat(1 * 1024 * 1024), 'utf8'); // 1MB

    const token = 'c'.repeat(64);
    const deferred = createDeferred();

    const app = createApp({
        ipcToken: token,
        connectionState: { status: 'connected' },
        getSock: () => ({
            sendMessage: async (jid, content) => {
                content.document.stream.resume();
                throw new Error('Socket closed abruptly');
            }
        })
    });

    const listener = await listen(app);
    try {
        const sendPromise = makeRequest(listener.port, '/api/send', 'POST', token, {
            filePath: dummyPath,
            recipient: '213661834572'
        });

        const result = await sendPromise;
        assert.equal(result.statusCode, 500);

        const status = (await makeRequest(listener.port, '/api/status', 'GET', token)).body.uploadProgress;
        assert.equal(status.active, false);
        assert.equal(status.phase, 'failed');
        assert.match(status.error, /Socket closed abruptly/);

        // Verify the lock is released and subsequent request succeeds or gets accepted
        const app2 = createApp({
            ipcToken: token,
            connectionState: { status: 'connected' },
            getSock: () => ({
                sendMessage: async (jid, content) => {
                    content.document.stream.resume();
                    return { key: { id: 'msg456' } };
                }
            })
        });
        const listener2 = await listen(app2);
        try {
            const sendPromiseNext = await makeRequest(listener2.port, '/api/send', 'POST', token, {
                filePath: dummyPath,
                recipient: '213661834572'
            });
            assert.equal(sendPromiseNext.statusCode, 200);
        } finally {
            await closeServer(listener2.server);
        }
    } finally {
        await closeServer(listener.server);
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

test('handleBackgroundError side/lateral error during active send does not impact progress or locks', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-bg-err-'));
    const dummyPath = path.join(tempDirectory, 'payload.txt');
    fs.writeFileSync(dummyPath, 'a'.repeat(2 * 1024 * 1024), 'utf8'); // 2MB

    const token = 'd'.repeat(64);
    const deferred = createDeferred();

    const app = createApp({
        ipcToken: token,
        connectionState: { status: 'connected' },
        getSock: () => ({
            sendMessage: async (jid, content) => {
                content.document.stream.resume();
                return deferred.promise;
            }
        })
    });

    const listener = await listen(app);
    try {
        // 1. Start upload A
        const sendPromiseA = makeRequest(listener.port, '/api/send', 'POST', token, {
            filePath: dummyPath,
            recipient: '213661834572'
        });

        // Wait for streaming phase
        await waitUntil(async () => {
            const status = await makeRequest(listener.port, '/api/status', 'GET', token);
            const progress = status.body.uploadProgress;
            return progress.active === true && (progress.phase === 'streaming' || progress.phase === 'awaiting_confirmation');
        });

        const snapshot = (await makeRequest(listener.port, '/api/status', 'GET', token)).body.uploadProgress;

        // 2. Intercept a lateral/background decryption error
        const bgError = new Error('decryption failed for inbound encrypted message');
        bgError.name = 'DecryptionError';
        bgError.raw = Buffer.from('raw encrypted message payload');

        const logs = [];
        const mockLogger = {
            error: (msg, payload) => { logs.push(msg + (payload ? ' ' + payload : '')); },
            warn: (msg) => { logs.push(msg); }
        };

        handleBackgroundError(bgError, mockLogger);

        // Assert log message does not contain raw buffer or sensitive unredacted token
        const fullLogStr = logs.join('\n');
        assert.match(fullLogStr, /Unhandled Rejection/);
        assert.ok(!fullLogStr.includes('raw encrypted message payload'));

        // 3. Assert active progress state is still streaming/awaiting_confirmation and unaffected
        const statusCheck = (await makeRequest(listener.port, '/api/status', 'GET', token)).body.uploadProgress;
        assert.equal(statusCheck.active, true);
        assert.equal(statusCheck.totalBytes, snapshot.totalBytes);
        assert.ok(statusCheck.bytesSent >= snapshot.bytesSent);
        assert.ok(statusCheck.phase === 'streaming' || statusCheck.phase === 'awaiting_confirmation');

        // 4. Assert concurrent request B still returns 409
        const sendPromiseB = await makeRequest(listener.port, '/api/send', 'POST', token, {
            filePath: dummyPath,
            recipient: '213661834572'
        });
        assert.equal(sendPromiseB.statusCode, 409);

        // Resolve A
        deferred.resolve({ key: { id: 'msg123' } });
        const resultA = await sendPromiseA;
        assert.equal(resultA.statusCode, 200);

        // Verify completion fields
        const postStatus = (await makeRequest(listener.port, '/api/status', 'GET', token)).body.uploadProgress;
        assert.equal(postStatus.active, false);
        assert.equal(postStatus.percentage, 100);
        assert.equal(postStatus.phase, 'completed');
        assert.equal(postStatus.bytesSent, postStatus.totalBytes);

        // 5. Assert next request succeeds after A completes
        const sendPromiseC = await makeRequest(listener.port, '/api/send', 'POST', token, {
            filePath: dummyPath,
            recipient: '213661834572'
        });
        assert.equal(sendPromiseC.statusCode, 200);

    } finally {
        deferred.resolve();
        await closeServer(listener.server);
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

test('createSanitizedLogger recursively redacts sensitive data and JIDs', async () => {
    const logs = [];
    const destination = new (require('stream').Writable)({
        write(chunk, encoding, callback) {
            logs.push(chunk.toString());
            callback();
        }
    });

    const testLogger = createSanitizedLogger(destination, { level: 'info' });
    testLogger.info({
        msg: 'unhandled error occurred',
        raw: 'sensitive raw payload string',
        token: 'sensitive token string',
        node: { content: 'sensitive node content data' },
        buffer: Buffer.from('some secret byte data'),
        jid: '1234567890@s.whatsapp.net',
        otherField: 'safe data value',
        err: new Error('critical key lookup failed')
    });

    // Wait a brief moment for pino to write
    await new Promise(resolve => setTimeout(resolve, 50));

    const loggedStr = logs.join('\n');

    // Assert sensitive fields are redacted
    assert.ok(!loggedStr.includes('sensitive raw payload string'), 'Should redact raw field');
    assert.ok(!loggedStr.includes('sensitive token string'), 'Should redact token field');
    assert.ok(!loggedStr.includes('sensitive node content data'), 'Should redact node.content');
    assert.ok(!loggedStr.includes('some secret byte data'), 'Should redact buffer');
    assert.ok(!loggedStr.includes('1234567890@s.whatsapp.net'), 'Should redact JID');

    // Assert safe/generic fields are preserved
    assert.ok(loggedStr.includes('unhandled error occurred'), 'Should preserve msg text');
    assert.ok(loggedStr.includes('safe data value'), 'Should preserve safe fields');
    assert.ok(loggedStr.includes('critical [REDACTED_KEY] lookup failed'), 'Should preserve error message');
});

test('waitUntil awaits async predicates and throws on timeout', async () => {
    let callCount = 0;
    const asyncPredicate = async () => {
        callCount++;
        return callCount >= 3;
    };

    await waitUntil(asyncPredicate, 500);
    assert.ok(callCount >= 3, 'Should wait until predicate evaluates to true');

    // Test timeout throwing
    let timedOut = false;
    try {
        await waitUntil(async () => false, 100);
    } catch (err) {
        if (err.message.includes('Timed out')) {
            timedOut = true;
        }
    }
    assert.ok(timedOut, 'Should throw a timeout error if predicate never returns true');
});
