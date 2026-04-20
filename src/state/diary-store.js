// @ts-check

const mongoose = require('mongoose');

const {
    DEFAULT_NICKNAME,
    DEFAULT_AFFECTION,
    DEFAULT_DARKNESS,
    MAX_CHAT_HISTORY,
    SUMMARY_TRIGGER_TURNS,
    MEMORY_PREFIX_LIMIT,
    OBSESS_LIMIT,
    LONG_TERM_MEMORY_LIMIT,
    CHAPTER_SUMMARY_LIMIT,
    RELEVANT_MEMORY_LIMIT,
    SAVE_MEMORY_PREFIXES,
    HIDDEN_MEMORY_PREFIXES,
    MEMORY_CATEGORY_LABELS,
} = require('./constants');
const {
    stripToPlainText,
    buildSearchTokens,
} = require('./text');
const {
    clamp,
    calcMood,
} = require('./emotion');

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

const chapterSummarySchema = new mongoose.Schema(
    {
        summary: { type: String, default: '' },
        topicKey: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now },
    },
    { _id: false }
);

const profileSchema = new mongoose.Schema(
    {
        nickname: { type: String, default: DEFAULT_NICKNAME },
        preferredName: { type: String, default: '' },
        preferredTone: { type: String, default: '' },
        supportMode: { type: String, default: '' },
        topics: { type: [String], default: [] },
        boundaries: { type: [String], default: [] },
        interests: { type: [String], default: [] },
        commonEmoji: { type: [String], default: [] },
        greetingStyle: { type: String, default: '' },
        pushPreference: { type: String, default: '' },
        pushWindows: { type: [String], default: [] },
        pushWindowsConfigured: { type: Boolean, default: false },
        birthday: { type: String, default: '' },
        timeZone: { type: String, default: '' },
        quietHoursEnabled: { type: Boolean, default: false },
        quietHoursStart: { type: Number, default: 1380 },
        quietHoursEnd: { type: Number, default: 480 },
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
        chapterSummaries: { type: [chapterSummarySchema], default: [] },
        turnsSinceSummary: { type: Number, default: 0 },
        lastMessageAt: { type: Date, default: Date.now },
        lastTopicKey: { type: String, default: '' },
        summaryVersion: { type: Number, default: 1 },
    },
    { _id: false }
);

const diarySchema = new mongoose.Schema(
    {
        chatId: { type: String, required: true, unique: true },
        affection: { type: Number, default: DEFAULT_AFFECTION },
        darkness: { type: Number, default: DEFAULT_DARKNESS },
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

const NORMALIZED = Symbol('normalized');

/**
 * Clear the normalized flag so the next ensureDiaryState call re-runs.
 * Call this after any mutation that changes state structure.
 * @param {any} diary
 */
function invalidateNormalized(diary) {
    diary[NORMALIZED] = false;
}

/**
 * @param {string[]} values
 * @param {number} [limit]
 */
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

/**
 * @param {string} text
 */
function extractEmojiTokens(text) {
    const matches = String(text || '').match(/[\p{Extended_Pictographic}\u2600-\u27BF]/gu) || [];
    return uniqueCompactStrings(matches, 4);
}

/**
 * @param {string} value
 */
function normalizeSupportMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (['companion', 'clarify', 'quiet'].includes(mode)) {
        return mode;
    }
    return '';
}

/**
 * @param {string} value
 */
function normalizePushPreference(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    const preference = raw.toLowerCase();
    if (['quiet', 'balanced', 'proactive'].includes(preference)) {
        return preference;
    }

    if (['安静', '安静一点', '少一点', '少一点主动', '别太频繁', '别太频繁提醒', '少打扰'].includes(raw)) {
        return 'quiet';
    }

    if (['默认', '正常', '正常频率', '均衡'].includes(raw)) {
        return 'balanced';
    }

    if (['主动', '主动一点', '多一点', '多一点主动', '多提醒我'].includes(raw)) {
        return 'proactive';
    }

    return '';
}

/**
 * @param {string} value
 */
function normalizePushWindow(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    const window = raw.toLowerCase();
    if (['morning', 'afternoon', 'night'].includes(window)) {
        return window;
    }

    if (['早上', '上午'].includes(raw)) {
        return 'morning';
    }
    if (['下午', '午后'].includes(raw)) {
        return 'afternoon';
    }
    if (['晚上', '夜里', '夜间'].includes(raw)) {
        return 'night';
    }

    return '';
}

/**
 * @param {string} value
 */
function normalizeTimeZone(value) {
    const zone = String(value || '').trim();
    if (!zone) {
        return '';
    }

    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
        return zone;
    } catch (_error) {
        return '';
    }
}

