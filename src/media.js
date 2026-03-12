const STICKER_POOLS = {
    LOVE: [],
    DARK: [],
    MANIC: [],
    WARN: [],
    TENDER: [],
    JELLY: [],
    SAD: [],
    NORMAL: [],
};

const MOOD_VOICE_MAP = {
    LOVE: { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna', emotion: '温柔甜一点', speed: 0.96 },
    TENDER: { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna', emotion: '轻柔安抚', speed: 0.92 },
    NORMAL: { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna', emotion: '平静自然', speed: 1.0 },
    JELLY: { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna', emotion: '带一点小别扭', speed: 1.0 },
    SAD: { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna', emotion: '低一点轻一点', speed: 0.88 },
    DARK: { voice: 'FunAudioLLM/CosyVoice2-0.5B:diana', emotion: '克制低声', speed: 0.88 },
    WARN: { voice: 'FunAudioLLM/CosyVoice2-0.5B:diana', emotion: '收着情绪', speed: 0.92 },
    MANIC: { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna', emotion: '心跳快一点', speed: 1.06 },
};

async function trySendSticker(ctx, moodTag, probability = 0.18) {
    if (Math.random() > probability) {
        return false;
    }

    const pool = STICKER_POOLS[moodTag] || [];
    if (pool.length === 0) {
        return false;
    }

    const fileId = pool[Math.floor(Math.random() * pool.length)];

    try {
        await ctx.replyWithSticker(fileId);
        return true;
    } catch (error) {
        console.warn(`sticker send failed [${moodTag}]:`, error.message);
        return false;
    }
}

async function trySendVoice(ctx, text, moodTag, probability = 0.08) {
    if (Math.random() > probability) {
        return false;
    }

    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) {
        return false;
    }

    const cleanText = String(text || '')
        .replace(/<[^>]+>/g, '')
        .replace(/\*[^*]*\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleanText || cleanText.length < 8 || cleanText.length > 140) {
        return false;
    }

    const setting = MOOD_VOICE_MAP[moodTag] || MOOD_VOICE_MAP.NORMAL;
    const inputText = `你能用${setting.emotion}的语气说吗？<|endofprompt|>${cleanText}`;

    try {
        await ctx.sendChatAction('record_voice');

        const response = await fetch('https://api.siliconflow.cn/v1/audio/speech', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'FunAudioLLM/CosyVoice2-0.5B',
                input: inputText,
                voice: setting.voice,
                speed: setting.speed,
                response_format: 'mp3',
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.warn(`tts failed [${response.status}]:`, errorText);
            return false;
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        await ctx.replyWithVoice({ source: buffer, filename: 'yuno.mp3' });
        return true;
    } catch (error) {
        console.warn(`voice send failed [${moodTag}]:`, error.message);
        return false;
    }
}

async function logStickerFileId(ctx) {
    const sticker = ctx.message.sticker;
    console.log(`sticker file_id: ${sticker.file_id} emoji: ${sticker.emoji || '-'} set: ${sticker.set_name || '-'}`);
    await ctx.reply(
        `把这个 file_id 复制到 media.js 对应情绪数组里：\n<code>${sticker.file_id}</code>`,
        { parse_mode: 'HTML' }
    );
}

module.exports = {
    trySendSticker,
    trySendVoice,
    logStickerFileId,
};
