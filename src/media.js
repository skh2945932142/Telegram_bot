// ==========================================
// --- 多媒体交互模块：Stickers & Voice ---
// ==========================================

// ──────────────────────────────────────────
// 【贴纸配置】
// 如何获取 file_id：
//   1. 把 bot.on('sticker', logStickerFileId) 注册进 handlers.js
//   2. 把贴纸发给 Bot，它会回复对应的 file_id
//   3. 复制到下方对应情绪的数组里
// ──────────────────────────────────────────
const STICKER_POOLS = {
    LOVE:   [],
    DARK:   [],
    MANIC:  [],
    WARN:   [],
    TENDER: [],
    JELLY:  [],
    SAD:    [],
    NORMAL: [],
};

async function trySendSticker(ctx, moodTag, probability = 0.3) {
    if (Math.random() > probability) return false;
    const pool = STICKER_POOLS[moodTag] || [];
    if (pool.length === 0) return false;
    const fileId = pool[Math.floor(Math.random() * pool.length)];
    try {
        await ctx.replyWithSticker(fileId);
        return true;
    } catch (err) {
        console.warn(`⚠️ 贴纸发送失败 [${moodTag}]:`, err.message);
        return false;
    }
}

// ──────────────────────────────────────────
// 【硅基流动 TTS 语音配置】
//
// 使用你已有的 AI_API_KEY，无需额外注册
// 模型：FunAudioLLM/CosyVoice2-0.5B
//
// 情绪 → 音色 + 情感映射
// 可用音色（预置）：
//   anna, bella, claire, diana —— 女声
//   alex, bob —— 男声
//
// 情感指令通过文本前缀注入，格式：
//   "你能用[情感]的语气说吗？<|endofprompt|>正文"
// ──────────────────────────────────────────
const MOOD_VOICE_MAP = {
    LOVE:   { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',  emotion: '温柔甜蜜', speed: 0.95 },
    TENDER: { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',  emotion: '轻柔温和', speed: 0.90 },
    NORMAL: { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',  emotion: '平静',     speed: 1.00 },
    JELLY:  { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',  emotion: '委屈',     speed: 1.00 },
    SAD:    { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',  emotion: '悲伤',     speed: 0.85 },
    DARK:   { voice: 'FunAudioLLM/CosyVoice2-0.5B:diana', emotion: '冷漠',     speed: 0.85 },
    WARN:   { voice: 'FunAudioLLM/CosyVoice2-0.5B:diana', emotion: '冷漠',     speed: 0.90 },
    MANIC:  { voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',  emotion: '兴奋',     speed: 1.10 },
};

async function trySendVoice(ctx, _openai, text, moodTag, probability = 0.9) {
    if (Math.random() > probability) return;

    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) {
        console.warn('⚠️ 未找到 AI_API_KEY，语音功能跳过');
        return;
    }

    // 去掉 HTML 标签和动作描述 *...*
    const cleanText = text
        .replace(/<[^>]+>/g, '')
        .replace(/\*[^*]*\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleanText || cleanText.length < 5) return;

    const setting = MOOD_VOICE_MAP[moodTag] || MOOD_VOICE_MAP.NORMAL;

    // 通过前缀指令控制情感
    const inputText = `你能用${setting.emotion}的语气说吗？<|endofprompt|>${cleanText}`;

    try {
        await ctx.sendChatAction('record_voice');

        const response = await fetch('https://api.siliconflow.cn/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
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
            const errText = await response.text();
            console.warn(`⚠️ 硅基流动 TTS 失败 [${response.status}]:`, errText);
            return;
        }

        // 硅基流动直接返回音频二进制流
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        await ctx.replyWithVoice({ source: buffer , filename: 'yuno.mp3'});

    } catch (err) {
        console.warn(`⚠️ 语音发送失败 [${moodTag}]:`, err.message);
    }
}

// ──────────────────────────────────────────
// 辅助：打印收到的贴纸 file_id
// 在 handlers.js 末尾注册：
//   bot.on('sticker', logStickerFileId);
// ──────────────────────────────────────────
async function logStickerFileId(ctx) {
    const s = ctx.message.sticker;
    console.log(`🏷️ file_id: ${s.file_id}  emoji: ${s.emoji || '-'}  set: ${s.set_name || '-'}`);
    await ctx.reply(
        `复制这个 file_id 到 media.js 对应情绪数组里：\n<code>${s.file_id}</code>`,
        { parse_mode: 'HTML' }
    );
}

module.exports = { trySendSticker, trySendVoice, logStickerFileId };