/**
 * @param {string} value
 */
function parseTimeStringToMinutes(value) {
    const text = String(value || '').trim();
    const match = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
        return null;
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour * 60 + minute;
}

/**
 * @param {string | number} value
 * @param {number} fallback
 */
function normalizeQuietHourMinute(value, fallback) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue) && numberValue >= 0 && numberValue < 1440) {
        return Math.floor(numberValue);
    }

    const parsed = parseTimeStringToMinutes(String(value || ''));
    if (parsed === null) {
        return fallback;
    }
    return parsed;
}

/**
 * @param {string} value
 */
function normalizeQuietHoursRange(value) {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }

    const segments = text.split(/\s*-\s*/);
    if (segments.length !== 2) {
        return null;
    }

    const startMinutes = parseTimeStringToMinutes(segments[0]);
    const endMinutes = parseTimeStringToMinutes(segments[1]);
    if (startMinutes === null || endMinutes === null) {
        return null;
    }

    return { startMinutes, endMinutes };
}

/**
 * @param {Record<string, any>} [seed]
 */
function createDefaultProfile(seed = {}) {
    const hasPushWindows = Array.isArray(seed.pushWindows);
    const normalizedPushWindows = hasPushWindows
        ? seed.pushWindows.map(normalizePushWindow).filter(Boolean)
        : [];
    const pushWindowsConfigured = Boolean(seed.pushWindowsConfigured);
    const quietHoursStart = normalizeQuietHourMinute(seed.quietHoursStart, 23 * 60);
    const quietHoursEnd = normalizeQuietHourMinute(seed.quietHoursEnd, 8 * 60);

    return {
        nickname: seed.nickname || DEFAULT_NICKNAME,
        preferredName: seed.preferredName || '',
        preferredTone: seed.preferredTone || '',
        supportMode: normalizeSupportMode(seed.supportMode),
        topics: Array.isArray(seed.topics) ? uniqueCompactStrings(seed.topics) : [],
        boundaries: Array.isArray(seed.boundaries) ? uniqueCompactStrings(seed.boundaries) : [],
        interests: Array.isArray(seed.interests) ? uniqueCompactStrings(seed.interests) : [],
        commonEmoji: Array.isArray(seed.commonEmoji) ? uniqueCompactStrings(seed.commonEmoji, 4) : [],
        greetingStyle: seed.greetingStyle || '',
        pushPreference: normalizePushPreference(seed.pushPreference),
        pushWindows: hasPushWindows
            ? (normalizedPushWindows.length > 0 || pushWindowsConfigured ? normalizedPushWindows : undefined)
            : undefined,
        pushWindowsConfigured,
        birthday: seed.birthday || '',
        timeZone: normalizeTimeZone(seed.timeZone),
        quietHoursEnabled: Boolean(seed.quietHoursEnabled),
        quietHoursStart,
        quietHoursEnd,
    };
}

/**
 * @param {Record<string, any>} [seed]
 */
function createDefaultEmotionState(seed = {}) {
    return {
        affection: clamp(Number(seed.affection ?? DEFAULT_AFFECTION), 0, 100),
        darkness: clamp(Number(seed.darkness ?? DEFAULT_DARKNESS), 0, 100),
        moodTag: String(seed.moodTag || 'NORMAL'),
        moodDesc: String(seed.moodDesc || ''),
        updatedAt: seed.updatedAt ? new Date(seed.updatedAt) : new Date(),
    };
}

/**
 * @param {Record<string, any>} [seed]
 */
function createDefaultSession(seed = {}) {
    return {
        recentTurns: normalizeTurns(seed.recentTurns || []),
        threadSummary: String(seed.threadSummary || ''),
        chapterSummaries: normalizeChapterSummaries(seed.chapterSummaries || []),
        turnsSinceSummary: Math.max(0, Number(seed.turnsSinceSummary || 0)),
        lastMessageAt: seed.lastMessageAt ? new Date(seed.lastMessageAt) : new Date(),
        lastTopicKey: String(seed.lastTopicKey || ''),
        summaryVersion: Math.max(1, Number(seed.summaryVersion || 1)),
    };
}

