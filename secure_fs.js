const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function secureAtomicWriteFile(filePath, content, options = {}) {
    const dir = path.dirname(filePath);
    const tempFile = path.join(dir, '.watsup_temp_' + crypto.randomBytes(8).toString('hex') + '.tmp');
    try {
        fs.writeFileSync(tempFile, content, { ...options, mode: 0o600 });
        fs.chmodSync(tempFile, 0o600);
        fs.renameSync(tempFile, filePath);
        fs.chmodSync(filePath, 0o600);
    } catch (err) {
        throw err;
    } finally {
        try {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        } catch (e) {}
    }
}

function secureAtomicWriteJson(filePath, data) {
    const content = JSON.stringify(data, null, 2);
    secureAtomicWriteFile(filePath, content, { encoding: 'utf8' });
}

function enforceSecurePermissions(directory, options = {}) {
    if (fs.existsSync(directory)) {
        fs.chmodSync(directory, 0o700);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                enforceSecurePermissions(entryPath, options);
            } else if (entry.isFile()) {
                fs.chmodSync(entryPath, 0o600);
            }
        }
    }
    if (options.extraFiles && Array.isArray(options.extraFiles)) {
        for (const file of options.extraFiles) {
            if (fs.existsSync(file)) {
                fs.chmodSync(file, 0o600);
            }
        }
    }
}

module.exports = {
    secureAtomicWriteFile,
    secureAtomicWriteJson,
    enforceSecurePermissions
};
