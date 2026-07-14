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

// Global process safety handlers to catch any Baileys internal async errors
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Engine] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[Engine] Uncaught Exception:', err);
});

const PORT = 5001;

// Path declarations
const authDir = path.join(__dirname, 'auth_info_baileys');
const cachePath = path.join(__dirname, 'contacts_cache.json');
const tokenPath = path.join(__dirname, '.watsup_ipc_token');
const TOKEN_PATTERN = /^[a-fA-F0-9]{64}$/;

let ipcToken = null;

/**
 * Loads a valid IPC token or replaces an invalid/missing token atomically.
 * Passing a custom path keeps tests isolated from the real project token.
 */
function loadOrCreateToken(customTokenPath = tokenPath) {
    if (customTokenPath === tokenPath && ipcToken) {
        return ipcToken;
    }

    let temporaryPath = null;
    try {
        if (fs.existsSync(customTokenPath)) {
            const existingToken = fs.readFileSync(customTokenPath, 'utf8').trim();
            if (TOKEN_PATTERN.test(existingToken)) {
                fs.chmodSync(customTokenPath, 0o600);
                if (customTokenPath === tokenPath) ipcToken = existingToken;
                return existingToken;
            }
        }

        const newToken = crypto.randomBytes(32).toString('hex');
        temporaryPath = `${customTokenPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(temporaryPath, newToken, { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(temporaryPath, 0o600);
        fs.renameSync(temporaryPath, customTokenPath);
        temporaryPath = null;
        fs.chmodSync(customTokenPath, 0o600);

        if (customTokenPath === tokenPath) ipcToken = newToken;
        return newToken;
    } catch (err) {
        if (temporaryPath && fs.existsSync(temporaryPath)) {
            try { fs.unlinkSync(temporaryPath); } catch (cleanupErr) {}
        }
        throw new Error(`Critical: Secure IPC token could not be initialized: ${err.message}`);
    }
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
function saveContactsCache() {
    try {
        const cachedList = Array.from(contactsMap.values());
        fs.writeFileSync(cachePath, JSON.stringify(cachedList, null, 2), 'utf8');
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

/**
 * Validates and formats international digits into a WhatsApp standard JID
 */
function formatJid(recipient) {
    if (typeof recipient !== 'string') return null;
    recipient = recipient.trim();
    if (recipient.includes('@')) {
        const isUserJid = /^\d{5,20}@s\.whatsapp\.net$/.test(recipient);
        const isGroupJid = /^\d+(?:-\d+)?@g\.us$/.test(recipient);
        const isLidJid = /^\d+@lid$/.test(recipient);
        return isUserJid || isGroupJid || isLidJid ? recipient : null;
    }

    if (!/^\+?[\d\s()\-]+$/.test(recipient)) return null;
    const digits = recipient.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 20) return null;
    return `${digits}@s.whatsapp.net`;
}

function enforceSecurePermissions(directory = authDir) {
    if (!fs.existsSync(directory)) return;

    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            enforceSecurePermissions(entryPath);
        } else if (entry.isFile()) {
            fs.chmodSync(entryPath, 0o600);
        }
    }
}

/**
 * Spawns the raw WebSocket connection to WhatsApp Web servers
 */
async function connectToWhatsApp() {
    console.log('[Baileys] Launching WhatsApp WebSocket driver...');
    connectionState.status = 'connecting';
    connectionState.userInfo = null;

    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    }
    enforceSecurePermissions(authDir);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // High efficiency, silent logging configuration
    const silentLogger = pino({ 
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
            QRCode.toFile(path.join(__dirname, 'qr.png'), qr, {
                width: 260,
                margin: 1
            }, (err) => {
                if (err) {
                    console.error('[Engine] Failed to save QR code image:', err);
                } else {
                    console.log('[Engine] QR code image written to disk: qr.png');
                }
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
            console.log(`Linked User: +${sock.user.id.split(':')[0]} (${sock.user.name || 'Device'})`);
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
async function fetchGroupsList() {
    if (!sock || connectionState.status !== 'connected') return;
    const now = Date.now();
    // Throttle group syncs to at most once every 60 seconds, unless we have no groups in cache yet
    const hasGroups = Array.from(contactsMap.keys()).some(k => k.endsWith('@g.us'));
    if (hasGroups && (now - lastGroupSyncTime < 60000)) {
        connectionState.groupsSynced = true;
        return;
    }
    
    try {
        console.log('[Engine] Syncing WhatsApp groups list from server...');
        const groups = await sock.groupFetchAllParticipating();
        let updated = false;
        for (const jid in groups) {
            const group = groups[jid];
            const name = `👥 [Group] ${group.subject}`;
            contactsMap.set(jid, { id: jid, name });
            updated = true;
        }
        if (updated) {
            saveContactsCache();
            console.log(`[Engine] Synced ${Object.keys(groups).length} WhatsApp groups successfully.`);
        }
        lastGroupSyncTime = now;
        connectionState.groupsSynced = true;
    } catch (err) {
        console.error('[Engine] Error syncing WhatsApp groups list:', err);
        connectionState.groupsSynced = true;
    }
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
    const syncGroups = config.fetchGroupsList || fetchGroupsList;
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
        percentage: 0
    };

    app.use(express.json({ limit: '64kb' }));

    app.use('/api', (req, res, next) => {
        const clientToken = req.headers['x-watsup-token'];
        if (typeof clientToken !== 'string') {
            return res.status(401).json({ success: false, error: 'Unauthorized: Missing IPC token.' });
        }

        const clientBuffer = Buffer.from(clientToken, 'utf8');
        const expectedBuffer = Buffer.from(activeToken, 'utf8');
        if (clientBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(clientBuffer, expectedBuffer)) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid IPC token.' });
        }
        next();
    });

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

            const fileName = path.basename(filePath);
            const totalBytes = fileStats.size;
            Object.assign(uploadProgress, {
                active: true,
                fileName,
                bytesSent: 0,
                totalBytes,
                percentage: 0
            });

            let lastLoggedPercent = -1;
            fileStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
            const progressStream = fileStream.pipe(new ProgressStream(totalBytes, (bytesRead, total, percentage) => {
                uploadProgress.bytesSent = bytesRead;
                uploadProgress.percentage = percentage;

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

            uploadProgress.bytesSent = totalBytes;
            uploadProgress.percentage = 100;
            res.json({ success: true, message: 'File streamed and sent successfully!' });
        } catch (err) {
            if (fileStream) {
                try { fileStream.destroy(); } catch (cleanupErr) {}
            }
            console.error('[Pipeline] High-performance transfer failed:', err);
            res.status(500).json({ success: false, error: `Transmission failed: ${err.message}` });
        } finally {
            if (lockAcquired) {
                sendInProgress = false;
                uploadProgress.active = false;
            }
        }
    });

    return app;
}

function startEngine() {
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
    getMimeType
};