/**
 * @param {Array<Record<string, any>>} chapters
 */
function normalizeChapterSummaries(chapters) {
    return (chapters || [])
        .map((chapter) => {
            const summary = stripToPlainText(chapter?.summary || '');
            if (!summary) {
                return null;
            }
            const createdAt = chapter?.createdAt ? new Date(chapter.createdAt) : new Date();
            return {
                summary,
                topicKey: String(chapter?.topicKey || ''),
                createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
            };
        })
        .filter(Boolean)
        .slice(-CHAPTER_SUMMARY_LIMIT);
}

/**
 * @param {Array<Record<string, any>>} turns
 */
function normalizeTurns(turns) {
    return trimChatHistory(
        (turns || [])
            .map(normalizeTurn)
            .filter(Boolean)
    );
}

/**
 * @param {Record<string, any>} turn
 */
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

/**
 * @param {string} category
 * @param {string} [value]
 */
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

/**
 * @param {string} category
 */
function normalizeMemoryCategory(category) {
    const value = String(category || '').trim().toLowerCase();
    if (['preference', 'boundary', 'topic', 'event', 'relationship', 'roleplay', 'profile'].includes(value)) {
        return value;
    }
    return 'event';
}

/**
 * @param {string} key
 */
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

/**
 * @param {Record<string, any>} memory
 */
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

/**
 * @param {Map<string, string> | Record<string, string> | undefined | null} mapLike
 */
function getMapEntries(mapLike) {
    if (!mapLike) {
        return [];
    }
    if (typeof mapLike.entries === 'function') {
        return [...mapLike.entries()];
    }
    return Object.entries(mapLike);
}

/**
 * @param {Array<[string, string]>} entries
 */
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

/**
 * @param {any} diary
 */
function getLegacyRecordsMap(diary) {
    return createMapFromEntries(getMapEntries(diary.legacyRecords || diary.records));
}

/**
 * @param {any} diary
 * @param {string} key
 * @param {string} value
 */
function setLegacyRecord(diary, key, value) {
    const nextMap = getLegacyRecordsMap(diary);
    nextMap.set(String(key), String(value ?? ''));
    diary.legacyRecords = nextMap;
    diary.markModified('legacyRecords');
}

/**
 * @param {any} diary
 * @param {string} key
 */
function getLegacyRecord(diary, key) {
    return getLegacyRecordsMap(diary).get(String(key));
}

/**
 * @param {any} diary
 * @param {string} key
 */
function deleteLegacyRecord(diary, key) {
    const nextMap = getLegacyRecordsMap(diary);
    nextMap.delete(String(key));
    diary.legacyRecords = nextMap;
    diary.markModified('legacyRecords');
}

/**
 * @param {any} diary
 */
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
        if (memory?.key && memory?.value) {
            legacyRecords.set(memory.key, memory.value);
        }
    }

    diary.profile = profile;
    diary.emotionState = emotionState;
    diary.session = session;
    diary.legacyRecords = legacyRecords;
    diary.nickname = profile.nickname || DEFAULT_NICKNAME;
    diary.affection = clamp(Number(emotionState.affection ?? diary.affection), 0, 100);
    diary.darkness = clamp(Number(emotionState.darkness ?? diary.darkness), 0, 100);
    diary.chatHistory = trimChatHistory((session.recentTurns || []).map((turn) => ({
        role: turn.role,
        content: turn.content,
    })));
    diary.lastActiveAt = session.lastMessageAt || diary.lastActiveAt || new Date();
}

/**
 * @param {any} diary
 */
function ensureDiaryState(diary) {
    if (diary[NORMALIZED]) {
        return diary;
    }
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
        diary.longTermMemories = diary.longTermMemories.map(normalizeMemory).filter(Boolean);
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

        if (memory && !diary.longTermMemories.some((item) => item && item.key === memory.key)) {
            diary.longTermMemories.push(memory);
            changed = true;
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
        emotionState: diary.emotionState,
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

    diary[NORMALIZED] = true;
    return diary;
}

/**
 * @param {string} chatId
 * @param {Record<string, any>} [seed]
 */
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
    const seededNickname = stripToPlainText(seed.nickname || '').slice(0, 20);
    if (
        seededNickname &&
        !diary.profile.preferredName &&
        (!diary.profile.nickname || diary.profile.nickname === DEFAULT_NICKNAME)
    ) {
        diary.profile.nickname = seededNickname;
        diary.nickname = seededNickname;
        diary.markModified('profile');
    }
    return diary;
}

