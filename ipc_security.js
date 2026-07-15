const fs = require('fs');
const crypto = require('crypto');
const secureFs = require('./secure_fs.js');

const TOKEN_PATTERN = /^[a-fA-F0-9]{64}$/;

function loadOrCreateToken(customTokenPath) {
    if (!customTokenPath) {
        throw new Error('Critical: Secure IPC token could not be initialized: Token path must be specified.');
    }

    let temporaryPath = null;
    try {
        if (fs.existsSync(customTokenPath)) {
            const existingToken = fs.readFileSync(customTokenPath, 'utf8').trim();
            if (TOKEN_PATTERN.test(existingToken)) {
                fs.chmodSync(customTokenPath, 0o600);
                return existingToken;
            }
        }

        const newToken = crypto.randomBytes(32).toString('hex');
        const dir = require('path').dirname(customTokenPath);
        temporaryPath = require('path').join(dir, `.watsup_temp_token_${crypto.randomBytes(4).toString('hex')}.tmp`);
        
        secureFs.secureAtomicWriteFile(temporaryPath, newToken, { encoding: 'utf8' });
        fs.chmodSync(temporaryPath, 0o600);
        fs.renameSync(temporaryPath, customTokenPath);
        temporaryPath = null;
        fs.chmodSync(customTokenPath, 0o600);

        return newToken;
    } catch (err) {
        throw new Error(`Critical: Secure IPC token could not be initialized: ${err.message}`);
    } finally {
        if (temporaryPath && fs.existsSync(temporaryPath)) {
            try { fs.unlinkSync(temporaryPath); } catch (e) {}
        }
    }
}

function createIpcAuthMiddleware(expectedToken) {
    if (typeof expectedToken !== 'string' || !TOKEN_PATTERN.test(expectedToken)) {
        throw new Error('IPC token must be a 64-character hexadecimal string.');
    }

    const expectedBuffer = Buffer.from(expectedToken, 'utf8');

    return (req, res, next) => {
        const clientToken = req.headers['x-watsup-token'];
        if (typeof clientToken !== 'string') {
            return res.status(401).json({ success: false, error: 'Unauthorized: Missing IPC token.' });
        }

        const clientBuffer = Buffer.from(clientToken, 'utf8');
        if (clientBuffer.length !== expectedBuffer.length) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid IPC token.' });
        }

        if (!crypto.timingSafeEqual(clientBuffer, expectedBuffer)) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid IPC token.' });
        }

        next();
    };
}

module.exports = {
    TOKEN_PATTERN,
    loadOrCreateToken,
    createIpcAuthMiddleware
};
