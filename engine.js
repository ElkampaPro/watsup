/**
 * WatsUp Streamer - engine.js
 * High-performance, zero-browser WhatsApp client engine.
 * Connects directly using @whiskeysockets/baileys raw websockets.
 * Exposes a secure localhost REST API to interface with local frontend wrappers.
 */

const express = require('express');
const crypto = require('crypto');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');

// Import modularized utility functions
const jidUtils = require('./jid_utils.js');
const secureFs = require('./secure_fs.js');
const ipcSecurity = require('./ipc_security.js');
const loggerModule = require('./logger.js');

const formatJid = jidUtils.formatJid;
const secureAtomicWriteFile = secureFs.secureAtomicWriteFile;
const secureAtomicWriteJson = secureFs.secureAtomicWriteJson;
const formatErrorBriefly = loggerModule.formatErrorBriefly;
const sanitizePayload = loggerModule.sanitizePayload;
const createSanitizedLogger = loggerModule.createSanitizedLogger;

function handleBackgroundError(reason, logger = console) {
    const brief = formatErrorBriefly(reason);
    const sanitizedReason = sanitizePayload(reason);
    if (brief.includes('init queries Timed Out') || brief.includes('Timed Out')) {
        logger.warn(`[Engine] Connection Warning (init queries Timed Out): ${brief}`);
    } else {
        logger.error(`[Engine] Unhandled Rejection: ${brief}`);
        if (reason && typeof reason === 'object') {
            logger.error('[Engine] Sanitized Error Payload:', JSON.stringify(sanitizedReason));
        }
    }
}

// Global process safety handlers to catch any Baileys internal async errors
process.on('unhandledRejection', (reason, promise) => {
    handleBackgroundError(reason);
});
process.on('uncaughtException', (err) => {
    console.error('[Engine] Uncaught Exception:', formatErrorBriefly(err));
    if (err && typeof err === 'object') {
        const sanitizedErr = sanitizePayload(err);
        console.error('[Engine] Sanitized Exception Payload:', JSON.stringify(sanitizedErr));
    }
});

const PORT = 5001;

// Path declarations
const authDir = path.join(__dirname, 'auth_info_baileys');
const cachePath = path.join(__dirname, 'contacts_cache.json');
const tokenPath = path.join(__dirname, '.watsup_ipc_token');
const TOKEN_PATTERN = ipcSecurity.TOKEN_PATTERN;
/**
 * Loads a valid IPC token or replaces an invalid/missing token atomically.
 * Passing a custom path keeps tests isolated from the real project token.
 */
function loadOrCreateToken(customTokenPath = tokenPath) {
    return ipcSecurity.loadOrCreateToken(customTokenPath);
}

// Progress monitoring transform stream
class ProgressStream extends Transform {
    constructor(totalBytes, onProgress) {
        super();
        this.totalBytes = totalBytes;
        this.bytesRead = 0;
        this.onProgress = onProgress;
    }

    _transform(chunk, encoding, callback) {
        this.bytesRead += chunk.length;
        const percentage = Math.min(Math.round((this.bytesRead / this.totalBytes) * 100), 99); // Cap at 99% until socket resolves
        this.onProgress(this.bytesRead, this.totalBytes, percentage);
        this.push(chunk);
        callback();
    }
}

// Global engine states
let sock = null;
let connectionState = {
    status: 'disconnected', // 'disconnected' | 'connecting' | 'connected'
    userInfo: null,          // Logged-in WhatsApp details
    qrAvailable: false,
    groupsSynced: false
};

let currentSocketGeneration = 0;
let lastSyncedGeneration = -1;
let currentGroupSyncPromise = null;
let currentGroupSyncPromiseGen = -1;

const contactsMap = new Map();

/**
 * Standard utility to fetch extension mimetype without heavy third-party overhead
 */
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.mp4': 'video/mp4',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.wmv': 'video/x-ms-wmv',
        '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed',
        '.tar': 'application/x-tar',
        '.gz': 'application/gzip',
        '.pdf': 'application/pdf',
        '.iso': 'application/x-iso9660-image',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Loads cached contacts from disk to ensure offline persistence
 */
