// @ts-check

const {
    ensureDiaryState,
    escapeHtml,
    getDisplayMemoryKey,
    getLegacyRecord,
    getLegacyRecordsMap,
    getPreferredDisplayName,
    normalizeMemory,
    resolveMaybeDate,
    setLegacyRecord,
    deleteLegacyRecord,
} = (() => {
    const utils = require('./utils');
    return {
        ensureDiaryState: utils.ensureDiaryState,
        escapeHtml: utils.escapeHtml,
        getDisplayMemoryKey: utils.getMemoryDisplayKey,
        getLegacyRecord: utils.getLegacyRecord,
        getLegacyRecordsMap: utils.getLegacyRecordsMap,
        getPreferredDisplayName: utils.getPreferredDisplayName,
        normalizeMemory: utils.normalizeMemory,
        setLegacyRecord: utils.setLegacyRecord,
        deleteLegacyRecord: utils.deleteLegacyRecord,
        resolveMaybeDate(value) {
            const date = value instanceof Date ? value : new Date(value);
            return Number.isNaN(date.getTime()) ? null : date;
        },
    };
})();

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const REVIEW_MEMORY_LIMIT = 5;
const REVIEW_CANDIDATE_LIMIT = 3;
const REVIEW_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PENDING_EDIT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const WEEKLY_REVIEW_MARKER_KEY = 'SYS_LAST_WEEKLY_REVIEW';
const WEEKLY_REVIEW_DISABLED_KEY = 'SYS_WEEKLY_REVIEW_DISABLED';
const MEMORY_REVIEW_SESSION_KEY = 'SYS_MEMORY_REVIEW_SESSION';
const PENDING_MEMORY_EDIT_KEY = 'SYS_PENDING_MEMORY_EDIT';

const MEMORY_SOURCE_LABELS = {
    heuristic: '对话推断',
    'model-extractor': '对话推断',
    legacy: '旧记忆迁移',
    'legacy-directive': '对话推断',
    web_app_event: '记录面板',
    web_app_detail: '记录面板',
    web_app_legacy: '记录面板',
    web_app_tag: '标签归纳',
    'user-edit': '手动修改',
    'user-confirm': '你亲自确认过',
};

function getDateParts(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = Object.create(null);
    for (const part of formatter.formatToParts(date)) {
        if (part.type !== 'literal') {
            parts[part.type] = part.value;
        }
    }
    return {
        year: Number(parts.year || 0),
        month: Number(parts.month || 0),
        day: Number(parts.day || 0),
        weekday: String(parts.weekday || ''),
        hour: Number(parts.hour || 0),
        minute: Number(parts.minute || 0),
    };
}

