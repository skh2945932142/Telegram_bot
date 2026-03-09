// ==========================================
// --- 多媒体交互模块：Stickers & Voice ---
// ==========================================

// ──────────────────────────────────────────
// 【贴纸配置】
// 如何获取 file_id：
//   1. 在 Telegram 里把想要的贴纸发给你的 Bot
//   2. Bot 收到后，ctx.message.sticker.file_id 就是它
//   3. 把 file_id 填到下面对应情绪的数组里
//
// 每种情绪可以配多个贴纸，会随机选一张发送。
// ──────────────────────────────────────────
const STICKER_POOLS = {
    LOVE:   [
        // '填入 file_id_1',
        // '填入 file_id_2',
    ],
    DARK:   [
        // '填入 file_id_1',
    ],
    MANIC:  [
        // '填入 file_id_1',
    ],
    WARN:   [
        // '填入 file_id_1',
    ],
    TENDER: [
        // '填入 file_id_1',
    ],
    JELLY:  [
        // '填入 file_id_1',
    ],
    SAD:    [
        // '填入 file_id_1',
    ],
    NORMAL: [
        // '填入 file_id_1',
    ],
};

// ──────────────────────────────────────────
// 发送情绪对应的贴纸（概率触发）
//   moodTag   : 当前情绪标签（来自 calcMood）
//   probability: 0~1，发送概率，默认 0.3（30%）
// ──────────────────────────────────────────
async function trySendSticker(ctx, moodTag, probability = 0.3) {
    if (Math.random() > probability) return false;// 不触发贴纸发送

    const pool = STICKER_POOLS[moodTag] || [];
    if (pool.length === 0) return false; // 该情绪还没有配置贴纸，跳过

    const fileId = pool[Math.floor(Math.random() * pool.length)];
    try {
        await ctx.replyWithSticker(fileId);
        return true;
    } catch (err) {
        // 贴纸发送失败不应影响主流程，静默处理
        console.warn(`⚠️ 贴纸发送失败 [${moodTag}]:`, err.message);
        return false;// 失败时返回 false，允许后续尝试发送语音
    }
}

// ──────────────────────────────────────────
// 将文本转为语音并发送（OpenAI TTS）
//
// 使用方式：在 handlers.js 中对特定消息调用
//   await trySendVoice(ctx, openai, text, moodTag)
//
// 情绪 → 音色映射（OpenAI TTS 支持的 voice）：
//   nova   — 清甜明亮，适合 LOVE / TENDER
//   shimmer — 温柔略带磁性，适合 NORMAL / SAD
//   alloy  — 中性平静，适合 DARK / WARN
//   echo   — 低沉有力，适合 MANIC
// ──────────────────────────────────────────
const MOOD_VOICE_MAP = {
    LOVE:   'nova',
    TENDER: 'nova',
    SAD:    'shimmer',
    NORMAL: 'shimmer',
    JELLY:  'shimmer',
    DARK:   'alloy',
    WARN:   'alloy',
    MANIC:  'echo',
};

async function trySendVoice(ctx, openai, text, moodTag, probability = 0.2) {
    if (Math.random() > probability) return;

    // 去掉 HTML 标签再送 TTS，否则由乃会念出 "<b>阿雪</b>"
    const cleanText = text
        .replace(/<[^>]+>/g, '')   // 移除所有 HTML 标签
        .replace(/\*.*?\*/g, '')   // 移除动作描述（*动作*）
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleanText || cleanText.length < 5) return;

    const voice = MOOD_VOICE_MAP[moodTag] || 'nova';

    try {
        await ctx.sendChatAction('record_voice');

        const ttsResponse = await openai.audio.speech.create({
            model: 'tts-1',          // 速度快；高质量用 'tts-1-hd'
            voice,
            input: cleanText,
            response_format: 'ogg', // Telegram voice 消息需要 ogg/opus
            speed: 0.95,             // 略慢，更有气氛
        });

        // 将流转为 Buffer
        const arrayBuffer = await ttsResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        await ctx.replyWithVoice({ source: buffer });

    } catch (err) {
        console.warn(`⚠️ 语音发送失败 [${moodTag}]:`, err.message);
        // TTS 失败不影响主流程，静默跳过
    }
}

// ──────────────────────────────────────────
// 辅助：记录收到的贴纸 file_id（调试用）
// 在 index.js 或 handlers.js 注册：
//   bot.on('sticker', logStickerFileId)
// 然后把你喜欢的贴纸发给 Bot，控制台会打印 file_id
// ──────────────────────────────────────────
async function logStickerFileId(ctx) {
    const s = ctx.message.sticker;
    console.log(`🏷️ 收到贴纸 file_id: ${s.file_id}`);
    console.log(`   emoji: ${s.emoji || '(无)'}  set: ${s.set_name || '(无)'}`);
    await ctx.reply(
        `<code>${s.file_id}</code>\n复制这个 file_id 到 media.js 对应情绪的数组里即可 👆`,
        { parse_mode: 'HTML' }
    );
}

module.exports = { trySendSticker, trySendVoice, logStickerFileId };