function loadContactsCache() {
    try {
        if (fs.existsSync(cachePath)) {
            const data = fs.readFileSync(cachePath, 'utf8');
            const cachedList = JSON.parse(data);
            for (const contact of cachedList) {
                if (contact && contact.id) {
                    contactsMap.set(contact.id, contact);
                }
            }
            console.log(`[Cache] Restored ${contactsMap.size} contacts from contacts_cache.json`);
        }
    } catch (err) {
        console.error('[Cache] Error loading contacts cache:', err);
    }
}

/**
 * Saves current memory contacts map to disk cache
 */
function saveContactsCache(overrideContactsMap, overrideCachePath) {
    const activeContactsMap = overrideContactsMap || contactsMap;
    const activeCachePath = overrideCachePath || cachePath;
    try {
        const cachedList = Array.from(activeContactsMap.values());
        secureAtomicWriteJson(activeCachePath, cachedList);
    } catch (err) {
        console.error('[Cache] Error writing contacts cache:', err);
    }
}

/**
 * Deletes authentication credentials directory to allow fresh pairing
 */
function deleteAuthFolder() {
    if (fs.existsSync(authDir)) {
        try {
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log('[Auth] Session credentials directory wiped.');
        } catch (err) {
            console.error('[Auth] Error executing credentials wipe:', err);
        }
    }
}

async function writeQrSecurely(qr, filePath) {
    const buffer = await new Promise((resolve, reject) => {
        const QRCode = require('qrcode');
        QRCode.toBuffer(qr, { width: 260, margin: 1 }, (err, buf) => {
            if (err) reject(err);
            else resolve(buf);
        });
    });
    secureAtomicWriteFile(filePath, buffer);
}

function enforceSecurePermissions(directory = authDir) {
    const extraFiles = directory === authDir ? [
        tokenPath,
        cachePath,
        path.join(__dirname, 'qr.png'),
        path.join(__dirname, 'engine.log'),
        path.join(__dirname, 'ui_error.log'),
        path.join(__dirname, '.watsup_engine.pid')
    ] : [];
    secureFs.enforceSecurePermissions(directory, { extraFiles });
}

/**
 * Spawns the raw WebSocket connection to WhatsApp Web servers
 */
