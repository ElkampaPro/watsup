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

// 4. Phase 1: Fresh Import Process Safety
test('Phase 1: Fresh Import Process Safety (zero process leaks)', () => {
    const { execSync } = require('child_process');
    const path = require('path');
    const modulesToTest = ['secure_fs.js', 'ipc_security.js', 'logger.js', 'jid_utils.js', 'engine.js'];

    for (const modName of modulesToTest) {
        const absPath = path.resolve(__dirname, modName).replace(/\\/g, '/');
        execSync(`node -e "
            const assert = require('assert');
            const fs = require('fs');
            const net = require('net');
            const http = require('http');

            let writeCalled = 0;
            let renameCalled = 0;
            let chmodCalled = 0;
            let mkdirCalled = 0;
            let unlinkCalled = 0;
            let netListenCalled = 0;
            let httpListenCalled = 0;

            fs.writeFileSync = () => { writeCalled++; };
            fs.renameSync = () => { renameCalled++; };
            fs.chmodSync = () => { chmodCalled++; };
            fs.mkdirSync = () => { mkdirCalled++; };
            fs.unlinkSync = () => { unlinkCalled++; };
            net.Server.prototype.listen = () => { netListenCalled++; };
            http.Server.prototype.listen = () => { httpListenCalled++; };

            const beforeUmask = process.umask();
            const beforeListeners1 = process.listeners('unhandledRejection').length;
            const beforeListeners2 = process.listeners('uncaughtException').length;
            const beforeListeners3 = process.listeners('SIGINT').length;
            const beforeListeners4 = process.listeners('SIGTERM').length;

            // Import the module via absolute path
            require('${absPath}');

            assert.strictEqual(writeCalled, 0, 'Import must not call writeFileSync');
            assert.strictEqual(renameCalled, 0, 'Import must not call renameSync');
            assert.strictEqual(chmodCalled, 0, 'Import must not call chmodSync');
            assert.strictEqual(mkdirCalled, 0, 'Import must not call mkdirSync');
            assert.strictEqual(unlinkCalled, 0, 'Import must not call unlinkSync');
            assert.strictEqual(netListenCalled, 0, 'Import must not call net.Server.listen');
            assert.strictEqual(httpListenCalled, 0, 'Import must not call http.Server.listen');

            assert.strictEqual(process.umask(), beforeUmask, 'umask must not change');
            assert.strictEqual(process.listeners('unhandledRejection').length, beforeListeners1, 'unhandledRejection must not be registered');
            assert.strictEqual(process.listeners('uncaughtException').length, beforeListeners2, 'uncaughtException must not be registered');
            assert.strictEqual(process.listeners('SIGINT').length, beforeListeners3, 'SIGINT must not be registered');
            assert.strictEqual(process.listeners('SIGTERM').length, beforeListeners4, 'SIGTERM must not be registered');
        "`, { stdio: 'pipe' });
    }
});

// 5. Phase 1: secure_fs.js Permissions & Traversal Restrictions
test('Phase 1: secure_fs.js Permissions and Traversal Restrictions', () => {
    const secureFs = require('./secure_fs.js');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-p1-perms-'));

    try {
        const testFile = path.join(tempDir, 'test_perms.txt');
        secureFs.secureAtomicWriteFile(testFile, 'hello secure fs', { encoding: 'utf8' });
        assert.ok(fs.existsSync(testFile));
        assert.equal(fs.readFileSync(testFile, 'utf8'), 'hello secure fs');

        if (process.platform !== 'win32') {
            const stats = fs.statSync(testFile);
            assert.equal(stats.mode & 0o777, 0o600, 'File mode must be 0600 on POSIX');
        }

        const subDir = path.join(tempDir, 'sub_dir');
        fs.mkdirSync(subDir);
        const subFile = path.join(subDir, 'sub_file.txt');
        fs.writeFileSync(subFile, 'sub content', { encoding: 'utf8' });
        const extraFile = path.join(tempDir, 'extra_file.txt');
        fs.writeFileSync(extraFile, 'extra content', { encoding: 'utf8' });

        secureFs.enforceSecurePermissions(subDir, { extraFiles: [extraFile] });
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(subDir).mode & 0o777, 0o700, 'Directory mode must be 0700');
            assert.equal(fs.statSync(subFile).mode & 0o777, 0o600, 'Sub file mode must be 0600');
            assert.equal(fs.statSync(extraFile).mode & 0o777, 0o600, 'Extra file mode must be 0600');
        }

        // Test symlink rejection inside traversal
        let symlinkSupported = true;
        const symlinkTarget = path.join(tempDir, 'symlink_target.txt');
        fs.writeFileSync(symlinkTarget, 'target content', { encoding: 'utf8' });
        const symlinkFile = path.join(subDir, 'symlink_file.txt');

        try {
            fs.symlinkSync(symlinkTarget, symlinkFile);
        } catch (err) {
            symlinkSupported = false;
        }

        if (symlinkSupported) {
            assert.throws(() => {
                secureFs.enforceSecurePermissions(subDir);
            }, /Security Exception/, 'Should throw exception upon symlink detection');

            // Test symlink directory itself
            const symDir = path.join(tempDir, 'sym_dir');
            fs.symlinkSync(subDir, symDir);
            assert.throws(() => {
                secureFs.enforceSecurePermissions(symDir);
            }, /Security Exception/, 'Should throw when directory itself is a symlink');

            // Test extraFiles symlink rejection
            const symExtra = path.join(tempDir, 'sym_extra.txt');
            fs.symlinkSync(symlinkTarget, symExtra);
            assert.throws(() => {
                secureFs.enforceSecurePermissions(subDir, { extraFiles: [symExtra] });
            }, /Security Exception/, 'Should throw when extraFile is a symlink');
        } else {
            console.log('Skipping symlink traversal test because OS does not support symlinks (or requires admin privilege).');
        }

    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
});

