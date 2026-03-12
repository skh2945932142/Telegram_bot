const mongoose = require('mongoose');

const DEFAULT_NICKNAME = '你';
const DEFAULT_AFFECTION = 50;
const DEFAULT_DARKNESS = 10;
const MAX_CHAT_HISTORY = 8;
const MEMORY_PREFIX_LIMIT = 10;
const OBSESS_LIMIT = 20;
const RELEVANT_MEMORY_LIMIT = 3;
const COOLDOWN_MS = 2000;
const COOLDOWN_NOTICE_MS = 6000;
const TELEGRAM_HTML_TAGS = ['b', 'i', 'u', 's', 'code'];
const SAVE_MEMORY_PREFIXES = ['事件_', '偏好_', '情感_', '关系_'];
const HIDDEN_MEMORY_PREFIXES = ['OBSESS_', 'SYS_'];

const diarySchema = new mongoose.Schema(
    {
        chatId: { type: String, required: true, unique: true },
        affection: { type: Number, default: DEFAULT_AFFECTION },
        darkness: { type: Number, default: DEFAULT_DARKNESS },
        records: { type: Map, of: String, default: {} },
        chatHistory: { type: Array, default: [] },
        lastActiveAt: { type: Date, default: Date.now },
        nickname: { type: String, default: DEFAULT_NICKNAME },
    },
    { versionKey: false }
);

const Diary = mongoose.model('Diary', diarySchema);
const cooldownMap = new Map();
const cooldownNoticeMap = new Map();

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

async function getOrCreateDiary(chatId) {
    let diary = await Diary.findOne({ chatId });
    if (!diary) {
        diary = new Diary({ chatId });
        await diary.save();
    }
    return diary;
}

function escapeHtml(input) {
    if (input === null || input === undefined) {
        return '';
    }
    return String(input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fixHtmlTags(text) {
    const allowed = new Set(TELEGRAM_HTML_TAGS);
    const stack = [];
    let result = '';
    let index = 0;

    while (index < text.length) {
        if (text[index] !== '<') {
            result += text[index];
            index += 1;
            continue;
        }

        const tagMatch = text
            .slice(index)
            .match(/^<(\/?)(b|i|u|s|code)>/i);

        if (!tagMatch) {
            result += '&lt;';
            index += 1;
            continue;
        }

        const fullTag = tagMatch[0];
        const isClosing = tagMatch[1] === '/';
        const tagName = tagMatch[2].toLowerCase();

        if (!allowed.has(tagName)) {
            result += escapeHtml(fullTag);
            index += fullTag.length;
            continue;
        }

        if (!isClosing) {
            stack.push(tagName);
            result += `<${tagName}>`;
        } else {
            const lastIndex = stack.lastIndexOf(tagName);
            if (lastIndex === -1) {
                index += fullTag.length;
                continue;
            }

            if (lastIndex === stack.length - 1) {
                stack.pop();
                result += `</${tagName}>`;
            } else {
                const tagsAbove = [];
                while (stack.length > 0 && stack[stack.length - 1] !== tagName) {
                    const tag = stack.pop();
                    result += `</${tag}>`;
                    tagsAbove.unshift(tag);
                }
                stack.pop();
                result += `</${tagName}>`;
                for (const tag of tagsAbove) {
                    stack.push(tag);
                    result += `<${tag}>`;
                }
            }
        }

        index += fullTag.length;
    }

    while (stack.length > 0) {
        result += `</${stack.pop()}>`;
    }

    return result;
}

function stripHiddenDirectives(text) {
    if (!text) {
        return '';
    }
    return String(text)
        .replace(/[\[【]\s*SAVE_MEMORY[\s\S]*?[\]】]/giu, '')
        .replace(/[\[【]\s*YUNO_OBSESS[\s\S]*?[\]】]/giu, '')
        .trim();
}

function sanitizeTelegramHtml(text) {
    if (!text) {
        return '';
    }

    const raw = String(text).replace(/\r\n/g, '\n').trim();
    let result = '';
    let index = 0;

    while (index < raw.length) {
        if (raw[index] === '<') {
            const tagMatch = raw
                .slice(index)
                .match(/^<(\/?)(b|i|u|s|code)>/i);

            if (tagMatch) {
                result += `<${tagMatch[1]}${tagMatch[2].toLowerCase()}>`;
                index += tagMatch[0].length;
                continue;
            }

            result += '&lt;';
            index += 1;
            continue;
        }

        if (raw[index] === '>') {
            result += '&gt;';
            index += 1;
            continue;
        }

        if (raw[index] === '&') {
            result += '&amp;';
            index += 1;
            continue;
        }

        result += raw[index];
        index += 1;
    }

    return fixHtmlTags(result);
}

function parseModelDirectives(text) {
    const source = String(text || '');
    const saves = [];
    const obsessions = [];

    const savePattern = /[\[【]\s*SAVE_MEMORY\s*[:：]\s*([^=】\]]+?)\s*[=＝]\s*([^[\]【】]+?)\s*[\]】]/giu;
    const obsessPattern = /[\[【]\s*YUNO_OBSESS\s*[:：]\s*([^[\]【】]+?)\s*[\]】]/giu;

    for (const match of source.matchAll(savePattern)) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (key && value) {
            saves.push({ key, value });
        }
    }

    for (const match of source.matchAll(obsessPattern)) {
        const value = match[1].trim();
        if (value) {
            obsessions.push(value);
        }
    }

    return { saves, obsessions };
}