async function connectToWhatsApp() {
    currentSocketGeneration++;
    console.log('[Baileys] Launching WhatsApp WebSocket driver...');
    connectionState.status = 'connecting';
    connectionState.userInfo = null;

    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    }
    enforceSecurePermissions(authDir);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // High efficiency, silent logging configuration with redaction
    const silentLogger = createSanitizedLogger(null, {
        level: 'warn',
        transport: {
            target: 'pino-pretty',
            options: { colorize: true }
        }
    });

    // Fetch the latest WhatsApp Web version dynamically to avoid connection code 405 error
    let version = [2, 3000, 1015970061]; // Robust fallback version
    let isLatest = false;
    try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
        isLatest = latest.isLatest;
        console.log(`[Baileys] Dynamically fetched latest WA Web version: ${version.join('.')} (isLatest: ${isLatest})`);
    } catch (err) {
        console.error('[Baileys] Error fetching latest WA Web version, using hardcoded fallback:', err);
    }

    sock = makeWASocket({
        auth: state,
        logger: silentLogger,
        version: version,
        // Mimic an Android tablet / desktop on Linux for optimal and fast upload limits
        browser: ['Linux', 'Chrome', '120.0.0.0'],
        printQRInTerminal: false, // We will custom print this to avoid overflow
        syncFullHistory: false,   // Do not sync history to conserve system RAM
        connectTimeoutMs: 60000,  // Increase connect timeout to 60s
        defaultQueryTimeoutMs: 180000, // Increase query timeout to 180s to avoid init queries timeout
        keepAliveIntervalMs: 15000 // Send keep-alive ping frame every 15s to prevent timeouts during heavy media transfers
    });

    sock.ev.on('creds.update', async () => {
        try {
            await saveCreds();
            enforceSecurePermissions(authDir);
        } catch (err) {
            console.error('[Auth] Failed to save credentials securely:', err);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n======================================================================');
            console.log('🚨 NEW PAIRING QR CODE GENERATED!');
            console.log('Please scan this with your phone under Linked Devices in WhatsApp:');
            console.log('======================================================================\n');

            // Print the QR code directly in the terminal using ANSI characters
            qrcodeTerminal.generate(qr, { small: true });

            console.log('\n======================================================================\n');
            connectionState.status = 'disconnected';
            connectionState.qrAvailable = true;

            // Generate PNG and save it to disk as qr.png for Tkinter UI to display
            writeQrSecurely(qr, path.join(__dirname, 'qr.png'))
                .then(() => {
                    console.log('[Engine] QR code image written to disk: qr.png');
                })
                .catch((err) => {
                    console.error('[Engine] Failed to save QR code image:', err);
                });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[Baileys] Sockets closed (Reason: ${statusCode}). Attempting Reconnection: ${shouldReconnect}`);

            connectionState.status = 'disconnected';
            connectionState.userInfo = null;
            connectionState.qrAvailable = false;
            connectionState.groupsSynced = false;

            // Delete qr.png if it exists
            const qrFile = path.join(__dirname, 'qr.png');
            if (fs.existsSync(qrFile)) {
                try { fs.unlinkSync(qrFile); } catch (e) {}
            }

            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 3000);
            } else {
                console.log('[Baileys] Logged out. Wiping session files to allow new pairing...');
                deleteAuthFolder();
            }
        } else if (connection === 'open') {
            console.log('\n======================================================================');
            console.log('🎉 WHATSAPP CONNECTION SUCCESSFULLY ESTABLISHED!');
            const rawNumber = sock.user.id.split(':')[0];
            const maskedNumber = rawNumber.length > 4
                ? rawNumber.slice(0, 3) + '***' + rawNumber.slice(-2)
                : '***';
            console.log(`Linked User: +${maskedNumber} (${sock.user.name || 'Device'})`);
            console.log('======================================================================\n');

            connectionState.status = 'connected';
            connectionState.userInfo = sock.user;
            connectionState.qrAvailable = false;
            connectionState.groupsSynced = false;

            // Trigger dynamic group sync immediately on login
            // We temporarily bypass throttle to ensure fresh sync on startup
            lastGroupSyncTime = 0;
            fetchGroupsList().catch(() => {});

            // Delete qr.png if it exists
            const qrFile = path.join(__dirname, 'qr.png');
            if (fs.existsSync(qrFile)) {
                try { fs.unlinkSync(qrFile); } catch (e) {}
            }
        }
    });

    // Capture contacts from syncing events
    const cacheContacts = (contacts) => {
        if (!contacts) return;
        let updated = false;
        for (const contact of contacts) {
            if (contact && contact.id) {
                // Ignore groups in standard contacts catalog syncing to avoid duplicate styling
                if (contact.id.endsWith('@g.us')) continue;

                const rawName = contact.name || contact.notify || contact.verifiedName || null;
                if (rawName) {
                    const nameWithPrefix = rawName.startsWith('👤 ') ? rawName : `👤 ${rawName}`;
                    contactsMap.set(contact.id, { id: contact.id, name: nameWithPrefix });
                    updated = true;
                } else if (!contactsMap.has(contact.id)) {
                    const digits = contact.id.split('@')[0];
                    contactsMap.set(contact.id, { id: contact.id, name: `👤 +${digits}` });
                    updated = true;
                }
            }
        }
        if (updated) saveContactsCache();
    };

    sock.ev.on('messaging-history.set', ({ contacts, chats }) => {
        console.log('[Baileys] History synced. Parsing contacts and chats...');
        cacheContacts(contacts);

        if (chats) {
            let updated = false;
            for (const chat of chats) {
                if (chat && chat.id && !contactsMap.has(chat.id)) {
                    const isGroup = chat.id.endsWith('@g.us');
                    const prefix = isGroup ? '👥 [Group] ' : '👤 ';
                    const rawName = chat.name || chat.notify || (isGroup ? 'Unnamed Group' : `+${chat.id.split('@')[0]}`);
                    const nameWithPrefix = rawName.startsWith(prefix) ? rawName : `${prefix}${rawName}`;

                    contactsMap.set(chat.id, { id: chat.id, name: nameWithPrefix });
                    updated = true;
                }
            }
            if (updated) saveContactsCache();
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        cacheContacts(contacts);
    });

    sock.ev.on('contacts.update', (contacts) => {
        cacheContacts(contacts);
    });
}

let lastGroupSyncTime = 0;
async function fetchGroupsList(overrideContactsMap, overrideCachePath) {
    if (!sock || connectionState.status !== 'connected') return;
    const myGen = currentSocketGeneration;
    const activeContactsMap = overrideContactsMap || contactsMap;
    const activeCachePath = overrideCachePath || cachePath;

    if (currentGroupSyncPromise && currentGroupSyncPromiseGen === myGen) {
        return currentGroupSyncPromise;
    }

    if (lastSyncedGeneration === myGen) {
        connectionState.groupsSynced = true;
        return;
    }

    currentGroupSyncPromiseGen = myGen;
    currentGroupSyncPromise = (async () => {
        try {
            console.log('[Engine] Syncing WhatsApp groups list from server...');
            const groups = await sock.groupFetchAllParticipating();

            if (currentSocketGeneration !== myGen) {
                console.log('[Engine] Discarding group sync result from outdated socket generation.');
                return;
            }

            let updated = false;

            // 1. Delete stale groups ending in @g.us not returned by server
            for (const [jid, contact] of activeContactsMap.entries()) {
                if (jid.endsWith('@g.us') && !groups[jid]) {
                    activeContactsMap.delete(jid);
                    updated = true;
                }
            }

            // 2. Add or update current groups
            for (const jid in groups) {
                const group = groups[jid];
                const expectedName = `👥 [Group] ${group.subject}`;
                const existing = activeContactsMap.get(jid);
                if (!existing || existing.name !== expectedName) {
                    activeContactsMap.set(jid, { id: jid, name: expectedName });
                    updated = true;
                }
            }

            if (updated) {
                saveContactsCache(activeContactsMap, activeCachePath);
            }
            console.log(`[Engine] Synced ${Object.keys(groups).length} WhatsApp groups successfully.`);
            lastSyncedGeneration = myGen;
            connectionState.groupsSynced = true;
        } catch (err) {
            console.error('[Engine] Error syncing WhatsApp groups list:', formatErrorBriefly(err));
            if (currentSocketGeneration === myGen) {
                connectionState.groupsSynced = true;
            }
        } finally {
            if (currentSocketGeneration === myGen) {
                currentGroupSyncPromise = null;
            }
        }
    })();

    return currentGroupSyncPromise;
}

/* ==========================================
   SECURE LOCAL REST API (127.0.0.1 only)
   ========================================== */

function createApp(config = {}) {
    const app = express();
    const activeToken = config.ipcToken || loadOrCreateToken(config.tokenPath || tokenPath);
    const activeState = config.connectionState || connectionState;
    const getActiveSock = config.getSock || (() => sock);
    const activeContacts = config.contactsMap || contactsMap;
    const activeCachePath = config.cachePath || cachePath;
    const syncGroups = config.fetchGroupsList || (() => fetchGroupsList(activeContacts, activeCachePath));
    const clearAuth = config.deleteAuthFolder || deleteAuthFolder;

    if (!TOKEN_PATTERN.test(activeToken)) {
        throw new Error('IPC token must be a 64-character hexadecimal string.');
    }

    let sendInProgress = false;
    const uploadProgress = {
        active: false,
        fileName: '',
        bytesSent: 0,
        totalBytes: 0,
        percentage: 0,
        phase: 'idle',
        error: null
    };

    app.use(express.json({ limit: '10kb' }));

    app.use('/api', ipcSecurity.createIpcAuthMiddleware(activeToken));

    app.get('/api/status', (req, res) => {
        res.json({
            ...activeState,
            uploadProgress: { ...uploadProgress }
        });
    });

    app.get('/api/contacts', async (req, res) => {
        Promise.resolve(syncGroups()).catch(() => {});

        const list = Array.from(activeContacts.values());
        list.sort((a, b) => a.name.localeCompare(b.name));

        const currentSock = getActiveSock();
        if (currentSock && currentSock.user && currentSock.user.id) {
            const myNumber = currentSock.user.id.split(':')[0];
            list.unshift({
                id: `${myNumber}@s.whatsapp.net`,
                name: '👤 [Me] Chat with Yourself'
            });
        }
        res.json(list);
    });

    app.post('/api/logout', async (req, res) => {
        console.log('[Server] Processing logout call.');
        const currentSock = getActiveSock();
        try {
            if (currentSock && typeof currentSock.logout === 'function') {
                await currentSock.logout();
            }
            clearAuth();
            Object.assign(activeState, { status: 'disconnected', userInfo: null, qrAvailable: false, groupsSynced: false });
            res.json({ success: true, message: 'Logged out successfully.' });
        } catch (err) {
            console.error('[Server] Error handling clean logout:', err);
            clearAuth();
            Object.assign(activeState, { status: 'disconnected', userInfo: null, qrAvailable: false, groupsSynced: false });
            res.json({ success: true, message: 'Forced session wipe completed.' });
        }
    });

    app.post('/api/send', async (req, res) => {
        let fileStream = null;
        let lockAcquired = false;
        try {
            const { filePath, recipient } = req.body || {};

            if (typeof filePath !== 'string' || !filePath.trim()) {
                return res.status(400).json({ success: false, error: 'filePath parameter must be a non-empty string.' });
            }
            if (typeof recipient !== 'string' || !recipient.trim()) {
                return res.status(400).json({ success: false, error: 'recipient JID parameter must be a non-empty string.' });
            }
            if (!fs.existsSync(filePath)) {
                return res.status(400).json({ success: false, error: `Local file not found at location: ${filePath}` });
            }

            const fileStats = fs.statSync(filePath);
            if (!fileStats.isFile()) {
                return res.status(400).json({ success: false, error: 'Provided path is not a regular file.' });
            }

            const jid = formatJid(recipient);
            if (!jid) {
                return res.status(400).json({ success: false, error: 'Invalid recipient JID format.' });
            }

            const currentSock = getActiveSock();
            if (activeState.status !== 'connected' || !currentSock) {
                return res.status(400).json({ success: false, error: 'WhatsApp engine is currently disconnected.' });
            }

            if (sendInProgress) {
                return res.status(409).json({ success: false, error: 'Another file transmission is currently in progress.' });
            }
            sendInProgress = true;
            lockAcquired = true;

            const startTime = Date.now();
            const fileName = path.basename(filePath);
            const totalBytes = fileStats.size;
            Object.assign(uploadProgress, {
                active: true,
                fileName,
                bytesSent: 0,
                totalBytes,
                percentage: 0,
                phase: 'streaming',
                error: null
            });

            let lastLoggedPercent = -1;
            fileStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
            const progressStream = fileStream.pipe(new ProgressStream(totalBytes, (bytesRead, total, percentage) => {
                uploadProgress.bytesSent = bytesRead;
                uploadProgress.percentage = percentage;

                if (bytesRead >= total && uploadProgress.phase === 'streaming') {
                    uploadProgress.phase = 'awaiting_confirmation';
                }

                const rounded = Math.floor(percentage / 10) * 10;
                if (rounded > lastLoggedPercent) {
                    console.log(`[Pipeline] Streamed ${rounded}% (${(bytesRead / (1024 * 1024)).toFixed(2)} MB / ${(total / (1024 * 1024)).toFixed(2)} MB)`);
                    lastLoggedPercent = rounded;
                }
            }));

            await currentSock.sendMessage(jid, {
                document: { stream: progressStream },
                mimetype: getMimeType(filePath),
                fileName
            });

            const durationMs = Date.now() - startTime;
            const sizeMb = totalBytes / (1024 * 1024);
            const speedMbps = durationMs > 0 ? (sizeMb * 8) / (durationMs / 1000) : 0;

            uploadProgress.bytesSent = totalBytes;
            uploadProgress.percentage = 100;
            uploadProgress.phase = 'completed';

            console.log(`[Pipeline] Successfully sent ${fileName} (${sizeMb.toFixed(2)} MB) in ${(durationMs / 1000).toFixed(2)}s (${speedMbps.toFixed(2)} Mbps)`);

            res.json({ success: true, message: 'File streamed and sent successfully!' });
        } catch (err) {
            if (fileStream) {
                try { fileStream.destroy(); } catch (cleanupErr) {}
            }
            console.error('[Pipeline] High-performance transfer failed:', formatErrorBriefly(err));
            uploadProgress.phase = 'failed';
            uploadProgress.error = formatErrorBriefly(err);
            res.status(500).json({ success: false, error: 'Transmission failed: Internal server error' });
        } finally {
            if (lockAcquired) {
                sendInProgress = false;
                uploadProgress.active = false;
            }
        }
    });

    // Custom error handling middleware for Express
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.too.large') {
            return res.status(413).json({ success: false, error: 'Payload Too Large: Maximum allowed size is 10kb' });
        }
        res.status(500).json({ success: false, error: 'Transmission failed: Internal server error' });
    });

    return app;
}

function startEngine() {
    if (process.platform !== 'win32') {
        process.umask(0o077);
    }
    enforceSecurePermissions(authDir);
    const token = loadOrCreateToken();
    loadContactsCache();

    const app = createApp({
        ipcToken: token,
        connectionState,
        getSock: () => sock
    });

    const server = app.listen(PORT, '127.0.0.1', () => {
        console.log(`===========================================================`);
        console.log(` 🚀 WatsUp Desktop Engine is running locally`);
        console.log(` IPC API listening on: http://127.0.0.1:${PORT}`);
        console.log(` Strictly locked to loopback (local loop only)`);
        console.log(`===========================================================`);
    });

    connectToWhatsApp().catch((err) => {
        connectionState.status = 'disconnected';
        connectionState.userInfo = null;
        console.error('[Baileys] Failed to initialize WhatsApp connection:', err);
    });
    return server;
}

if (require.main === module) {
    try {
        startEngine();
    } catch (err) {
        console.error('[Engine] Startup failed:', err.message);
        process.exitCode = 1;
    }
}

module.exports = {
    createApp,
    startEngine,
    loadOrCreateToken,
    formatJid,
    getMimeType,
    secureAtomicWriteFile,
    secureAtomicWriteJson,
    writeQrSecurely,
    enforceSecurePermissions,
    fetchGroupsList,
    sanitizePayload,
    handleBackgroundError,
    formatErrorBriefly,
    createSanitizedLogger,
    getSocketGeneration: () => currentSocketGeneration,
    setSocketGeneration: (val) => { currentSocketGeneration = val; },
    getLastSyncedGeneration: () => lastSyncedGeneration,
    setLastSyncedGeneration: (val) => { lastSyncedGeneration = val; },
    getCurrentGroupSyncPromise: () => currentGroupSyncPromise,
    getCurrentGroupSyncPromiseGen: () => currentGroupSyncPromiseGen,
    setCurrentGroupSyncPromiseGen: (val) => { currentGroupSyncPromiseGen = val; },
    setSock: (s) => { sock = s; },
    getConnectionState: () => connectionState
};