/**
 * @param {Array<Record<string, any>>} history
 */
function trimChatHistory(history) {
    return (history || [])
        .map(normalizeTurn)
        .filter(Boolean)
        .slice(-MAX_CHAT_HISTORY);
}

/**
 * @param {any} diary
 * @param {Record<string, any>} turn
 */
function appendRecentTurn(diary, turn) {
    ensureDiaryState(diary);
    invalidateNormalized(diary);
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
}

/**
 * @param {any} diary
 */
function touchDiary(diary) {
    ensureDiaryState(diary);
    const now = new Date();
    diary.lastActiveAt = now;
    diary.session.lastMessageAt = now;
    diary.markModified('session');
}

/**
 * @param {string} key
 */
function isHiddenMemoryKey(key) {
    return HIDDEN_MEMORY_PREFIXES.some((prefix) => String(key || '').startsWith(prefix));
}

/**
 * @param {Record<string, any>} memory
 */
function getMemoryDisplayKey(memory) {
    if (!memory) {
        return '';
    }
    return memory.key || `${MEMORY_CATEGORY_LABELS[memory.category] || '记忆'}记录`;
}

/**
 * @param {any} diary
 */
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

/**
 * @param {any} entry
 * @returns {entry is { key: string, value: string, category: string, weight: number, source: string, score: number, index: number }}
 */
function isScoredMemoryEntry(entry) {
    return Boolean(entry && entry.key && entry.value);
}

/**
 * @param {Array<Record<string, any>>} entries
 * @param {string} userMessage
 * @param {number} [limit]
 */
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
        .filter(isScoredMemoryEntry)
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return right.index - left.index;
        })
        .slice(0, limit);

    return scored.map(({ key, value, category, weight, source }) => ({ key, value, category, weight, source }));
}

/**
 * @param {any} diary
 * @param {Record<string, any>} memory
 */
function upsertLongTermMemory(diary, memory) {
    ensureDiaryState(diary);
    invalidateNormalized(diary);
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
    return nextMemory;
}

/**
 * @param {any} diary
 * @param {string} query
 */
function findLongTermMemoryMatches(diary, query) {
    ensureDiaryState(diary);
    const needle = stripToPlainText(query).toLowerCase();
    if (!needle) {
        return [];
    }

    return (diary.longTermMemories || [])
        .map((memory, index) => ({
            memory: normalizeMemory(memory),
            index,
        }))
        .filter((entry) => entry.memory)
        .filter((entry) => {
            const haystack = `${entry.memory.key} ${entry.memory.value}`.toLowerCase();
            return haystack.includes(needle);
        });
}

/**
 * @param {any} diary
 * @param {string} query
 */
function removeLongTermMemory(diary, query) {
    ensureDiaryState(diary);
    invalidateNormalized(diary);

    const matches = findLongTermMemoryMatches(diary, query);
    if (matches.length === 0) {
        return null;
    }

    const [selected] = matches;
    diary.longTermMemories.splice(selected.index, 1);
    if (selected.memory?.key) {
        deleteLegacyRecord(diary, selected.memory.key);
    }
    diary.markModified('longTermMemories');
    return selected.memory;
}

/**
 * @param {any} diary
 * @param {string} query
 * @param {string} nextValue
 */
function updateLongTermMemoryValue(diary, query, nextValue) {
    ensureDiaryState(diary);
    invalidateNormalized(diary);

    const matches = findLongTermMemoryMatches(diary, query);
    if (matches.length === 0) {
        return null;
    }

    const [selected] = matches;
    const normalizedValue = stripToPlainText(nextValue);
    if (!normalizedValue) {
        return null;
    }

    const updatedMemory = {
        ...selected.memory,
        value: normalizedValue,
        lastConfirmed: new Date(),
        source: 'user-edit',
    };
    diary.longTermMemories[selected.index] = updatedMemory;
    if (updatedMemory.key) {
        setLegacyRecord(diary, updatedMemory.key, normalizedValue);
    }
    diary.markModified('longTermMemories');
    return normalizeMemory(updatedMemory);
}

