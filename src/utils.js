const mongoose = require('mongoose');

const DEFAULT_NICKNAME = '你';
const DEFAULT_AFFECTION = 50;
const DEFAULT_DARKNESS = 10;
const MAX_CHAT_HISTORY = 8;
const SUMMARY_TRIGGER_TURNS = 6;
const MEMORY_PREFIX_LIMIT = 10;
const OBSESS_LIMIT = 20;
const LONG_TERM_MEMORY_LIMIT = 32;
const RELEVANT_MEMORY_LIMIT = 3;
const COOLDOWN_MS = 2000;
const COOLDOWN_NOTICE_MS = 6000;
const TELEGRAM_HTML_TAGS = ['b', 'i', 'u', 's', 'code'];
const SAVE_MEMORY_PREFIXES = ['事件_', '偏好_', '情感_', '关系_'];
const HIDDEN_MEMORY_PREFIXES = ['OBSESS_', 'SYS_'];
const MEMORY_CATEGORY_LABELS = {
    preference: '偏好',
    boundary: '边界',
    topic: '话题',
    event: '事件',
    relationship: '关系',
    roleplay: '设定',
    profile: '资料',
};

const longTermMemorySchema = new mongoose.Schema(
    {
        category: { type: String, default: 'event' },
        key: { type: String, default: '' },
        value: { type: String, default: '' },
        source: { type: String, default: 'legacy' },
        lastConfirmed: { type: Date, default: Date.now },
        weight: { type: Number, default: 0.5 },
    },
    { _id: false }
);

const sessionTurnSchema = new mongoose.Schema(
    {
        role: { type: String, default: 'user' },
        content: { type: String, default: '' },
        timestamp: { type: Date, default: Date.now },
    },
    { _id: false }
);

const profileSchema = new mongoose.Schema(
    {
        nickname: { type: String, default: DEFAULT_NICKNAME },
        preferredName: { type: String, default: '' },
        preferredTone: { type: String, default: '' },
        topics: { type: [String], default: [] },
        boundaries: { type: [String], default: [] },
        birthday: { type: String, default: '' },
    },
    { _id: false }
);

const emotionStateSchema = new mongoose.Schema(
    {
        affection: { type: Number, default: DEFAULT_AFFECTION },
        darkness: { type: Number, default: DEFAULT_DARKNESS },
        moodTag: { type: String, default: 'NORMAL' },
        moodDesc: { type: String, default: '' },
        updatedAt: { type: Date, default: Date.now },
    },
    { _id: false }
);

const sessionSchema = new mongoose.Schema(
    {
        recentTurns: { type: [sessionTurnSchema], default: [] },
        threadSummary: { type: String, default: '' },
        turnsSinceSummary: { type: Number, default: 0 },
        lastMessageAt: { type: Date, default: Date.now },
    },
    { _id: false }
);

const diarySchema = new mongoose.Schema(
    {
        chatId: { type: String, required: true, unique: true },
        affection: { type: Number, default: DEFAULT_AFFECTION },
        darkness: { type: Number, default: DEFAULT_DARKNESS },
        records: { type: Map, of: String, default: {} },
        chatHistory: { type: Array, default: [] },
        lastActiveAt: { type: Date, default: Date.now },
        nickname: { type: String, default: DEFAULT_NICKNAME },
        profile: { type: profileSchema, default: () => ({}) },
        emotionState: { type: emotionStateSchema, default: () => ({}) },
        session: { type: sessionSchema, default: () => ({}) },
        longTermMemories: { type: [longTermMemorySchema], default: [] },
        legacyRecords: { type: Map, of: String, default: {} },
    },
    { versionKey: false }
);

const Diary = mongoose.models.Diary || mongoose.model('Diary', diarySchema);
const cooldownMap = new Map();
const cooldownNoticeMap = new Map();

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function createDefaultProfile(seed = {}) {
    return {
        nickname: seed.nickname || DEFAULT_NICKNAME,
        preferredName: seed.preferredName || '',
        preferredTone: seed.preferredTone || '',
        topics: Array.isArray(seed.topics) ? uniqueCompactStrings(seed.topics) : [],
        boundaries: Array.isArray(seed.boundaries) ? uniqueCompactStrings(seed.boundaries) : [],
        birthday: seed.birthday || '',
    };
}