// 6. Phase 1: secure_fs.js Atomic Guarantees & Cleanup
test('Phase 1: secure_fs.js Atomic Guarantees and Cleanup', () => {
    const secureFs = require('./secure_fs.js');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-p1-atomic-'));

    try {
        // Test write failure leaves no temp files
        const badPath = path.join(tempDir, 'nonexistent_folder_xyz/file.txt');
        assert.throws(() => {
            secureFs.secureAtomicWriteFile(badPath, 'fail data', { encoding: 'utf8' });
        }, /ENOENT/);

        const filesLeft = fs.readdirSync(tempDir);
        assert.equal(filesLeft.filter(f => f.startsWith('.watsup_temp_')).length, 0, 'No temp files should remain after failure');

        // Test destination persistence on fail
        const destFile = path.join(tempDir, 'destination.txt');
        fs.writeFileSync(destFile, 'original content', { encoding: 'utf8' });

        // Intercept renameSync to trigger rename failure
        const originalRename = fs.renameSync;
        fs.renameSync = () => { throw new Error('mock rename failure'); };

        try {
            assert.throws(() => {
                secureFs.secureAtomicWriteFile(destFile, 'new content', { encoding: 'utf8' });
            }, /mock rename failure/);

            // Assert original content remains intact
            assert.equal(fs.readFileSync(destFile, 'utf8'), 'original content', 'Destination must not be corrupted on rename failure');
        } finally {
            fs.renameSync = originalRename;
        }

        // Verify temp file cleaned up after rename failure
        const filesLeftPostRename = fs.readdirSync(tempDir);
        assert.equal(filesLeftPostRename.filter(f => f.startsWith('.watsup_temp_')).length, 0, 'No temp files should remain after rename failure');

    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
});

// 7. Phase 1: secureAtomicWriteFile chmod failure test in child process
test('Phase 1: secureAtomicWriteFile chmod failure test in child process', () => {
    const { execSync } = require('child_process');
    execSync(`node -e "
        const assert = require('assert');
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const secureFs = require('./secure_fs.js');

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-chmod-fail-'));
        const destFile = path.join(tempDir, 'dest.txt');
        fs.writeFileSync(destFile, 'original content', { encoding: 'utf8' });

        // Mock chmodSync to throw error only when chmodding the temp file
        const originalChmodSync = fs.chmodSync;
        fs.chmodSync = (targetPath, mode) => {
            if (typeof targetPath === 'string' && path.basename(targetPath).startsWith('.watsup_temp_')) {
                throw new Error('mock chmod failure');
            }
            return originalChmodSync(targetPath, mode);
        };

        try {
            assert.throws(() => {
                secureFs.secureAtomicWriteFile(destFile, 'new content', { encoding: 'utf8' });
            }, /mock chmod failure/);

            // Assert destination is untouched
            assert.strictEqual(fs.readFileSync(destFile, 'utf8'), 'original content');

            // Assert no temp files remain
            const files = fs.readdirSync(tempDir);
            assert.strictEqual(files.filter(f => f.startsWith('.watsup_temp_')).length, 0);
        } finally {
            fs.chmodSync = originalChmodSync;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    "`, { stdio: 'pipe' });
});

// 8. Phase 1: ipc_security.js Token creation secrecy and permission checks
test('Phase 1: ipc_security.js Token creation secrecy and permission checks', () => {
    const ipcSecurity = require('./ipc_security.js');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-token-sec-'));
    const tokenFile = path.join(tempDir, 'token.txt');

    // Intercept console.log, console.error, console.warn
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    let capturedOutput = '';
    console.log = (...args) => { capturedOutput += args.join(' ') + '\\n'; };
    console.error = (...args) => { capturedOutput += args.join(' ') + '\\n'; };
    console.warn = (...args) => { capturedOutput += args.join(' ') + '\\n'; };

    try {
        const token = ipcSecurity.loadOrCreateToken(tokenFile);

        // Verify it matches 64 hex pattern
        assert.match(token, /^[a-fA-F0-9]{64}$/);

        // Verify it was written to file
        assert.ok(fs.existsSync(tokenFile));
        assert.strictEqual(fs.readFileSync(tokenFile, 'utf8').trim(), token);

        // Verify no log leak of the token
        assert.strictEqual(capturedOutput.includes(token), false, 'Token must not leak in console.log/error/warn');

        if (process.platform !== 'win32') {
            const stats = fs.statSync(tokenFile);
            assert.strictEqual(stats.mode & 0o777, 0o600, 'Token file must be 0600 on POSIX');
        }
    } finally {
        console.log = originalLog;
        console.error = originalError;
        console.warn = originalWarn;
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
});

// 9. Phase 1: ipc_security.js Timing-Safe Verification
test('Phase 1: ipc_security.js Timing-Safe Verification', () => {
    const ipcSecurity = require('./ipc_security.js');
    const crypto = require('crypto');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watsup-p1-tsafe-'));

    try {
        const tokenFile = path.join(tempDir, 'token.txt');
        const dummyToken = 'a'.repeat(64);
        fs.writeFileSync(tokenFile, dummyToken, { encoding: 'utf8' });

        const loaded = ipcSecurity.loadOrCreateToken(tokenFile);
        assert.equal(loaded, dummyToken);

        // Symlink token path rejection
        let symlinkSupported = true;
        const symlinkToken = path.join(tempDir, 'sym_token.txt');
        try {
            fs.symlinkSync(tokenFile, symlinkToken);
        } catch (e) {
            symlinkSupported = false;
        }

        if (symlinkSupported) {
            assert.throws(() => {
                ipcSecurity.loadOrCreateToken(symlinkToken);
            }, /Security Exception|Token path target/);
        }

        // Token must not leak in error message
        const badPath = path.join(tempDir, 'nonexistent_folder_123/token.txt');
        try {
            ipcSecurity.loadOrCreateToken(badPath);
            assert.fail('Should have failed to create token on bad path');
        } catch (err) {
            assert.ok(!err.message.includes('a'.repeat(64)), 'Token must not leak in error string');
        }

        // timingSafeEqual spy checking
        const originalTimingSafeEqual = crypto.timingSafeEqual;
        let spyCalled = 0;
        crypto.timingSafeEqual = function(...args) {
            spyCalled++;
            return originalTimingSafeEqual.apply(this, args);
        };

        try {
            const middleware = ipcSecurity.createIpcAuthMiddleware(dummyToken);
            let nextCalled = 0;
            const mockReq = { headers: {} };
            const mockRes = {
                statusCode: 200,
                body: null,
                status(code) {
                    this.statusCode = code;
                    return this;
                },
                json(obj) {
                    this.body = obj;
                    return this;
                }
            };

            // 1. Missing Token
            middleware(mockReq, mockRes, () => { nextCalled++; });
            assert.equal(mockRes.statusCode, 401);
            assert.deepEqual(mockRes.body, { success: false, error: 'Unauthorized: Missing IPC token.' });
            assert.equal(nextCalled, 0);
            assert.equal(spyCalled, 0, 'timingSafeEqual must not be called on missing token');

            // 2. Mismatched length token
            mockReq.headers['x-watsup-token'] = 'short';
            middleware(mockReq, mockRes, () => { nextCalled++; });
            assert.equal(mockRes.statusCode, 401);
            assert.deepEqual(mockRes.body, { success: false, error: 'Unauthorized: Invalid IPC token.' });
            assert.equal(nextCalled, 0);
            assert.equal(spyCalled, 0, 'timingSafeEqual must not be called when length differs');

            // 3. Valid length but mismatched value token
            mockReq.headers['x-watsup-token'] = 'b'.repeat(64);
            middleware(mockReq, mockRes, () => { nextCalled++; });
            assert.equal(mockRes.statusCode, 401);
            assert.deepEqual(mockRes.body, { success: false, error: 'Unauthorized: Invalid IPC token.' });
            assert.equal(nextCalled, 0);
            assert.equal(spyCalled, 1, 'timingSafeEqual must be called when length matches');

            // 4. Valid token
            mockReq.headers['x-watsup-token'] = dummyToken;
            middleware(mockReq, mockRes, () => { nextCalled++; });
            assert.equal(nextCalled, 1);
            assert.equal(spyCalled, 2);

        } finally {
            crypto.timingSafeEqual = originalTimingSafeEqual;
        }

    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
});

// 10. Phase 1: engine.js Exports & Wrappers Verification
test('Phase 1: engine.js Exports and Wrappers Verification', () => {
    const engine = require('./engine.js');
    const secureFs = require('./secure_fs.js');
    const ipcSecurity = require('./ipc_security.js');
    const loggerModule = require('./logger.js');
    const jidUtils = require('./jid_utils.js');

    // exports checking
    assert.equal(engine.formatJid, jidUtils.formatJid);
    assert.equal(engine.secureAtomicWriteFile, secureFs.secureAtomicWriteFile);
    assert.equal(engine.secureAtomicWriteJson, secureFs.secureAtomicWriteJson);
    assert.equal(engine.sanitizePayload, loggerModule.sanitizePayload);
    assert.equal(engine.formatErrorBriefly, loggerModule.formatErrorBriefly);
    assert.equal(engine.createSanitizedLogger, loggerModule.createSanitizedLogger);

    assert.equal(typeof engine.loadOrCreateToken, 'function');
    assert.equal(typeof engine.enforceSecurePermissions, 'function');
});