/**
 * @param {any} diary
 * @param {{ saves?: Array<{key: string, value: string}>, obsessions?: string[] }} directives
 */
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
}

/**
 * @param {any} diary
 * @param {string} obsession
 */
function recordObsession(diary, obsession) {
    const text = stripToPlainText(obsession);
    if (!text) {
        return;
    }

    const legacyRecords = getLegacyRecordsMap(diary);
    legacyRecords.set(`OBSESS_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`, text);
    const obsessionKeys = [...legacyRecords.keys()].filter((key) => key.startsWith('OBSESS_'));
    if (obsessionKeys.length > OBSESS_LIMIT) {
        obsessionKeys.slice(0, obsessionKeys.length - OBSESS_LIMIT).forEach((key) => legacyRecords.delete(key));
    }

    diary.legacyRecords = legacyRecords;
    diary.markModified('legacyRecords');
}

/**
 * @param {any} diary
 */
function getObsessionCount(diary) {
    return [...getLegacyRecordsMap(diary).keys()].filter((key) => key.startsWith('OBSESS_')).length;
}

/**
 * @param {any} diary
 * @param {string} [userMessage]
 */
function updateMoodState(diary, userMessage = '') {
    ensureDiaryState(diary);
    invalidateNormalized(diary);
    const mood = calcMood(diary, userMessage);
    diary.emotionState.moodTag = mood.tag;
    diary.emotionState.moodDesc = mood.desc;
    diary.emotionState.updatedAt = new Date();
    diary.markModified('emotionState');
    return mood;
}

/**
 * @param {string} input
 */
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

/**
 * @param {Date} [date]
 * @param {string} [timeZone]
 */
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

/**
 * @param {any} diary
 */
function getPreferredDisplayName(diary) {
    ensureDiaryState(diary);
    return diary.profile.preferredName || diary.profile.nickname || diary.nickname || DEFAULT_NICKNAME;
}

/**
 * @param {any} diary
 * @param {string} nickname
 */
function setProfileNickname(diary, nickname) {
    ensureDiaryState(diary);
    invalidateNormalized(diary);
    const safeName = stripToPlainText(nickname).slice(0, 20);
    if (!safeName) {
        return;
    }

    diary.profile.nickname = safeName;
    diary.nickname = safeName;
    diary.markModified('profile');
}

/**
 * @param {any} diary
 * @param {string} nickname
 */
function setPreferredDisplayName(diary, nickname) {
    ensureDiaryState(diary);
    invalidateNormalized(diary);
    const safeName = stripToPlainText(nickname).slice(0, 20);
    if (!safeName) {
        return;
    }

    diary.profile.preferredName = safeName;
    if (!diary.profile.nickname || diary.profile.nickname === DEFAULT_NICKNAME) {
        diary.profile.nickname = safeName;
    }
    if (!diary.nickname || diary.nickname === DEFAULT_NICKNAME) {
        diary.nickname = diary.profile.nickname;
    }
    diary.markModified('profile');
}

/**
 * @param {any} diary
 * @param {string} birthday
 */
function setBirthday(diary, birthday) {
    ensureDiaryState(diary);
    invalidateNormalized(diary);
    diary.profile.birthday = birthday;
    diary.markModified('profile');
    setLegacyRecord(diary, '生日', birthday);
}

/**
 * @param {any} diary
 */
function getBirthday(diary) {
    ensureDiaryState(diary);
    return diary.profile.birthday || getLegacyRecord(diary, '生日') || '';
}

/**
 * @param {any} diary
 */
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

/**
 * @param {any} session
 */
function shouldRefreshThreadSummary(session) {
    const recentTurns = session?.recentTurns || [];
    return recentTurns.length > MAX_CHAT_HISTORY || Number(session?.turnsSinceSummary || 0) >= SUMMARY_TRIGGER_TURNS;
}

/**
 * @param {string} text
 */
function buildTopicKey(text) {
    const tokens = buildSearchTokens(text).slice(0, 4);
    if (tokens.length > 0) {
        return tokens.join('|');
    }
    return stripToPlainText(text).slice(0, 24);
}

/**
 * @param {any} diary
 * @param {string} summary
 */
