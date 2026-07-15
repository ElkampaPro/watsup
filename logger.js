const pino = require('pino');

function formatErrorBriefly(err) {
    if (!err) return 'Unknown error';
    let message = err.message || String(err);
    message = message.replace(/[a-fA-F0-9]{64}/g, '[REDACTED_HEX_64]');
    message = message.replace(/(?:session|token|qr|key)/gi, (m) => `[REDACTED_${m.toUpperCase()}]`);
    const errorType = err.name || 'Error';
    const statusCode = err.statusCode || (err.output && err.output.statusCode) || '';
    const code = err.code || '';
    let brief = `[${errorType}] ${message}`;
    if (statusCode) brief += ` (Status: ${statusCode})`;
    if (code) brief += ` (Code: ${code})`;
    return brief;
}

function sanitizePayload(val, depth = 0) {
    if (depth > 4) return '[REDACTED_MAX_DEPTH]';
    if (val === null || val === undefined) return val;

    if (typeof val === 'object' && (Buffer.isBuffer(val) || val.constructor?.name === 'Buffer' || val._isBuffer)) {
        return '[REDACTED_BUFFER]';
    }

    if (Array.isArray(val)) {
        return val.map(item => sanitizePayload(item, depth + 1));
    }

    if (val instanceof Error) {
        const sanitizedErr = {
            name: val.name,
            message: sanitizePayload(val.message, depth + 1),
            statusCode: val.statusCode || (val.output && val.output.statusCode)
        };
        if (val.code) sanitizedErr.code = val.code;
        return sanitizedErr;
    }

    if (typeof val === 'object') {
        if (val.type === 'Buffer' && Array.isArray(val.data)) {
            return '[REDACTED_BUFFER]';
        }
        const sanitized = {};
        for (const k of Object.keys(val)) {
            const kl = k.toLowerCase();
            if (kl === 'token' || kl === 'ipctoken' || kl === 'qr' || kl === 'key' || kl === 'session' || kl === 'raw' || kl === 'content') {
                sanitized[k] = `[REDACTED_${k.toUpperCase()}]`;
            } else {
                sanitized[k] = sanitizePayload(val[k], depth + 1);
            }
        }
        return sanitized;
    }

    if (typeof val === 'string') {
        let msg = val;
        msg = msg.replace(/[a-fA-F0-9]{128,}/g, '[REDACTED_HEX_LARGE]');
        msg = msg.replace(/[a-fA-F0-9]{64}/g, '[REDACTED_HEX_64]');
        msg = msg.replace(/(?:session|token|qr|key)/gi, (m) => `[REDACTED_${m.toUpperCase()}]`);
        msg = msg.replace(/node\.content/gi, '[REDACTED_NODE_CONTENT]');
        msg = msg.replace(/Buffer\s*<[a-fA-F0-9\s]*>/gi, '[REDACTED_BUFFER]');
        msg = msg.replace(/\b\d{5,20}@(s\.whatsapp\.net|g\.us|c\.us)\b/g, '[REDACTED_JID]');
        return msg;
    }

    return val;
}

function createSanitizedLogger(destination, options = {}) {
    const defaultPaths = [
        '*.content',
        '*.raw',
        '*.key',
        '*.message.conversation',
        '*.message.extendedTextMessage',
        'token',
        'ipcToken',
        'qr'
    ];

    const pinoOptions = {
        level: options.level || 'warn',
        formatters: {
            log(object) {
                return sanitizePayload(object);
            }
        },
        redact: {
            paths: defaultPaths,
            censor: '[REDACTED]'
        }
    };

    if (options.transport && !destination) {
        pinoOptions.transport = options.transport;
    }

    return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}

module.exports = {
    formatErrorBriefly,
    sanitizePayload,
    createSanitizedLogger
};