function createDefaultEmotionState(seed = {}) {
    return {
        affection: clamp(Number(seed.affection ?? DEFAULT_AFFECTION), 0, 100),
        darkness: clamp(Number(seed.darkness ?? DEFAULT_DARKNESS), 0, 100),
        moodTag: String(seed.moodTag || 'NORMAL'),
        moodDesc: String(seed.moodDesc || ''),
        updatedAt: seed.updatedAt ? new Date(seed.updatedAt) : new Date(),
    };
}

function createDefaultSession(seed = {}) {
    return {
        recentTurns: normalizeTurns(seed.recentTurns || []),
        threadSummary: String(seed.threadSummary || ''),
        turnsSinceSummary: Math.max(0, Number(seed.turnsSinceSummary || 0)),
        lastMessageAt: seed.lastMessageAt ? new Date(seed.lastMessageAt) : new Date(),
    };
}

function normalizeTurns(turns) {
    return trimChatHistory(
        (turns || [])
            .map(normalizeTurn)
            .filter(Boolean)
    );
}

function normalizeTurn(turn) {
    if (!turn || typeof turn !== 'object') {
        return null;
    }

    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    const content = stripToPlainText(turn.content || turn.text || '');
    if (!content) {
        return null;
    }

    const timestamp = turn.timestamp ? new Date(turn.timestamp) : new Date();
    return {
        role,
        content,
        timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
    };
}

function normalizeMemory(memory) {
    if (!memory || typeof memory !== 'object') {
        return null;
    }

    const category = normalizeMemoryCategory(memory.category || inferMemoryCategoryFromKey(memory.key));
    const key = String(memory.key || buildMemoryKey(category, memory.value)).trim();
    const value = stripToPlainText(memory.value || '');

    if (!key || !value) {
        return null;
    }

    const lastConfirmed = memory.lastConfirmed ? new Date(memory.lastConfirmed) : new Date();
    const weight = clamp(Number(memory.weight ?? 0.55), 0.1, 1);

    return {
        category,
        key,
        value,
        source: String(memory.source || 'legacy'),
        lastConfirmed: Number.isNaN(lastConfirmed.getTime()) ? new Date() : lastConfirmed,
        weight,
    };
}

function normalizeMemoryCategory(category) {
    const value = String(category || '').trim().toLowerCase();
    if (['preference', 'boundary', 'topic', 'event', 'relationship', 'roleplay', 'profile'].includes(value)) {
        return value;
    }
    return 'event';
}

function inferMemoryCategoryFromKey(key) {
    const value = String(key || '').trim();
    if (!value) {
        return 'event';
    }
    if (value.startsWith('偏好_')) {
        return 'preference';
    }
    if (value.startsWith('关系_')) {
        return 'relationship';
    }
    if (value.startsWith('情感_')) {
        return 'boundary';
    }
    if (value.startsWith('事件_')) {
        return 'event';
    }
    if (value === '生日' || value === '称呼') {
        return 'profile';
    }
    return 'event';
}

function buildMemoryKey(category, value = '') {
    const compactValue = stripToPlainText(value).slice(0, 18);
    const prefix = {
        preference: '偏好',
        boundary: '边界',
        topic: '话题',
        event: '事件',
        relationship: '关系',
        roleplay: '设定',
        profile: '资料',
    }[normalizeMemoryCategory(category)] || '事件';

    return compactValue ? `${prefix}_${compactValue}` : prefix;
}