function trimChatHistory(history) {
    return (history || []).slice(-MAX_CHAT_HISTORY);
}

function touchDiary(diary) {
    diary.lastActiveAt = new Date();
}

function isHiddenMemoryKey(key) {
    return HIDDEN_MEMORY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function getVisibleMemoryEntries(diary) {
    const entries = [];
    for (const [key, value] of diary.records.entries()) {
        if (isHiddenMemoryKey(key)) {
            continue;
        }
        entries.push({ key, value });
    }
    return entries;
}

function buildSearchTokens(text) {
    const source = String(text || '').toLowerCase();
    const tokens = new Set();
    const matches = source.match(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/gu) || [];

    for (const match of matches) {
        tokens.add(match);

        if (/^[\p{Script=Han}]+$/u.test(match) && match.length > 2) {
            const maxLength = Math.min(match.length, 6);
            for (let length = 2; length <= maxLength; length += 1) {
                for (let index = 0; index <= match.length - length; index += 1) {
                    tokens.add(match.slice(index, index + length));
                }
            }
        }
    }

    if (tokens.size > 0) {
        return [...tokens];
    }

    const fallback = source.trim();
    return fallback.length >= 2 ? [fallback] : [];
}

function selectRelevantMemories(entries, userMessage, limit = RELEVANT_MEMORY_LIMIT) {
    const tokens = buildSearchTokens(userMessage);
    if (tokens.length === 0) {
        return [];
    }

    const scored = entries
        .map((entry, index) => {
            const haystack = `${entry.key} ${entry.value}`.toLowerCase();
            let score = 0;

            for (const token of tokens) {
                if (haystack.includes(token)) {
                    score += entry.key.includes(token) ? 4 : 3;
                }
            }

            if (score === 0) {
                return null;
            }

            return {
                ...entry,
                score,
                index,
            };
        })
        .filter(Boolean)
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return right.index - left.index;
        })
        .slice(0, limit);

    return scored.map(({ key, value }) => ({ key, value }));
}

function applyMemoryUpdates(diary, directives) {
    for (const save of directives.saves) {
        diary.records.set(save.key, save.value);
    }

    for (const prefix of SAVE_MEMORY_PREFIXES) {
        const keys = [...diary.records.keys()].filter((key) => key.startsWith(prefix));
        if (keys.length > MEMORY_PREFIX_LIMIT) {
            keys.slice(0, keys.length - MEMORY_PREFIX_LIMIT).forEach((key) => diary.records.delete(key));
        }
    }

    for (const obsession of directives.obsessions) {
        diary.records.set(`OBSESS_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`, obsession);
    }

    const obsessionKeys = [...diary.records.keys()].filter((key) => key.startsWith('OBSESS_'));
    if (obsessionKeys.length > OBSESS_LIMIT) {
        obsessionKeys
            .slice(0, obsessionKeys.length - OBSESS_LIMIT)
            .forEach((key) => diary.records.delete(key));
    }
}

