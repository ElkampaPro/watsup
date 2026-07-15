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

module.exports = {
    formatJid
};