function stripToPlainText(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[\[【]\s*(?:SAVE_MEMORY|YUNO_OBSESS)[\s\S]*?[\]】]/giu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function uniqueCompactStrings(values, limit = 8) {
    const seen = new Set();
    const result = [];

    for (const value of values || []) {
        const text = stripToPlainText(value);
        if (!text) {
            continue;
        }
        const token = text.toLowerCase();
        if (seen.has(token)) {
            continue;
        }
        seen.add(token);
        result.push(text);
        if (result.length >= limit) {
            break;
        }
    }

    return result;
}

function getMapEntries(mapLike) {
    if (!mapLike) {
        return [];
    }
    if (typeof mapLike.entries === 'function') {
        return [...mapLike.entries()];
    }
    return Object.entries(mapLike);
}

function createMapFromEntries(entries) {
    const map = new Map();
    for (const [key, value] of entries || []) {
        if (key === undefined || key === null) {
            continue;
        }
        map.set(String(key), String(value ?? ''));
    }
    return map;
}

function getLegacyRecordsMap(diary) {
    return createMapFromEntries(getMapEntries(diary.legacyRecords || diary.records));
}

function setLegacyRecord(diary, key, value) {
    const nextMap = getLegacyRecordsMap(diary);
    nextMap.set(String(key), String(value ?? ''));
    diary.legacyRecords = nextMap;
    diary.markModified('legacyRecords');
}

function getLegacyRecord(diary, key) {
    return getLegacyRecordsMap(diary).get(String(key));
}

function deleteLegacyRecord(diary, key) {
    const nextMap = getLegacyRecordsMap(diary);
    nextMap.delete(String(key));
    diary.legacyRecords = nextMap;
    diary.markModified('legacyRecords');
}

function syncDiaryCompatibilityFields(diary) {
    const profile = diary.profile || createDefaultProfile();
    const emotionState = diary.emotionState || createDefaultEmotionState();
    const session = diary.session || createDefaultSession();
    const legacyRecords = getLegacyRecordsMap(diary);

    if (profile.birthday) {
        legacyRecords.set('生日', profile.birthday);
    } else {
        legacyRecords.delete('生日');
    }

    for (const memory of diary.longTermMemories || []) {
        if (memory && memory.key && memory.value) {
            legacyRecords.set(memory.key, memory.value);
        }
    }

    diary.profile = profile;
    diary.emotionState = emotionState;
    diary.session = session;
    diary.legacyRecords = legacyRecords;
    diary.records = createMapFromEntries(getMapEntries(legacyRecords));
    diary.nickname = profile.nickname || DEFAULT_NICKNAME;
    diary.affection = clamp(Number(emotionState.affection ?? diary.affection), 0, 100);
    diary.darkness = clamp(Number(emotionState.darkness ?? diary.darkness), 0, 100);
    diary.chatHistory = trimChatHistory((session.recentTurns || []).map((turn) => ({
        role: turn.role,
        content: turn.content,
    })));
    diary.lastActiveAt = session.lastMessageAt || diary.lastActiveAt || new Date();
}

function ensureDiaryState(diary) {
    let changed = false;

    if (!diary.profile) {
        diary.profile = createDefaultProfile({ nickname: diary.nickname });
        changed = true;
    } else {
        diary.profile = createDefaultProfile(diary.profile);
    }

    if (!diary.emotionState) {
        diary.emotionState = createDefaultEmotionState({
            affection: diary.affection,
            darkness: diary.darkness,
        });
        changed = true;
    } else {
        diary.emotionState = createDefaultEmotionState({
            ...diary.emotionState,
            affection: diary.emotionState.affection ?? diary.affection,
            darkness: diary.emotionState.darkness ?? diary.darkness,
        });
    }

    if (!diary.session) {
        diary.session = createDefaultSession({
            recentTurns: diary.chatHistory,
            lastMessageAt: diary.lastActiveAt,
        });
        changed = true;
    } else {
        diary.session = createDefaultSession({
            ...diary.session,
            recentTurns: diary.session.recentTurns?.length ? diary.session.recentTurns : diary.chatHistory,
            lastMessageAt: diary.session.lastMessageAt || diary.lastActiveAt,
        });
    }

    if (!Array.isArray(diary.longTermMemories)) {
        diary.longTermMemories = [];
        changed = true;
    } else {
        diary.longTermMemories = diary.longTermMemories
            .map(normalizeMemory)
            .filter(Boolean);
    }

    const legacyRecords = getLegacyRecordsMap(diary);
    if (legacyRecords.size === 0 && getMapEntries(diary.records).length > 0) {
        diary.legacyRecords = createMapFromEntries(getMapEntries(diary.records));
        changed = true;
    } else {
        diary.legacyRecords = legacyRecords;
    }

    if ((!diary.profile.nickname || diary.profile.nickname === DEFAULT_NICKNAME) && diary.nickname) {
        diary.profile.nickname = diary.nickname;
        changed = true;
    }

    const birthday = getLegacyRecord(diary, '生日');
    if (!diary.profile.birthday && birthday) {
        diary.profile.birthday = birthday;
        changed = true;
    }

    for (const [key, value] of getMapEntries(diary.legacyRecords)) {
        if (!key || isHiddenMemoryKey(key) || key === '生日') {
            continue;
        }

        const memory = normalizeMemory({
            category: inferMemoryCategoryFromKey(key),
            key,
            value,
            source: 'legacy',
            weight: key.startsWith('偏好_') || key.startsWith('关系_') ? 0.78 : 0.6,
        });

        if (memory) {
            const exists = diary.longTermMemories.some((item) => item && item.key === memory.key);
            if (!exists) {
                diary.longTermMemories.push(memory);
                changed = true;
            }
        }
    }

    diary.longTermMemories = diary.longTermMemories
        .map(normalizeMemory)
        .filter(Boolean)
        .sort((left, right) => {
            const leftScore = new Date(left.lastConfirmed).getTime() + left.weight * 1000;
            const rightScore = new Date(right.lastConfirmed).getTime() + right.weight * 1000;
            return rightScore - leftScore;
        })
        .slice(0, LONG_TERM_MEMORY_LIMIT);

    const mood = calcMood({
        affection: diary.emotionState.affection,
        darkness: diary.emotionState.darkness,
    });
    if (diary.emotionState.moodTag !== mood.tag || diary.emotionState.moodDesc !== mood.desc) {
        diary.emotionState.moodTag = mood.tag;
        diary.emotionState.moodDesc = mood.desc;
        changed = true;
    }

    syncDiaryCompatibilityFields(diary);
    if (changed) {
        diary.markModified('profile');
        diary.markModified('emotionState');
        diary.markModified('session');
        diary.markModified('longTermMemories');
        diary.markModified('legacyRecords');
    }

    return diary;
}

async function getOrCreateDiary(chatId, seed = {}) {
    let diary = await Diary.findOne({ chatId });
    if (!diary) {
        diary = new Diary({
            chatId,
            nickname: seed.nickname || DEFAULT_NICKNAME,
            profile: createDefaultProfile({
                nickname: seed.nickname || DEFAULT_NICKNAME,
            }),
        });
    }

    ensureDiaryState(diary);
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
    return (history || [])
        .map(normalizeTurn)
        .filter(Boolean)
        .slice(-MAX_CHAT_HISTORY);
}

function appendRecentTurn(diary, turn) {
    ensureDiaryState(diary);
    const nextTurn = normalizeTurn(turn);
    if (!nextTurn) {
        return;
    }

    diary.session.recentTurns = trimChatHistory([
        ...(diary.session.recentTurns || []),
        nextTurn,
    ]);
    diary.session.lastMessageAt = nextTurn.timestamp;
    diary.markModified('session');
    syncDiaryCompatibilityFields(diary);
}

function touchDiary(diary) {
    ensureDiaryState(diary);
    const now = new Date();
    diary.lastActiveAt = now;
    diary.session.lastMessageAt = now;
    diary.markModified('session');
}

function isHiddenMemoryKey(key) {
    return HIDDEN_MEMORY_PREFIXES.some((prefix) => String(key || '').startsWith(prefix));
}

function getMemoryDisplayKey(memory) {
    if (!memory) {
        return '';
    }
    return memory.key || `${MEMORY_CATEGORY_LABELS[memory.category] || '记忆'}记录`;
}

function getVisibleMemoryEntries(diary) {
    ensureDiaryState(diary);
    return (diary.longTermMemories || [])
        .map((memory) => ({
            key: getMemoryDisplayKey(memory),
            value: memory.value,
            category: memory.category,
            weight: memory.weight,
            source: memory.source,
        }))
        .filter((entry) => entry.key && entry.value)
        .sort((left, right) => right.weight - left.weight);
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
            let score = Number(entry.weight || 0);

            for (const token of tokens) {
                if (haystack.includes(token)) {
                    score += entry.key.includes(token) ? 4 : 3;
                }
            }

            if (score <= 0) {
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

    return scored.map(({ key, value, category, weight, source }) => ({ key, value, category, weight, source }));
}

function upsertLongTermMemory(diary, memory) {
    ensureDiaryState(diary);
    const nextMemory = normalizeMemory(memory);
    if (!nextMemory) {
        return null;
    }

    const existingIndex = (diary.longTermMemories || []).findIndex((item) => {
        if (!item) {
            return false;
        }
        if (item.key && nextMemory.key && item.key === nextMemory.key) {
            return true;
        }
        return item.category === nextMemory.category && item.value === nextMemory.value;
    });

    if (existingIndex >= 0) {
        const previous = normalizeMemory(diary.longTermMemories[existingIndex]) || nextMemory;
        diary.longTermMemories[existingIndex] = {
            ...previous,
            ...nextMemory,
            weight: clamp(Math.max(previous.weight, nextMemory.weight), 0.1, 1),
            lastConfirmed: nextMemory.lastConfirmed || new Date(),
        };
    } else {
        diary.longTermMemories.push(nextMemory);
    }

    diary.longTermMemories = diary.longTermMemories
        .map(normalizeMemory)
        .filter(Boolean)
        .sort((left, right) => {
            const leftScore = new Date(left.lastConfirmed).getTime() + left.weight * 1000;
            const rightScore = new Date(right.lastConfirmed).getTime() + right.weight * 1000;
            return rightScore - leftScore;
        })
        .slice(0, LONG_TERM_MEMORY_LIMIT);

    if (nextMemory.category === 'profile' && /生日/.test(nextMemory.key)) {
        diary.profile.birthday = nextMemory.value;
    }

    diary.markModified('longTermMemories');
    syncDiaryCompatibilityFields(diary);
    return nextMemory;
}

function applyMemoryUpdates(diary, directives) {
    for (const save of directives.saves || []) {
        upsertLongTermMemory(diary, {
            category: inferMemoryCategoryFromKey(save.key),
            key: save.key,
            value: save.value,
            source: 'legacy-directive',
            weight: 0.65,
        });
    }

    for (const prefix of SAVE_MEMORY_PREFIXES) {
        const memories = (diary.longTermMemories || []).filter((memory) => memory.key.startsWith(prefix));
        if (memories.length > MEMORY_PREFIX_LIMIT) {
            const allowedKeys = new Set(memories
                .sort((left, right) => new Date(right.lastConfirmed).getTime() - new Date(left.lastConfirmed).getTime())
                .slice(0, MEMORY_PREFIX_LIMIT)
                .map((memory) => memory.key));

            diary.longTermMemories = diary.longTermMemories.filter((memory) => {
                if (!memory.key.startsWith(prefix)) {
                    return true;
                }
                return allowedKeys.has(memory.key);
            });
        }
    }

    for (const obsession of directives.obsessions || []) {
        recordObsession(diary, obsession);
    }

    syncDiaryCompatibilityFields(diary);
}

function recordObsession(diary, obsession) {
    const text = stripToPlainText(obsession);
    if (!text) {
        return;
    }

    const legacyRecords = getLegacyRecordsMap(diary);
    legacyRecords.set(`OBSESS_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`, text);

    const obsessionKeys = [...legacyRecords.keys()].filter((key) => key.startsWith('OBSESS_'));
    if (obsessionKeys.length > OBSESS_LIMIT) {
        obsessionKeys
            .slice(0, obsessionKeys.length - OBSESS_LIMIT)
            .forEach((key) => legacyRecords.delete(key));
    }

    diary.legacyRecords = legacyRecords;
    diary.markModified('legacyRecords');
    syncDiaryCompatibilityFields(diary);
}

function getObsessionCount(diary) {
    return [...getLegacyRecordsMap(diary).keys()].filter((key) => key.startsWith('OBSESS_')).length;
}

function applyEmotionDelta(diary, userMessage) {
    ensureDiaryState(diary);

    const text = String(userMessage || '');
    const emotionState = diary.emotionState || createDefaultEmotionState();

    if (/(谢谢|抱抱|喜欢你|爱你|开心|需要你|想你|陪着我|离不开)/u.test(text)) {
        emotionState.affection = clamp(emotionState.affection + 10, 0, 100);
        emotionState.darkness = clamp(emotionState.darkness - 5, 0, 100);
    } else if (/(离开|闭嘴|讨厌|分手|不需要你|走开|烦死了|别来找我)/u.test(text)) {
        emotionState.darkness = clamp(emotionState.darkness + 18, 0, 100);
        emotionState.affection = clamp(emotionState.affection - 10, 0, 100);
    } else if (/(朋友|同学|女生|男生|喜欢她|喜欢他|好看|漂亮|暗恋|表白)/u.test(text)) {
        emotionState.darkness = clamp(emotionState.darkness + 8, 0, 100);
    } else if (/(随便|无所谓|不知道|算了|没事|不想说)/u.test(text)) {
        emotionState.affection = clamp(emotionState.affection - 5, 0, 100);
    }

    emotionState.darkness = clamp(emotionState.darkness - 1, 0, 100);
    emotionState.updatedAt = new Date();
    diary.emotionState = emotionState;
    diary.markModified('emotionState');
    syncDiaryCompatibilityFields(diary);
}

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

function updateMoodState(diary, userMessage = '') {
    ensureDiaryState(diary);
    const mood = calcMood(diary, userMessage);
    diary.emotionState.moodTag = mood.tag;
    diary.emotionState.moodDesc = mood.desc;
    diary.emotionState.updatedAt = new Date();
    diary.markModified('emotionState');
    syncDiaryCompatibilityFields(diary);
    return mood;
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

function getPreferredDisplayName(diary) {
    ensureDiaryState(diary);
    return diary.profile.preferredName || diary.profile.nickname || diary.nickname || DEFAULT_NICKNAME;
}

function setPreferredDisplayName(diary, nickname) {
    ensureDiaryState(diary);
    const safeName = stripToPlainText(nickname).slice(0, 20);
    if (!safeName) {
        return;
    }

    diary.profile.nickname = safeName;
    diary.nickname = safeName;
    diary.markModified('profile');
    syncDiaryCompatibilityFields(diary);
}

function setBirthday(diary, birthday) {
    ensureDiaryState(diary);
    diary.profile.birthday = birthday;
    diary.markModified('profile');
    setLegacyRecord(diary, '生日', birthday);
    syncDiaryCompatibilityFields(diary);
}

function getBirthday(diary) {
    ensureDiaryState(diary);
    return diary.profile.birthday || getLegacyRecord(diary, '生日') || '';
}

function getSummaryFreshnessLabel(diary) {
    ensureDiaryState(diary);
    if (!diary.session.threadSummary) {
        return '尚未生成摘要';
    }
    if (diary.session.turnsSinceSummary <= 0) {
        return '刚刚更新';
    }
    if (diary.session.turnsSinceSummary <= 2) {
        return '很新';
    }
    if (diary.session.turnsSinceSummary <= 5) {
        return `距今 ${diary.session.turnsSinceSummary} 轮`;
    }
    return '需要刷新';
}

function shouldRefreshThreadSummary(session) {
    const recentTurns = session?.recentTurns || [];
    return recentTurns.length > MAX_CHAT_HISTORY || Number(session?.turnsSinceSummary || 0) >= SUMMARY_TRIGGER_TURNS;
}

function resetDiaryState(diary, nicknameSeed = DEFAULT_NICKNAME) {
    diary.profile = createDefaultProfile({ nickname: nicknameSeed });
    diary.emotionState = createDefaultEmotionState();
    diary.session = createDefaultSession();
    diary.longTermMemories = [];
    diary.legacyRecords = new Map();
    diary.records = new Map();
    diary.chatHistory = [];
    diary.nickname = nicknameSeed;
    diary.affection = DEFAULT_AFFECTION;
    diary.darkness = DEFAULT_DARKNESS;
    touchDiary(diary);
    syncDiaryCompatibilityFields(diary);
}

module.exports = {
    Diary,
    DEFAULT_NICKNAME,
    DEFAULT_AFFECTION,
    DEFAULT_DARKNESS,
    MAX_CHAT_HISTORY,
    SUMMARY_TRIGGER_TURNS,
    MEMORY_PREFIX_LIMIT,
    OBSESS_LIMIT,
    LONG_TERM_MEMORY_LIMIT,
    RELEVANT_MEMORY_LIMIT,
    COOLDOWN_MS,
    COOLDOWN_NOTICE_MS,
    cooldownMap,
    cooldownNoticeMap,
    TELEGRAM_HTML_TAGS,
    SAVE_MEMORY_PREFIXES,
    MEMORY_CATEGORY_LABELS,
    getOrCreateDiary,
    ensureDiaryState,
    syncDiaryCompatibilityFields,
    clamp,
    escapeHtml,
    fixHtmlTags,
    stripHiddenDirectives,
    sanitizeTelegramHtml,
    parseModelDirectives,
    trimChatHistory,
    normalizeTurn,
    normalizeTurns,
    appendRecentTurn,
    touchDiary,
    stripToPlainText,
    getVisibleMemoryEntries,
    buildSearchTokens,
    selectRelevantMemories,
    normalizeMemory,
    inferMemoryCategoryFromKey,
    buildMemoryKey,
    upsertLongTermMemory,
    applyMemoryUpdates,
    recordObsession,
    getObsessionCount,
    getLegacyRecord,
    setLegacyRecord,
    deleteLegacyRecord,
    applyEmotionDelta,
    calcMood,
    updateMoodState,
    buildKeyboard,
    parseBirthdayInput,
    getMonthDayInTimezone,
    getHourInTimezone,
    getTimeHint,
    getPreferredDisplayName,
    setPreferredDisplayName,
    setBirthday,
    getBirthday,
    getSummaryFreshnessLabel,
    shouldRefreshThreadSummary,
    resetDiaryState,
};