function applyEmotionDelta(diary, userMessage) {
    const text = String(userMessage || '');

    if (/(谢谢|抱抱|喜欢你|爱你|开心|需要你|想你|陪着我|离不开)/u.test(text)) {
        diary.affection = clamp(diary.affection + 10, 0, 100);
        diary.darkness = clamp(diary.darkness - 5, 0, 100);
    } else if (/(离开|闭嘴|讨厌|分手|不需要你|走开|烦死了|别来找我)/u.test(text)) {
        diary.darkness = clamp(diary.darkness + 18, 0, 100);
        diary.affection = clamp(diary.affection - 10, 0, 100);
    } else if (/(朋友|同学|女生|男生|喜欢她|喜欢他|好看|漂亮|暗恋|表白)/u.test(text)) {
        diary.darkness = clamp(diary.darkness + 8, 0, 100);
    } else if (/(随便|无所谓|不知道|算了|没事|不想说)/u.test(text)) {
        diary.affection = clamp(diary.affection - 5, 0, 100);
    }

    diary.darkness = clamp(diary.darkness - 1, 0, 100);
}

function calcMood(diary, userMessage = '') {
    if (diary.darkness > 80) {
        return { tag: 'DARK', desc: '情绪绷得很紧，语气变得安静又黏人，像是想把外界都隔开。' };
    }
    if (diary.affection > 90 && diary.darkness > 60) {
        return { tag: 'MANIC', desc: '依赖感和紧张感一起涌上来，话会变碎，情绪起伏很快。' };
    }
    if (diary.darkness > 50) {
        return { tag: 'WARN', desc: '开始警觉周围的人和事，表面平静，实际上一直在盯着气氛变化。' };
    }
    if (diary.darkness > 30 && diary.affection > 60) {
        return { tag: 'TENDER', desc: '温柔里带一点过度在意，像是想把你照顾得再近一点。' };
    }
    if (diary.affection > 80) {
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

function parseBirthdayInput(input) {
    const raw = String(input || '').trim();
    if (!/^\d{1,2}-\d{1,2}$/.test(raw)) {
        return null;
    }

    const [monthRaw, dayRaw] = raw.split('-');
    const month = Number(monthRaw);
    const day = Number(dayRaw);

    if (month < 1 || month > 12) {
        return null;
    }

    const maxDay = new Date(2024, month, 0).getDate();
    if (day < 1 || day > maxDay) {
        return null;
    }

    return `${month}-${day}`;
}

function getMonthDayInTimezone(date = new Date(), timeZone = 'Asia/Shanghai') {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'numeric',
        day: 'numeric',
    });
    const parts = formatter.formatToParts(date);
    const month = parts.find((part) => part.type === 'month').value;
    const day = parts.find((part) => part.type === 'day').value;
    return `${Number(month)}-${Number(day)}`;
}

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
    Diary,
    DEFAULT_NICKNAME,
    DEFAULT_AFFECTION,
    DEFAULT_DARKNESS,
    MAX_CHAT_HISTORY,
    MEMORY_PREFIX_LIMIT,
    OBSESS_LIMIT,
    RELEVANT_MEMORY_LIMIT,
    COOLDOWN_MS,
    COOLDOWN_NOTICE_MS,
    cooldownMap,
    cooldownNoticeMap,
    TELEGRAM_HTML_TAGS,
    SAVE_MEMORY_PREFIXES,
    getOrCreateDiary,
    clamp,
    escapeHtml,
    fixHtmlTags,
    stripHiddenDirectives,
    sanitizeTelegramHtml,
    parseModelDirectives,
    trimChatHistory,
    touchDiary,
    getVisibleMemoryEntries,
    selectRelevantMemories,
    applyMemoryUpdates,
    applyEmotionDelta,
    calcMood,
    buildKeyboard,
    parseBirthdayInput,
    getMonthDayInTimezone,
    getHourInTimezone,
    getTimeHint,
};
