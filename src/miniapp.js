// @ts-check

const {
    appendRecentTurn,
    buildMemoryKey,
    buildTopicKey,
    ensureDiaryState,
    mergeUniqueStrings,
    recordObsession,
    setLegacyRecord,
    stripToPlainText,
    touchDiary,
    upsertLongTermMemory,
} = require('./utils');

/**
 * @param {unknown} value
 */
function normalizeBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    const text = String(value || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(text);
}

/**
 * @param {unknown} value
 * @param {number} [limit]
 */
function normalizeTags(value, limit = 8) {
    const source = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/[,\s，、]+/)
            : [];

    return mergeUniqueStrings(
        [],
        source.map((item) => stripToPlainText(String(item || '')).slice(0, 20)).filter(Boolean),
        limit
    );
}

/**
 * @param {{ event?: string, details?: string, mood?: string, tags?: string[], remember?: boolean, followUp?: boolean }} payload
 */
function buildMiniAppLegacyText(payload) {
    const lines = [];

    if (payload.mood) {
        lines.push(`当前心情：${payload.mood}`);
    }
    if (payload.event) {
        lines.push(`今天发生：${payload.event}`);
    }
    if (payload.details) {
        lines.push(`想让由乃记住：${payload.details}`);
    }
    if (payload.tags && payload.tags.length > 0) {
        lines.push(`标签：${payload.tags.join(' / ')}`);
    }

    lines.push(`记录方式：${payload.remember ? '长期记忆' : '短期记录'}`);

    if (payload.followUp) {
        lines.push('后续动作：希望由乃之后主动追问或提醒');
    }

    return lines.join('\n').trim();
}

/**
 * @param {{ event?: string, details?: string, mood?: string, tags?: string[], remember?: boolean, followUp?: boolean, legacyText?: string }} payload
 */
function buildMiniAppContextText(payload) {
    const segments = [];

    if (payload.event) {
        segments.push(`MiniApp事件：${payload.event}`);
    }
    if (payload.details) {
        segments.push(`MiniApp细节：${payload.details}`);
    }
    if (payload.mood) {
        segments.push(`MiniApp情绪：${payload.mood}`);
    }
    if (payload.tags && payload.tags.length > 0) {
        segments.push(`MiniApp标签：${payload.tags.join(' / ')}`);
    }
    if (payload.followUp) {
        segments.push('MiniApp后续：需要跟进');
    }

    if (segments.length > 0) {
        return segments.join('；');
    }

    return stripToPlainText(payload.legacyText || '');
}

/**
 * @param {any} payload
 */
function hasStructuredMiniAppFields(payload) {
    return Boolean(
        stripToPlainText(payload?.event || '') ||
        stripToPlainText(payload?.details || '') ||
        stripToPlainText(payload?.mood || '') ||
        normalizeTags(payload?.tags).length > 0 ||
        Object.prototype.hasOwnProperty.call(payload || {}, 'remember') ||
        Object.prototype.hasOwnProperty.call(payload || {}, 'memory_type') ||
        Object.prototype.hasOwnProperty.call(payload || {}, 'follow_up')
    );
}

/**
 * @param {string | Record<string, any>} rawData
 */
function normalizeMiniAppPayload(rawData) {
    const source = typeof rawData === 'string'
        ? (rawData.trim() ? JSON.parse(rawData) : null)
        : rawData;

    if (!source || typeof source !== 'object') {
        return null;
    }

    if (String(source.action || '') !== 'submit_form') {
        return null;
    }

    const legacyText = stripToPlainText(source.text || '');
    const structured = hasStructuredMiniAppFields(source);
    if (!structured && !legacyText) {
        return null;
    }

    const remember = structured
        ? (normalizeBoolean(source.remember) || String(source.memory_type || '').trim().toLowerCase() === 'long_term')
        : true;

    const tags = normalizeTags(source.tags);
    const event = stripToPlainText(source.event || '');
    const details = stripToPlainText(source.details || '');
    const mood = stripToPlainText(source.mood || '');
    const followUp = structured ? normalizeBoolean(source.follow_up) : false;

    const timestampMs = Number(source.ts || Date.now());
    const timestamp = Number.isFinite(timestampMs) && timestampMs > 0
        ? new Date(timestampMs)
        : new Date();

    const normalized = {
        action: 'submit_form',
        event,
        details,
        mood,
        tags,
        remember,
        memoryType: remember ? 'long_term' : 'short_term',
        followUp,
        legacyText: legacyText || buildMiniAppLegacyText({
            event,
            details,
            mood,
            tags,
            remember,
            followUp,
        }),
        timestamp,
        isLegacyOnly: !structured && Boolean(legacyText),
    };

    return {
        ...normalized,
        contextText: buildMiniAppContextText(normalized),
    };
}

