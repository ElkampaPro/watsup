/**
 * WatsUp Streamer - engine.js
 * High-performance, zero-browser WhatsApp client engine.
 * Connects directly using @whiskeysockets/baileys raw websockets.
 * Exposes a secure localhost REST API to interface with local frontend wrappers.
 */

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5001;

// Enable strict JSON body parsing
app.use(express.json());

// Path declarations
const authDir = path.join(__dirname, 'auth_info_baileys');
const cachePath = path.join(__dirname, 'contacts_cache.json');

// Global engine states
let sock = null;
let connectionState = {
    status: 'disconnected', // 'disconnected' | 'connecting' | 'connected'
    userInfo: null,          // Logged-in WhatsApp details
    qrAvailable: false
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
    recipient = recipient.trim();
    if (recipient.includes('@')) {
        return recipient;
    }
    const digits = recipient.replace(/\D/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

/**
 * Spawns the raw WebSocket connection to WhatsApp Web servers
 */
async function connectToWhatsApp() {
    console.log('[Baileys] Launching WhatsApp WebSocket driver...');
    connectionState.status = 'connecting';
    connectionState.userInfo = null;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // High efficiency, silent logging configuration
    const silentLogger = pino({ 
        level: 'info',
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
        syncFullHistory: false    // Do not sync history to conserve system RAM
    });

    sock.ev.on('creds.update', saveCreds);

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
                const name = contact.name || contact.notify || contact.verifiedName || null;
                if (name) {
                    contactsMap.set(contact.id, { id: contact.id, name });
                    updated = true;
                } else if (!contactsMap.has(contact.id)) {
                    const digits = contact.id.split('@')[0];
                    contactsMap.set(contact.id, { id: contact.id, name: `+${digits}` });
                    updated = true;
                }
            }
        }
        if (updated) saveContactsCache();
    };

    sock.ev.on('messaging-history.set', ({ contacts }) => {
        console.log('[Baileys] History synced. Parsing contacts...');
        cacheContacts(contacts);
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        cacheContacts(contacts);
    });

    sock.ev.on('contacts.update', (contacts) => {
        cacheContacts(contacts);
    });
}

// Load cache and run core WebSocket
loadContactsCache();
connectToWhatsApp();

/* ==========================================
   SECURE LOCAL REST API (127.0.0.1 only)
   ========================================== */

/**
 * Returns connection state and session details
 */
app.get('/api/status', (req, res) => {
    res.json(connectionState);
});

/**
 * Returns sorted list of synced contacts
 */
app.get('/api/contacts', (req, res) => {
    const list = Array.from(contactsMap.values());
    list.sort((a, b) => a.name.localeCompare(b.name));
    res.json(list);
});

/**
 * Destroys session and wipes credentials
 */
app.post('/api/logout', async (req, res) => {
    console.log('[Server] Processing logout call.');
    try {
        if (sock) {
            await sock.logout();
        }
        deleteAuthFolder();
        connectionState = { status: 'disconnected', userInfo: null };
        res.json({ success: true, message: 'Logged out successfully.' });
    } catch (err) {
        console.error('[Server] Error handling clean logout:', err);
        deleteAuthFolder();
        connectionState = { status: 'disconnected', userInfo: null };
        res.json({ success: true, message: 'Forced session wipe completed.' });
    }
});

/**
 * Direct file-streaming pipeline.
 * Receives the local path from the local Tkinter GUI.
 * Opens a stream from that local file on the disk and pipes it directly to WhatsApp WebSockets.
 */
app.post('/api/send', async (req, res) => {
    const { filePath, recipient } = req.body;

    if (!filePath) {
        return res.status(400).json({ success: false, error: 'filePath parameter cannot be empty.' });
    }

    if (!recipient) {
        return res.status(400).json({ success: false, error: 'recipient JID parameter cannot be empty.' });
    }

    // Crucial validation: Ensure file actually exists locally
    if (!fs.existsSync(filePath)) {
        return res.status(400).json({ success: false, error: `Local file not found at location: ${filePath}` });
    }

    const jid = formatJid(recipient);
    if (!jid) {
        return res.status(400).json({ success: false, error: 'Invalid recipient JID format.' });
    }

    if (connectionState.status !== 'connected' || !sock) {
        return res.status(400).json({ success: false, error: 'WhatsApp engine is currently disconnected.' });
    }

    // Inspect file properties
    const fileStats = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const mimetype = getMimeType(filePath);

    console.log(`[Pipeline] Opening stream for transmission: ${fileName} (${(fileStats.size / (1024*1024)).toFixed(2)} MB) -> ${jid}`);

    try {
        // Direct stream: passing local disk path triggers high-efficiency background streaming & block-by-block encryption.
        // It guarantees the heap memory never holds more than a couple of blocks (~64KB each) at any given time.
        await sock.sendMessage(jid, {
            document: { url: filePath },
            mimetype: mimetype,
            fileName: fileName
        });

        console.log(`[Pipeline] Completed streaming transmission of: ${fileName}`);
        res.json({ success: true, message: 'File streamed and sent successfully!' });
    } catch (err) {
        console.error('[Pipeline] High-performance transfer failed:', err);
        res.status(500).json({ success: false, error: `Transmission failed: ${err.message}` });
    }
});

// Start Express listening strictly on localhost loopback (127.0.0.1) for isolation
app.listen(PORT, '127.0.0.1', () => {
    console.log(`===========================================================`);
    console.log(` 🚀 WatsUp Desktop Engine is running locally`);
    console.log(` IPC API listening on: http://127.0.0.1:${PORT}`);
    console.log(` Strictly locked to loopback (local loop only)`);
    console.log(`===========================================================`);
});
