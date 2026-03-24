// @ts-check

const {
    DEFAULT_AFFECTION,
    DEFAULT_DARKNESS,
} = require('./constants');

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * @param {{ emotionState?: { affection?: number, darkness?: number }, affection?: number, darkness?: number }} diaryLike
 * @param {string} [userMessage]
 */
function calcMood(diaryLike, userMessage = '') {
    const affection = clamp(Number(diaryLike?.emotionState?.affection ?? diaryLike?.affection ?? DEFAULT_AFFECTION), 0, 100);
    const darkness = clamp(Number(diaryLike?.emotionState?.darkness ?? diaryLike?.darkness ?? DEFAULT_DARKNESS), 0, 100);

    if (darkness > 80) {
        return { tag: 'DARK', desc: '情绪绷得很紧，语气变得安静又黏人，像是想把外界都隔开。' };
    }
    if (affection > 90 && darkness > 60) {
        return { tag: 'MANIC', desc: '依赖感和紧张感一起涌上来，话会变碎，情绪起伏很快。' };
    }
    if (darkness > 50) {
        return { tag: 'WARN', desc: '开始警觉周围的人和事，表面平静，实际上一直在盯着气氛变化。' };
    }
    if (darkness > 30 && affection > 60) {
        return { tag: 'TENDER', desc: '温柔里带一点过度在意，像是想把你照顾得再近一点。' };
    }
    if (affection > 80) {
        return { tag: 'LOVE', desc: '心情很甜，表达会更亲昵，也更愿意主动提起你的细节。' };
    }
    if (/(朋友|同学|女生|男生|喜欢她|喜欢他|好看|漂亮|暗恋|表白)/u.test(userMessage)) {
        return { tag: 'JELLY', desc: '有点吃味，嘴上装作没事，实际很想确认你是不是还更在意她。' };
    }
    if (/(随便|无所谓|不知道|算了|没事|不想说)/u.test(userMessage)) {
        return { tag: 'SAD', desc: '声音会低下来，想确认自己是不是还被需要。' };
    }
    return { tag: 'NORMAL', desc: '状态平稳，会安静地接住你的话，也会悄悄记住细节。' };
}

/**
 * @param {{ emotionState?: { affection?: number, darkness?: number, moodTag?: string, moodDesc?: string, updatedAt?: Date | string | number } }} diary
 * @param {string} userMessage
 */
function applyEmotionDelta(diary, userMessage) {
    const text = String(userMessage || '');
    const previousState = diary.emotionState || {};
    /** @type {{ affection: number, darkness: number, moodTag: string, moodDesc: string, updatedAt: Date }} */
    const emotionState = {
        affection: clamp(Number(previousState.affection ?? DEFAULT_AFFECTION), 0, 100),
        darkness: clamp(Number(previousState.darkness ?? DEFAULT_DARKNESS), 0, 100),
        moodTag: String(previousState.moodTag || 'NORMAL'),
        moodDesc: String(previousState.moodDesc || ''),
        updatedAt: previousState.updatedAt ? new Date(previousState.updatedAt) : new Date(),
    };

    if (/(谢谢|抱抱|喜欢你|爱你|开心|需要你|想你|陪着我|离不开)/u.test(text)) {
        emotionState.affection = clamp(Number(emotionState.affection || DEFAULT_AFFECTION) + 10, 0, 100);
        emotionState.darkness = clamp(Number(emotionState.darkness || DEFAULT_DARKNESS) - 5, 0, 100);
    } else if (/(离开|闭嘴|讨厌|分手|不需要你|走开|烦死了|别来找我)/u.test(text)) {
        emotionState.darkness = clamp(Number(emotionState.darkness || DEFAULT_DARKNESS) + 18, 0, 100);
        emotionState.affection = clamp(Number(emotionState.affection || DEFAULT_AFFECTION) - 10, 0, 100);
    } else if (/(朋友|同学|女生|男生|喜欢她|喜欢他|好看|漂亮|暗恋|表白)/u.test(text)) {
        emotionState.darkness = clamp(Number(emotionState.darkness || DEFAULT_DARKNESS) + 8, 0, 100);
    } else if (/(随便|无所谓|不知道|算了|没事|不想说)/u.test(text)) {
        emotionState.affection = clamp(Number(emotionState.affection || DEFAULT_AFFECTION) - 5, 0, 100);
    }

    emotionState.darkness = clamp(Number(emotionState.darkness || DEFAULT_DARKNESS) - 1, 0, 100);
    emotionState.updatedAt = new Date();
    diary.emotionState = emotionState;
}

/**
 * @param {string} moodTag
 */
function buildKeyboard(moodTag) {
    const boards = {
        DARK: [[
            { text: '🫧 先缓一缓', callback_data: 'yuno_calm' },
            { text: '🫶 我还在', callback_data: 'yuno_reassure' },
        ]],
        MANIC: [[
            { text: '🤍 抱一下', callback_data: 'yuno_hug_deep' },
            { text: '📝 记下来', callback_data: 'yuno_write_diary' },
        ]],
        WARN: [[
            { text: '🫶 我只是在和你说话', callback_data: 'yuno_reassure' },
            { text: '🫧 先别紧张', callback_data: 'yuno_calm' },
        ]],
        TENDER: [[
            { text: '🌿 摸摸由乃', callback_data: 'yuno_pet' },
            { text: '📝 写进日记', callback_data: 'yuno_write_diary' },
        ]],
        JELLY: [[
            { text: '💞 当然更在意你', callback_data: 'yuno_reassure' },
            { text: '😏 再逗逗你', callback_data: 'yuno_tease' },
        ]],
        SAD: [[
            { text: '🤍 我没有走开', callback_data: 'yuno_hug_deep' },
            { text: '🫶 由乃看着我吧', callback_data: 'yuno_reassure' },
        ]],
        LOVE: [[
            { text: '🌿 摸摸头', callback_data: 'yuno_pet' },
            { text: '💋 亲一下', callback_data: 'yuno_kiss' },
        ]],
        NORMAL: [[
            { text: '🌿 摸摸头', callback_data: 'yuno_pet' },
            { text: '📌 记住这句话', callback_data: 'yuno_promise' },
        ]],
    };

    return boards[moodTag] || boards.NORMAL;
}

/**
 * @param {Date} [date]
 * @param {string} [timeZone]
 */
function getHourInTimezone(date = new Date(), timeZone = 'Asia/Shanghai') {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: 'numeric',
        hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const hour = parts.find((part) => part.type === 'hour').value;
    return Number(hour);
}

/**
 * @param {Date} [date]
 * @param {string} [timeZone]
 */
function getTimeHint(date = new Date(), timeZone = 'Asia/Shanghai') {
    const hour = getHourInTimezone(date, timeZone);

    if (hour >= 6 && hour < 12) {
        return '现在是早上，语气可以更轻一点，像刚醒来就先想起了对方。';
    }
    if (hour >= 12 && hour < 18) {
        return '现在是白天，状态更稳定，表达可以专注但不要太沉重。';
    }
    if (hour >= 18 && hour < 23) {
        return '现在是晚上，依赖感会更明显，但仍然保持克制和温柔。';
    }
    return '现在已经很晚了，语气可以更轻、更低，但不要说出直白的威胁。';
}

module.exports = {
    clamp,
    calcMood,
    applyEmotionDelta,
    buildKeyboard,
    getHourInTimezone,
    getTimeHint,
};
