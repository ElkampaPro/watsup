const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function secureAtomicWriteFile(filePath, content, options = {}) {
    const dir = path.dirname(filePath);
    const tempFile = path.join(dir, '.watsup_temp_' + crypto.randomBytes(8).toString('hex') + '.tmp');
    try {
        fs.writeFileSync(tempFile, content, {
            ...options,
            mode: 0o600,
            flag: 'wx'
        });
        fs.chmodSync(tempFile, 0o600);
        fs.renameSync(tempFile, filePath);
    } finally {
        try {
            if (fs.lstatSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        } catch (e) {}
    }
}

function secureAtomicWriteJson(filePath, data) {
    const content = JSON.stringify(data, null, 2);
    secureAtomicWriteFile(filePath, content, { encoding: 'utf8' });
}

function traverseDirectory(dirPath) {
    let stat;
    try {
        stat = fs.lstatSync(dirPath);
    } catch (err) {
        return;
    }

    if (stat.isSymbolicLink()) {
        throw new Error(`Security Exception: Symbolic link detected at directory traversal target: ${dirPath}`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`Security Exception: Traversal target is not a directory: ${dirPath}`);
    }

    fs.chmodSync(dirPath, 0o700);

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        let entryStat;
        try {
            entryStat = fs.lstatSync(entryPath);
        } catch (err) {
            continue;
        }

        if (entryStat.isSymbolicLink()) {
            throw new Error(`Security Exception: Symbolic link detected inside security directory: ${entryPath}`);
        }

        if (entryStat.isDirectory()) {
            traverseDirectory(entryPath);
        } else if (entryStat.isFile()) {
            fs.chmodSync(entryPath, 0o600);
        } else {
            throw new Error(`Security Exception: Unsupported file type detected in secure directory: ${entryPath}`);
        }
    }
}

function enforceSecurePermissions(directory, options = {}) {
    let stat;
    try {
        stat = fs.lstatSync(directory);
    } catch (err) {
        stat = null;
    }

    if (stat) {
        if (stat.isSymbolicLink()) {
            throw new Error(`Security Exception: Directory target cannot be a symbolic link: ${directory}`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`Security Exception: Directory target must be a directory: ${directory}`);
        }
        traverseDirectory(directory);
    }

    if (options.extraFiles && Array.isArray(options.extraFiles)) {
        for (const file of options.extraFiles) {
            let fileStat;
            try {
                fileStat = fs.lstatSync(file);
            } catch (err) {
                continue;
            }

            if (fileStat.isSymbolicLink()) {
                throw new Error(`Security Exception: Extra file cannot be a symbolic link: ${file}`);
            }
            if (!fileStat.isFile()) {
                throw new Error(`Security Exception: Extra file must be a regular file: ${file}`);
            }

            fs.chmodSync(file, 0o600);
        }
    }
}

module.exports = {
    secureAtomicWriteFile,
    secureAtomicWriteJson,
    enforceSecurePermissions
};