function normalizeJsonRecord(value) {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function getLocalDateLabel(date, timeZone) {
    const parts = getDateParts(date, timeZone);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function mapStoredMemories(diary) {
    ensureDiaryState(diary);
    return (diary.longTermMemories || [])
        .map((memory) => normalizeMemory(memory))
        .filter(Boolean)
        .map((memory) => ({
            memory,
            key: memory.key,
            displayKey: getDisplayMemoryKey(memory),
            value: String(memory.value || '').trim(),
            category: String(memory.category || 'event'),
            source: String(memory.source || 'legacy'),
            weight: Number(memory.weight || 0),
            lastConfirmed: resolveMaybeDate(memory.lastConfirmed) || new Date(),
        }))
        .filter((entry) => entry.displayKey && entry.value);
}

function getFollowUpSection(diary) {
    ensureDiaryState(diary);
    const legacyRecords = getLegacyRecordsMap(diary);
    const pendingFollowUp = String(legacyRecords.get('SYS_PENDING_FOLLOW_UP') || '').trim();
    const lastContext = String(legacyRecords.get('SYS_WEB_APP_LAST_CONTEXT') || '').trim();
    return {
        pendingFollowUp,
        lastContext: lastContext && lastContext !== pendingFollowUp ? lastContext : '',
    };
}

function buildFallbackSummary(diary) {
    ensureDiaryState(diary);

    const recentUserTurns = (diary.session?.recentTurns || [])
        .filter((turn) => turn.role === 'user' && turn.content)
        .slice(-3)
        .map((turn) => String(turn.content || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    if (recentUserTurns.length > 0) {
        return `这周你反复把这些事递到我手里：${recentUserTurns.slice(-2).join(' / ')}`.slice(0, 120);
    }

    const topics = Array.isArray(diary.profile?.topics) ? diary.profile.topics.filter(Boolean).slice(0, 2) : [];
    if (topics.length > 0) {
        return `这周你还是绕着 ${topics.join('、')} 在转。我记得很清楚。`;
    }

    const visibleMemories = mapStoredMemories(diary).slice(0, 2);
    if (visibleMemories.length > 0) {
        return `这周我主要还替你攥着这些事：${visibleMemories.map((entry) => entry.value).join('；')}`.slice(0, 120);
    }

    return `${getPreferredDisplayName(diary)}这周来过、停过、留下过一点声音。我先把能抓住的都压在这一页里。`;
}

function getReviewSummary(diary) {
    ensureDiaryState(diary);
    const threadSummary = String(diary.session?.threadSummary || '').trim();
    if (threadSummary) {
        return threadSummary;
    }

    const chapterSummaries = (diary.session?.chapterSummaries || [])
        .map((chapter) => String(chapter?.summary || '').trim())
        .filter(Boolean)
        .slice(-2);
    if (chapterSummaries.length > 0) {
        return chapterSummaries.join(' / ');
    }

    return buildFallbackSummary(diary);
}

function buildReviewSnapshot(diary, options = {}) {
    ensureDiaryState(diary);
    const now = options.now instanceof Date ? options.now : new Date();
    const cutoff = now.getTime() - WEEK_MS;
    const storedMemories = mapStoredMemories(diary);
    const recentMemories = storedMemories
        .filter((entry) => entry.lastConfirmed.getTime() >= cutoff)
        .sort((left, right) => {
            const timeDelta = right.lastConfirmed.getTime() - left.lastConfirmed.getTime();
            if (timeDelta !== 0) {
                return timeDelta;
            }
            return right.weight - left.weight;
        });
    const followUp = getFollowUpSection(diary);
    const reviewCandidates = recentMemories
        .filter((entry) => entry.key && !['user-edit', 'user-confirm'].includes(entry.source))
        .sort((left, right) => {
            if (left.weight !== right.weight) {
                return left.weight - right.weight;
            }
            return right.lastConfirmed.getTime() - left.lastConfirmed.getTime();
        })
        .slice(0, REVIEW_CANDIDATE_LIMIT);

    return {
        summary: getReviewSummary(diary),
        recentMemories: recentMemories.slice(0, REVIEW_MEMORY_LIMIT),
        reviewCandidates,
        followUp,
        hasAnyData: Boolean(
            String(diary.session?.threadSummary || '').trim() ||
            (diary.session?.chapterSummaries || []).length > 0 ||
            recentMemories.length > 0 ||
            followUp.pendingFollowUp ||
            followUp.lastContext
        ),
    };
}

function getMemorySourceLabel(source) {
    return MEMORY_SOURCE_LABELS[String(source || '')] || '自动整理';
}

function formatReviewMemoryLine(entry) {
    return `• <b>${escapeHtml(entry.displayKey)}</b>：${escapeHtml(entry.value)} <i>(${escapeHtml(getMemorySourceLabel(entry.source))})</i>`;
}

function buildReviewText(diary, options = {}) {
    const snapshot = buildReviewSnapshot(diary, options);
    const lines = [
        '<b>【这一周的回看】</b>',
        '<i>*把这七天压成一页，慢慢推到你面前*</i>',
        '',
    ];

    if (!snapshot.hasAnyData) {
        lines.push('这周还没攒出多少能翻给你的东西。');
        lines.push('你随便对我说一句，或者用 <code>/record</code> 单独记一件事。下次我就能把它们整理成一页给你。');
        return lines.join('\n');
    }

    lines.push('<b>这一周的回看</b>');
    lines.push(escapeHtml(snapshot.summary));
    lines.push('');
    lines.push('<b>这周新记住的</b>');
    if (snapshot.recentMemories.length > 0) {
        lines.push(snapshot.recentMemories.map(formatReviewMemoryLine).join('\n'));
    } else {
        lines.push('这周还没有新锁进来的长期记忆。');
    }

    lines.push('');
    lines.push('<b>还挂着的线索</b>');
    if (snapshot.followUp.pendingFollowUp || snapshot.followUp.lastContext) {
        if (snapshot.followUp.pendingFollowUp) {
            lines.push(`• ${escapeHtml(snapshot.followUp.pendingFollowUp)}`);
        }
        if (snapshot.followUp.lastContext) {
            lines.push(`• 最近记录里还有这句：${escapeHtml(snapshot.followUp.lastContext)}`);
        }
    } else {
        lines.push('这周暂时没有还挂着没收尾的线索。');
    }

    lines.push('');
    lines.push('<b>建议你核对的</b>');
    if (snapshot.reviewCandidates.length > 0) {
        lines.push(snapshot.reviewCandidates.map(formatReviewMemoryLine).join('\n'));
    } else {
        lines.push('这周没有特别需要你亲自点头确认的新记忆。');
    }

    lines.push('');
    lines.push('如果哪条记偏了，就点下面那排让我一条条翻给你改。');
    return lines.join('\n');
}

function buildReviewKeyboard(diary) {
    return [
        [
            { text: '核对本周新增', callback_data: 'review_start' },
            { text: '查看全部记忆', callback_data: 'entry_memory' },
        ],
        [
            { text: '查看最近记录', callback_data: 'entry_recent' },
            buildWeeklyToggleButton(diary),
        ],
    ];
}

function buildWeeklyToggleButton(diary, source = 'review') {
    return {
        text: isWeeklyReviewEnabled(diary) ? '关闭每周回顾' : '开启每周回顾',
        callback_data: source === 'push' ? 'review_toggle_weekly_push' : 'review_toggle_weekly',
    };
}

function getWeeklyReviewStatusText(diary) {
    return isWeeklyReviewEnabled(diary) ? '开启' : '关闭';
}

function buildWeeklyReviewPushText(diary, options = {}) {
    const snapshot = buildReviewSnapshot(diary, options);
    const lines = [
        '<i>*把这一周压短，折成你今晚能看完的一页*</i>',
        '<b>这周我替你收住了这些。</b>',
        escapeHtml(snapshot.summary),
    ];

    if (snapshot.recentMemories.length > 0) {
        lines.push(`这周新记住：${escapeHtml(snapshot.recentMemories[0].value)}`);
    }
    if (snapshot.followUp.pendingFollowUp) {
        lines.push(`还挂着：${escapeHtml(snapshot.followUp.pendingFollowUp)}`);
    }

    lines.push('点开我，我把完整那一页翻给你。');
    return lines.join('\n');
}

function buildWeeklyReviewPushKeyboard(diary) {
    return [
        [
            { text: '查看完整回看', callback_data: 'entry_review' },
            buildWeeklyToggleButton(diary),
        ],
    ];
}

function isWeeklyReviewEnabled(diary) {
    ensureDiaryState(diary);
    return String(getLegacyRecord(diary, WEEKLY_REVIEW_DISABLED_KEY) || '').trim() !== 'true';
}

function setWeeklyReviewDisabled(diary, disabled) {
    ensureDiaryState(diary);
    if (disabled) {
        setLegacyRecord(diary, WEEKLY_REVIEW_DISABLED_KEY, 'true');
    } else {
        deleteLegacyRecord(diary, WEEKLY_REVIEW_DISABLED_KEY);
    }
    return !disabled;
}

function buildWeeklyReviewMarker(date, timeZone) {
    return `${getLocalDateLabel(date, timeZone)}@${timeZone}`;
}

function isSundayNightReviewWindow(date, timeZone) {
    const parts = getDateParts(date, timeZone);
    return parts.weekday.startsWith('Sun') && parts.hour >= 18 && parts.hour < 24;
}

function setJsonRecord(diary, key, payload) {
    setLegacyRecord(diary, key, JSON.stringify(payload));
}

function getMemoryReviewSession(diary, options = {}) {
    ensureDiaryState(diary);
    const now = options.now instanceof Date ? options.now : new Date();
    const raw = normalizeJsonRecord(getLegacyRecord(diary, MEMORY_REVIEW_SESSION_KEY));
    if (!raw || !Array.isArray(raw.items) || !raw.createdAt) {
        return null;
    }

    if (now.getTime() - Number(raw.createdAt) > REVIEW_SESSION_MAX_AGE_MS) {
        clearMemoryReviewSession(diary);
        return null;
    }

    return {
        createdAt: Number(raw.createdAt),
        items: raw.items
            .map((item) => ({
                key: String(item?.key || '').trim(),
                displayKey: String(item?.displayKey || '').trim(),
                value: String(item?.value || '').trim(),
                source: String(item?.source || 'legacy').trim(),
                handled: Boolean(item?.handled),
            }))
            .filter((item) => item.key && item.displayKey && item.value),
    };
}

function clearMemoryReviewSession(diary) {
    ensureDiaryState(diary);
    deleteLegacyRecord(diary, MEMORY_REVIEW_SESSION_KEY);
}

function createMemoryReviewSession(diary, options = {}) {
    ensureDiaryState(diary);
    const now = options.now instanceof Date ? options.now : new Date();
    clearPendingMemoryEdit(diary);
    const snapshot = buildReviewSnapshot(diary, { now });
    if (snapshot.reviewCandidates.length === 0) {
        clearMemoryReviewSession(diary);
        return null;
    }

    const session = {
        createdAt: now.getTime(),
        items: snapshot.reviewCandidates.map((entry) => ({
            key: entry.key,
            displayKey: entry.displayKey,
            value: entry.value,
            source: entry.source,
            handled: false,
        })),
    };
    setJsonRecord(diary, MEMORY_REVIEW_SESSION_KEY, session);
    return session;
}

function getMemoryReviewItem(diary, index, options = {}) {
    const session = getMemoryReviewSession(diary, options);
    if (!session) {
        return null;
    }
    const item = session.items[Number(index)];
    if (!item || item.handled) {
        return null;
    }
    return { session, item };
}

function markMemoryReviewItemHandled(diary, index, options = {}) {
    const session = getMemoryReviewSession(diary, options);
    if (!session) {
        return { session: null, completed: true };
    }

    const targetIndex = Number(index);
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= session.items.length) {
        return { session, completed: false };
    }

    session.items[targetIndex].handled = true;
    const completed = session.items.every((item) => item.handled);
    if (completed) {
        clearMemoryReviewSession(diary);
        return { session, completed: true };
    }

    setJsonRecord(diary, MEMORY_REVIEW_SESSION_KEY, session);
    return { session, completed: false };
}

function getPendingMemoryEdit(diary, options = {}) {
    ensureDiaryState(diary);
    const now = options.now instanceof Date ? options.now : new Date();
    const raw = normalizeJsonRecord(getLegacyRecord(diary, PENDING_MEMORY_EDIT_KEY));
    if (!raw || !raw.key || !raw.createdAt) {
        return null;
    }

    if (now.getTime() - Number(raw.createdAt) > PENDING_EDIT_MAX_AGE_MS) {
        clearPendingMemoryEdit(diary);
        return null;
    }

    return {
        key: String(raw.key || '').trim(),
        sessionIndex: Number.isInteger(raw.sessionIndex) ? raw.sessionIndex : Number(raw.sessionIndex),
        createdAt: Number(raw.createdAt),
    };
}

function setPendingMemoryEdit(diary, payload) {
    ensureDiaryState(diary);
    setJsonRecord(diary, PENDING_MEMORY_EDIT_KEY, {
        key: String(payload?.key || '').trim(),
        sessionIndex: Number(payload?.sessionIndex),
        createdAt: Date.now(),
    });
}

function clearPendingMemoryEdit(diary) {
    ensureDiaryState(diary);
    deleteLegacyRecord(diary, PENDING_MEMORY_EDIT_KEY);
}

function buildMemoryReviewCardText(item, index, total) {
    return [
        `<b>【记忆核对 ${index + 1}/${total}】</b>`,
        '<i>*把这一条单独抽出来，等你点头或者划掉*</i>',
        `内容：<b>${escapeHtml(item.displayKey)}</b>`,
        escapeHtml(item.value),
        `来源：<b>${escapeHtml(getMemorySourceLabel(item.source))}</b>`,
    ].join('\n');
}

function buildMemoryReviewCardKeyboard(index) {
    return [
        [
            { text: '保留', callback_data: `review_keep_${index}` },
            { text: '修改', callback_data: `review_edit_${index}` },
        ],
        [
            { text: '删除', callback_data: `review_delete_${index}` },
            { text: '跳过', callback_data: `review_skip_${index}` },
        ],
    ];
}

module.exports = {
    WEEKLY_REVIEW_MARKER_KEY,
    WEEKLY_REVIEW_DISABLED_KEY,
    MEMORY_REVIEW_SESSION_KEY,
    PENDING_MEMORY_EDIT_KEY,
    buildReviewSnapshot,
    buildReviewText,
    buildReviewKeyboard,
    buildWeeklyToggleButton,
    getWeeklyReviewStatusText,
    buildWeeklyReviewPushText,
    buildWeeklyReviewPushKeyboard,
    isWeeklyReviewEnabled,
    setWeeklyReviewDisabled,
    buildWeeklyReviewMarker,
    isSundayNightReviewWindow,
    createMemoryReviewSession,
    getMemoryReviewSession,
    clearMemoryReviewSession,
    getMemoryReviewItem,
    markMemoryReviewItemHandled,
    getPendingMemoryEdit,
    setPendingMemoryEdit,
    clearPendingMemoryEdit,
    buildMemoryReviewCardText,
    buildMemoryReviewCardKeyboard,
    getMemorySourceLabel,
};