/**
 * @param {{ event: string, details: string, tags: string[], legacyText: string }} payload
 */
function buildFollowUpNote(payload) {
    return stripToPlainText(
        `MiniApp跟进：${payload.event || payload.details || payload.tags.join(' / ') || payload.legacyText}`
    ).slice(0, 160);
}

/**
 * @param {any} diary
 * @param {ReturnType<typeof normalizeMiniAppPayload>} payload
 */
function applyMiniAppPayload(diary, payload) {
    if (!payload) {
        return null;
    }

    ensureDiaryState(diary);

    appendRecentTurn(diary, {
        role: 'user',
        content: payload.contextText || payload.legacyText,
        timestamp: payload.timestamp,
    });

    diary.session.turnsSinceSummary = Math.max(0, Number(diary.session.turnsSinceSummary || 0) + 1);
    diary.session.lastTopicKey = buildTopicKey(payload.contextText || payload.legacyText);
    if (!diary.session.threadSummary) {
        diary.session.threadSummary = stripToPlainText(payload.contextText || payload.legacyText).slice(0, 260);
    }
    diary.markModified('session');

    if (payload.remember) {
        if (payload.event) {
            upsertLongTermMemory(diary, {
                category: 'event',
                key: buildMemoryKey('event', payload.event),
                value: payload.event,
                source: 'web_app_event',
                weight: 0.82,
            });
        }

        if (payload.details) {
            upsertLongTermMemory(diary, {
                category: 'event',
                key: buildMemoryKey('event', payload.details),
                value: payload.details,
                source: 'web_app_detail',
                weight: 0.88,
            });
        }

        if (payload.isLegacyOnly && payload.legacyText) {
            upsertLongTermMemory(diary, {
                category: 'event',
                key: buildMemoryKey('event', payload.legacyText),
                value: payload.legacyText,
                source: 'web_app_legacy',
                weight: 0.8,
            });
        }
    }

    if (payload.tags.length > 0) {
        diary.profile.topics = mergeUniqueStrings(diary.profile.topics, payload.tags);
        diary.markModified('profile');

        for (const tag of payload.tags) {
            upsertLongTermMemory(diary, {
                category: 'topic',
                key: buildMemoryKey('topic', tag),
                value: tag,
                source: 'web_app_tag',
                weight: 0.74,
            });
        }
    }

    if (payload.followUp) {
        recordObsession(diary, buildFollowUpNote(payload));
    }

    setLegacyRecord(diary, 'SYS_WEB_APP_LAST_RECORD', payload.legacyText);
    setLegacyRecord(diary, 'SYS_WEB_APP_LAST_RECORD_AT', String(payload.timestamp.getTime()));
    setLegacyRecord(diary, 'SYS_WEB_APP_LAST_CONTEXT', payload.contextText);
    if (payload.mood) {
        setLegacyRecord(diary, 'SYS_WEB_APP_LAST_MOOD', payload.mood);
    }
    if (payload.followUp) {
        setLegacyRecord(diary, 'SYS_PENDING_FOLLOW_UP', payload.contextText);
    }

    touchDiary(diary);

    return {
        legacyText: payload.legacyText,
        contextText: payload.contextText,
        remember: payload.remember,
        memoryType: payload.memoryType,
        tags: [...payload.tags],
        followUp: payload.followUp,
        event: payload.event,
        details: payload.details,
        mood: payload.mood,
    };
}

module.exports = {
    buildMiniAppLegacyText,
    buildMiniAppContextText,
    normalizeMiniAppPayload,
    applyMiniAppPayload,
};