function appendChapterSummary(diary, summary) {
    ensureDiaryState(diary);
    const cleanSummary = stripToPlainText(summary);
    if (!cleanSummary) {
        return;
    }

    diary.session.chapterSummaries = normalizeChapterSummaries([
        ...(diary.session.chapterSummaries || []),
        {
            summary: cleanSummary,
            topicKey: diary.session.lastTopicKey || '',
            createdAt: new Date(),
        },
    ]);
    diary.markModified('session');
}

/**
 * @param {any} diary
 * @param {string} nextTopicKey
 */
function shouldRollChapterSummary(diary, nextTopicKey) {
    ensureDiaryState(diary);
    const currentSummary = stripToPlainText(diary.session.threadSummary || '');
    if (!currentSummary) {
        return false;
    }

    if (currentSummary.length > 220) {
        return true;
    }

    const previousTopic = diary.session.lastTopicKey || '';
    if (!previousTopic || !nextTopicKey || previousTopic === nextTopicKey) {
        return false;
    }

    const previousTokens = new Set(previousTopic.split('|').filter(Boolean));
    const nextTokens = nextTopicKey.split('|').filter(Boolean);
    const overlap = nextTokens.filter((token) => previousTokens.has(token)).length;
    return overlap === 0;
}

/**
 * @param {any} diary
 */
function getSummaryContextText(diary) {
    ensureDiaryState(diary);
    const chapterLines = (diary.session.chapterSummaries || [])
        .slice(-2)
        .map((chapter, index) => `章节摘要${index + 1}：${chapter.summary}`);

    return [...chapterLines, diary.session.threadSummary ? `当前线程摘要：${diary.session.threadSummary}` : '暂无线程摘要。']
        .filter(Boolean)
        .join('\n');
}

/**
 * @param {string[]} values
 * @param {string[]} additions
 * @param {number} [limit]
 */
function mergeUniqueStrings(values, additions, limit = 8) {
    return uniqueCompactStrings([...(values || []), ...(additions || [])], limit);
}

/**
 * @param {any} diary
 * @param {string} [nicknameSeed]
 */
function resetDiaryState(diary, nicknameSeed = DEFAULT_NICKNAME) {
    diary.profile = createDefaultProfile({ nickname: nicknameSeed });
    diary.emotionState = createDefaultEmotionState();
    diary.session = createDefaultSession();
    diary.longTermMemories = [];
    diary.legacyRecords = new Map();
    diary.chatHistory = [];
    diary.nickname = nicknameSeed;
    diary.affection = DEFAULT_AFFECTION;
    diary.darkness = DEFAULT_DARKNESS;
    touchDiary(diary);
    syncDiaryCompatibilityFields(diary);
}

module.exports = {
    Diary,
    invalidateNormalized,
    createDefaultProfile,
    createDefaultEmotionState,
    createDefaultSession,
    normalizeChapterSummaries,
    normalizeTurn,
    normalizeTurns,
    normalizeMemoryCategory,
    normalizeMemory,
    inferMemoryCategoryFromKey,
    buildMemoryKey,
    uniqueCompactStrings,
    extractEmojiTokens,
    getMapEntries,
    createMapFromEntries,
    getLegacyRecordsMap,
    setLegacyRecord,
    getLegacyRecord,
    deleteLegacyRecord,
    syncDiaryCompatibilityFields,
    ensureDiaryState,
    getOrCreateDiary,
    trimChatHistory,
    appendRecentTurn,
    touchDiary,
    isHiddenMemoryKey,
    getMemoryDisplayKey,
    getVisibleMemoryEntries,
    selectRelevantMemories,
    upsertLongTermMemory,
    findLongTermMemoryMatches,
    removeLongTermMemory,
    updateLongTermMemoryValue,
    applyMemoryUpdates,
    recordObsession,
    getObsessionCount,
    updateMoodState,
    parseBirthdayInput,
    getMonthDayInTimezone,
    getPreferredDisplayName,
    normalizeSupportMode,
    normalizePushPreference,
    normalizePushWindow,
    normalizeTimeZone,
    parseTimeStringToMinutes,
    normalizeQuietHourMinute,
    normalizeQuietHoursRange,
    setProfileNickname,
    setPreferredDisplayName,
    setBirthday,
    getBirthday,
    getSummaryFreshnessLabel,
    shouldRefreshThreadSummary,
    buildTopicKey,
    appendChapterSummary,
    shouldRollChapterSummary,
    getSummaryContextText,
    mergeUniqueStrings,
    resetDiaryState,
};
