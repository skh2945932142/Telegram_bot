function extractTelegramAttachments(message = {}) {
    const attachments = [];

    if (Array.isArray(message.photo) && message.photo.length > 0) {
        attachments.push({
            type: 'photo',
            file_id: message.photo[message.photo.length - 1].file_id || '',
        });
    }

    if (message.document) {
        attachments.push({
            type: 'document',
            file_id: message.document.file_id || '',
            name: message.document.file_name || '',
        });
    }

    if (message.voice) {
        attachments.push({
            type: 'voice',
            file_id: message.voice.file_id || '',
        });
    }

    if (message.sticker) {
        attachments.push({
            type: 'sticker',
            file_id: message.sticker.file_id || '',
        });
    }

    return attachments;
}

function normalizeTelegramMessage(ctx) {
    const message = ctx.message || ctx.update?.message || {};
    const replyTo = message.reply_to_message;
    const username = ctx.botInfo?.username ? `@${ctx.botInfo.username}` : '';
    const text = String(message.text || message.caption || '').trim();
    const fullName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim();

    return {
        platform: 'telegram',
        chat_type: ctx.chat?.type === 'private' ? 'private' : String(ctx.chat?.type || 'private'),
        chat_id: String(ctx.chat?.id || ''),
        user_id: String(ctx.from?.id || ''),
        user_name: fullName || String(ctx.from?.username || '用户'),
        message_id: String(message.message_id || ''),
        reply_to: replyTo ? String(replyTo.message_id || '') : '',
        text,
        timestamp: Number(message.date || Math.floor(Date.now() / 1000)),
        mentions_bot: ctx.chat?.type === 'private' ? true : Boolean(username && text.includes(username)),
        attachments: extractTelegramAttachments(message),
        raw: message,
    };
}

module.exports = {
    normalizeTelegramMessage,
    extractTelegramAttachments,
};
