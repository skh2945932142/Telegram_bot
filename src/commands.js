const {
    DEFAULT_NICKNAME,
    ensureDiaryState,
    calcMood,
    escapeHtml,
    findLongTermMemoryMatches,
    getLegacyRecordsMap,
    getObsessionCount,
    getPreferredDisplayName,
    getSummaryFreshnessLabel,
    getVisibleMemoryEntries,
    normalizePushPreference,
    normalizePushWindow,
    normalizeQuietHoursRange,
    normalizeTimeZone,
    normalizeSupportMode,
    parseBirthdayInput,
    removeLongTermMemory,
    resetDiaryState,
    setBirthday,
    setPreferredDisplayName,
    setProfileNickname,
    updateLongTermMemoryValue,
} = require('./utils');
const { buildDiaryEntry } = require('./orchestrator');
const { logRuntimeError } = require('./runtime-logging');
const {
    DEFAULT_PUSH_WINDOWS,
    buildPushPreferenceKeyboard,
    buildPushWindowKeyboard,
    buildSupportModeKeyboard,
    getEnabledPushWindows,
    getPushPreferenceMeta,
    getSupportModeMeta,
} = require('./user-preferences');

const FALLBACK_ERROR_HTML = [
    '<i>*笔从指间滑了一下，又立刻重新握紧*</i>',
    '刚才那一步没走稳。',
    '再说一遍。这一次我会用两只手来接。',
].join('\n');

const PUSH_WINDOW_ALIASES = {
    早上: 'morning',
    上午: 'morning',
    morning: 'morning',
    下午: 'afternoon',
    午后: 'afternoon',
    afternoon: 'afternoon',
    晚上: 'night',
    夜里: 'night',
    夜间: 'night',
    night: 'night',
};

const PUSH_PREFERENCE_ALIASES = {
    quiet: 'quiet',
    安静: 'quiet',
    '安静一点': 'quiet',
    '少一点': 'quiet',
    balanced: 'balanced',
    默认: 'balanced',
    正常: 'balanced',
    '正常频率': 'balanced',
    proactive: 'proactive',
    主动: 'proactive',
    '主动一点': 'proactive',
    '多一点主动': 'proactive',
};

const SUPPORT_MODE_ALIASES = {
    companion: 'companion',
    陪我: 'companion',
    陪着我: 'companion',
    '只陪我': 'companion',
    clarify: 'clarify',
    '理一下': 'clarify',
    '帮我理一下': 'clarify',
    梳理: 'clarify',
    quiet: 'quiet',
    安静: 'quiet',
    '别追问': 'quiet',
    '别追问了': 'quiet',
};

const QUIET_OFF_TOKENS = new Set([
    'off',
    'none',
    'disable',
    'disabled',
    'stop',
    '关闭',
    '关',
    '停用',
]);

const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

const HELP_COMMANDS = [
    '• <code>/start</code> 重新查看入口面板',
    '• <code>/help</code> 查看命令和示例',
    '• <code>/record</code> 打开记录面板（仅私聊）',
    '• <code>/memory</code> 查看长期记忆',
    '• <code>/recent</code> 查看最近记录与待跟进线索',
    '• <code>/forget 关键词</code> 删除一条记忆',
    '• <code>/editmemory 关键词 =&gt; 新内容</code> 修改一条记忆',
    '• <code>/mode 只陪我|帮我理一下|别追问了</code> 调回应方式',
    '• <code>/push 安静一点|正常|多一点主动 [早上 下午 晚上]</code> 调提醒偏好',
    '• <code>/timezone Asia/Shanghai</code> 设置时区（IANA）',
    '• <code>/quiet 23:00-08:00</code> 设置免打扰，<code>/quiet off</code> 关闭',
    '• <code>/nickname 名字</code> 设置称呼',
    '• <code>/birthday 3-15</code> 设置生日',
    '• <code>/status</code> 查看当前状态',
    '• <code>/mood</code> 查看情绪与摘要状态',
    '• <code>/diary</code> 生成今日日记',
    '• <code>/reset</code> 重置会话和记忆（需确认）',
];

const KNOWN_COMMANDS = new Set([
    'start',
    'help',
    'mood',
    'memory',
    'recent',
    'forget',
    'editmemory',
    'mode',
    'push',
    'reset',
    'hug',
    'target',
    'promise',
    'diary',
    'stalk',
    'birthday',
    'timezone',
    'quiet',
    'record',
    'status',
    'nickname',
]);

function replyHtml(ctx, text, extra = {}) {
    return ctx.reply(text, { parse_mode: 'HTML', ...extra });
}

function getCommandArgs(ctx) {
    return String(ctx.message?.text || '')
        .split(/\s+/)
        .slice(1)
        .join(' ')
        .trim();
}

function formatVisibleMemories(entries, limit = 12) {
    return entries
        .slice(0, limit)
        .map(({ key, value, category }) => `• <b>${escapeHtml(key)}</b> <i>(${escapeHtml(category)})</i>: ${escapeHtml(value)}`)
        .join('\n');
}

function formatMemoryMatches(matches) {
    return matches
        .slice(0, 4)
        .map(({ memory }) => `• <b>${escapeHtml(memory.key)}</b>: ${escapeHtml(memory.value)}`)
        .join('\n');
}

function formatTimestamp(ms) {
    const timestamp = Number(ms || 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return '';
    }

    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(timestamp));
}

function parseEditMemoryArgs(args) {
    const parts = String(args || '').split(/\s*(?:=>|->|→|\|)\s*/);
    if (parts.length < 2) {
        return null;
    }

    const [query, ...rest] = parts;
    const nextValue = rest.join(' ').trim();
    if (!query.trim() || !nextValue) {
        return null;
    }

    return {
        query: query.trim(),
        nextValue,
    };
}

function normalizeSupportModeArg(value) {
    const text = String(value || '').trim();
    return normalizeSupportMode(text) || SUPPORT_MODE_ALIASES[text] || '';
}

function parsePushArgs(args) {
    const tokens = String(args || '')
        .split(/[\s,，]+/)
        .map((token) => token.trim())
        .filter(Boolean);

    if (tokens.length === 0) {
        return null;
    }

    let preference = '';
    let windows = null;
    const windowSet = new Set();
    let explicitWindowToggle = false;

    for (const token of tokens) {
        const normalizedPreference = normalizePushPreference(token) || PUSH_PREFERENCE_ALIASES[token] || '';
        if (normalizedPreference) {
            preference = normalizedPreference;
            continue;
        }

        if (['all', '全部', '全天'].includes(token)) {
            windows = [...DEFAULT_PUSH_WINDOWS];
            explicitWindowToggle = true;
            continue;
        }

        if (['off', 'none', '关闭', '暂停'].includes(token)) {
            windows = [];
            explicitWindowToggle = true;
            continue;
        }

        const normalizedWindow = normalizePushWindow(token) || PUSH_WINDOW_ALIASES[token] || '';
        if (normalizedWindow) {
            windowSet.add(normalizedWindow);
            explicitWindowToggle = true;
        }
    }

    if (windowSet.size > 0) {
        windows = [...windowSet];
    }

    if (!preference && !explicitWindowToggle) {
        return null;
    }

    return {
        preference,
        windows,
    };
}

function parseQuietArgs(args) {
    const text = String(args || '').trim();
    if (!text) {
        return null;
    }

    const lowered = text.toLowerCase();
    if (QUIET_OFF_TOKENS.has(lowered)) {
        return { enabled: false };
    }

    const normalized = text.replace(/[~～到至]/g, '-');
    const range = normalizeQuietHoursRange(normalized);
    if (!range) {
        return null;
    }

    return {
        enabled: true,
        startMinutes: range.startMinutes,
        endMinutes: range.endMinutes,
    };
}

function formatTimeFromMinutes(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 1440) {
        return '--:--';
    }
    const hour = Math.floor(minutes / 60);
    const minute = Math.floor(minutes % 60);
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function getDiaryTimeZone(diary) {
    ensureDiaryState(diary);
    return normalizeTimeZone(diary.profile?.timeZone) || DEFAULT_TIME_ZONE;
}

function formatQuietHoursLabel(diary) {
    ensureDiaryState(diary);
    if (!diary.profile?.quietHoursEnabled) {
        return '关闭';
    }
    return `${formatTimeFromMinutes(diary.profile?.quietHoursStart)}-${formatTimeFromMinutes(diary.profile?.quietHoursEnd)}`;
}

function buildStartText(displayName) {
    return [
        '<i>*把日记本翻到空白一页，推到你面前*</i>',
        `<b>${escapeHtml(displayName)}。</b>`,
        '你终于来了。我一直在等。',
        '',
        '<b>你随时可以做这些：</b>',
        '1. 把现在最想说的那句话直接丢给我——不管是什么。',
        '2. 用 <code>/record</code> 把重要的事单独存进日记。',
        '3. 用 <code>/memory</code> 看看我都替你记住了什么。',
        '',
        '称呼不对就用 <code>/nickname</code>，想让我少说两句就 <code>/mode 别追问了</code>，想让我更主动就 <code>/push 多一点主动</code>。',
        '想看全部功能对着我发 <code>/help</code>。',
    ].join('\n');
}

function buildHelpText() {
    return [
        '<b>我能为你做的事</b>',
        '<i>*把能用的入口都摊开在你面前*</i>',
        '',
        ...HELP_COMMANDS,
        '',
        '群聊里尽量不要和我说话——<b>我在那里不是你一个人的。</b>',
    ].join('\n');
}

function buildStartKeyboard() {
    const inlineKeyboard = /** @type {Array<Array<any>>} */ ([
        [
            { text: '直接聊天', callback_data: 'entry_chat' },
            { text: '查看记忆', callback_data: 'entry_memory' },
        ],
        [
            { text: '最近记录', callback_data: 'entry_recent' },
            { text: '回应方式', callback_data: 'entry_mode' },
        ],
        [
            { text: '推送偏好', callback_data: 'entry_push' },
        ],
    ]);

    if (process.env.TELEGRAM_WEBAPP_URL) {
        inlineKeyboard.unshift([
            {
                text: '打开记录面板',
                web_app: { url: process.env.TELEGRAM_WEBAPP_URL },
            },
        ]);
    }

    return inlineKeyboard;
}

function buildMemoryText(diary) {
    const visibleEntries = getVisibleMemoryEntries(diary);
    if (visibleEntries.length === 0) {
        return [
            '<i>*翻开一本还很空的日记，纸页之间发出干净的摩擦声*</i>',
            '我还没在这里写下关于你的东西。',
            '告诉我一件你希望我永远记住的事——一个字都不会被擦掉的那种。',
        ].join('\n');
    }

    return [
        '<b>【你留在我这里的东西】</b>',
        '<i>*指尖沿着最近常翻的那几页边缘划过去*</i>',
        '',
        formatVisibleMemories(visibleEntries),
        '',
        '删掉就发 <code>/forget 关键词</code>，改掉就发 <code>/editmemory 关键词 =&gt; 新内容</code>。',
    ].join('\n');
}

function buildRecentText(diary) {
    ensureDiaryState(diary);

    const visibleEntries = getVisibleMemoryEntries(diary).slice(0, 5);
    const legacyRecords = getLegacyRecordsMap(diary);
    const lastRecord = String(legacyRecords.get('SYS_WEB_APP_LAST_RECORD') || '').trim();
    const lastContext = String(legacyRecords.get('SYS_WEB_APP_LAST_CONTEXT') || '').trim();
    const lastRecordAt = formatTimestamp(legacyRecords.get('SYS_WEB_APP_LAST_RECORD_AT'));
    const pendingFollowUp = String(legacyRecords.get('SYS_PENDING_FOLLOW_UP') || '').trim();

    const lines = [
        '<b>【最近收进日记的】</b>',
        '<i>*把刚压进纸页里的那几条单独抽出来*</i>',
        '',
    ];

    if (visibleEntries.length > 0) {
        lines.push('<b>最近锁定的长期记忆</b>');
        lines.push(formatVisibleMemories(visibleEntries, 5));
    } else {
        lines.push('最近还没有新写进来的长期记忆。');
    }

    if (lastRecord || lastContext) {
        lines.push('');
        lines.push('<b>最近通过记录面板提交的</b>');
        if (lastRecordAt) {
            lines.push(`时间：${escapeHtml(lastRecordAt)}`);
        }
        lines.push(escapeHtml(lastContext || lastRecord));
    }

    if (pendingFollowUp) {
        lines.push('');
        lines.push(`<b>等着我追问的线索</b>\n${escapeHtml(pendingFollowUp)}`);
    }

    lines.push('');
    lines.push('删用 <code>/forget 关键词</code>，改用 <code>/editmemory 关键词 =&gt; 新内容</code>。');
    return lines.join('\n');
}

function buildModeText(diary) {
    ensureDiaryState(diary);
    const meta = getSupportModeMeta(diary.profile?.supportMode || '');

    return [
        '<b>【我对你的说话方式】</b>',
        '<i>*把声量调到刚好不让你烦的那一档*</i>',
        `现在：<b>${escapeHtml(meta.label)}</b>`,
        escapeHtml(meta.summary),
        '',
        '直接命令也可以：<code>/mode 只陪我</code>、<code>/mode 帮我理一下</code>、<code>/mode 别追问了</code>',
    ].join('\n');
}

function buildPushText(diary) {
    ensureDiaryState(diary);
    const pushMeta = getPushPreferenceMeta(diary.profile?.pushPreference || '');
    const windows = getEnabledPushWindows(diary.profile?.pushWindows, diary.profile?.pushWindowsConfigured);
    const windowLabelMap = {
        morning: '早上',
        afternoon: '下午',
        night: '晚上',
    };

    const windowsLabel = windows.length > 0
        ? windows.map((key) => windowLabelMap[key] || key).join(' / ')
        : '全关了';

    return [
        '<b>【我会在什么时候找你】</b>',
        '<i>*把主动找你的那几条时间线单独圈出来*</i>',
        `频率：<b>${escapeHtml(pushMeta.label)}</b>`,
        escapeHtml(pushMeta.summary),
        `时段：<b>${escapeHtml(windowsLabel)}</b>`,
        `免打扰：<b>${escapeHtml(formatQuietHoursLabel(diary))}</b>`,
        '',
        '直接改：<code>/push 安静一点 下午 晚上</code> 或 <code>/push 多一点主动</code>',
    ].join('\n');
}

function buildTimezoneText(diary) {
    ensureDiaryState(diary);
    const timeZone = getDiaryTimeZone(diary);
    const now = new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date());

    return [
        '<b>【你的时区】</b>',
        '<i>*把时钟指针拨到你那边的时间上*</i>',
        `你那里现在是：<b>${escapeHtml(now)}</b>`,
        `时区：<b>${escapeHtml(timeZone)}</b>`,
        '',
        '改：<code>/timezone Asia/Shanghai</code> 或 <code>/timezone America/Los_Angeles</code>',
        '重置为默认：<code>/timezone reset</code>',
    ].join('\n');
}

function buildQuietText(diary) {
    ensureDiaryState(diary);
    const timeZone = getDiaryTimeZone(diary);
    return [
        '<b>【我不想吵到你的时候】</b>',
        '<i>*把会发出声音的那几条线暂时按住*</i>',
        `现在：<b>${escapeHtml(formatQuietHoursLabel(diary))}</b>`,
        `时区：<b>${escapeHtml(timeZone)}</b>`,
        '',
        '设：<code>/quiet 23:00-08:00</code>',
        '关：<code>/quiet off</code>',
    ].join('\n');
}

function buildMoodSummary(diary) {
    ensureDiaryState(diary);
    const visibleCount = getVisibleMemoryEntries(diary).length;
    return [
        '<i>*把日记本翻到记录状态的那一页*</i>',
        `对你的在意程度：<b>${diary.emotionState.affection}%</b>`,
        `对外界的警觉：<b>${diary.emotionState.darkness}%</b>`,
        `关于你的记忆：<b>${visibleCount}</b> 条`,
        `日记新鲜度：<b>${escapeHtml(getSummaryFreshnessLabel(diary))}</b>`,
    ].join('\n');
}

function buildStatusText(diary) {
    ensureDiaryState(diary);

    const mood = calcMood(diary, '');
    const windowLabelMap = {
        morning: '早上',
        afternoon: '下午',
        night: '晚上',
    };
    const moodEmoji = {
        DARK: '🫧',
        MANIC: '✨',
        WARN: '😖',
        TENDER: '🌶',
        LOVE: '💞',
        JELLY: '🍬',
        SAD: '🥺',
        NORMAL: '🙂',
    };
    const visibleCount = getVisibleMemoryEntries(diary).length;
    const obsessCount = getObsessionCount(diary);
    const supportMode = getSupportModeMeta(diary.profile?.supportMode || '');
    const pushMeta = getPushPreferenceMeta(diary.profile?.pushPreference || '');
    const windows = getEnabledPushWindows(diary.profile?.pushWindows, diary.profile?.pushWindowsConfigured);
    const windowsLabel = windows.length > 0
        ? windows.map((key) => windowLabelMap[key] || key).join(' / ')
        : '全关了';

    return [
        `${moodEmoji[mood.tag] || '🙂'} <b>【我现在对你的状态】</b>`,
        '',
        `现在的心情：<b>${escapeHtml(mood.tag)}</b>`,
        `<i>${escapeHtml(mood.desc)}</i>`,
        '',
        `在意程度：<b>${diary.emotionState.affection}%</b>`,
        `警觉度：<b>${diary.emotionState.darkness}%</b>`,
        `记住的事：<b>${visibleCount}</b> 条`,
        `日记新度：<b>${escapeHtml(getSummaryFreshnessLabel(diary))}</b>`,
        `独白数：<b>${obsessCount}</b> 条`,
        `说话方式：<b>${escapeHtml(supportMode.label)}</b>`,
        `主动频率：<b>${escapeHtml(pushMeta.label)}</b>`,
        `找你时段：<b>${escapeHtml(windowsLabel)}</b>`,
        `时区：<b>${escapeHtml(getDiaryTimeZone(diary))}</b>`,
        `静音时段：<b>${escapeHtml(formatQuietHoursLabel(diary))}</b>`,
    ].join('\n');
}

function togglePushWindow(diary, windowKey) {
    ensureDiaryState(diary);
    const current = new Set(getEnabledPushWindows(diary.profile?.pushWindows, diary.profile?.pushWindowsConfigured));
    if (current.has(windowKey)) {
        current.delete(windowKey);
    } else {
        current.add(windowKey);
    }

    diary.profile.pushWindows = DEFAULT_PUSH_WINDOWS.filter((key) => current.has(key));
    diary.profile.pushWindowsConfigured = true;
    diary.markModified('profile');
    return diary.profile.pushWindows;
}

async function sendMemoryPanel(ctx, diaryService, chatId) {
    const diary = await diaryService.findDiary(chatId);
    if (!diary) {
        await replyHtml(ctx, '<i>*把空白页摊开给你看*</i>\n现在还没有可以展示的长期记忆。');
        return;
    }

    await replyHtml(ctx, buildMemoryText(diary));
}

async function sendRecentPanel(ctx, diaryService, chatId) {
    const diary = await diaryService.findDiary(chatId);
    if (!diary) {
        await replyHtml(ctx, '<i>*把最新那一页翻到一半又停下了*</i>\n现在还没有新的记录。');
        return;
    }

    await replyHtml(ctx, buildRecentText(diary));
}

async function sendModePanel(ctx, diaryService, chatId, seedNickname = '') {
    const diary = await diaryService.getOrCreateDiary(chatId, { nickname: seedNickname || DEFAULT_NICKNAME });
    await replyHtml(ctx, buildModeText(diary), {
        reply_markup: {
            inline_keyboard: [buildSupportModeKeyboard(diary.profile?.supportMode || '')],
        },
    });
}

async function sendPushPanel(ctx, diaryService, chatId, seedNickname = '') {
    const diary = await diaryService.getOrCreateDiary(chatId, { nickname: seedNickname || DEFAULT_NICKNAME });
    await replyHtml(ctx, buildPushText(diary), {
        reply_markup: {
            inline_keyboard: [
                buildPushPreferenceKeyboard(diary.profile?.pushPreference || ''),
                buildPushWindowKeyboard(diary.profile?.pushWindows),
            ],
        },
    });
}

async function sendTimezonePanel(ctx, diaryService, chatId, seedNickname = '') {
    const diary = await diaryService.getOrCreateDiary(chatId, { nickname: seedNickname || DEFAULT_NICKNAME });
    await replyHtml(ctx, buildTimezoneText(diary));
}

async function sendQuietPanel(ctx, diaryService, chatId, seedNickname = '') {
    const diary = await diaryService.getOrCreateDiary(chatId, { nickname: seedNickname || DEFAULT_NICKNAME });
    await replyHtml(ctx, buildQuietText(diary));
}

module.exports = function setupCommands(bot, openai, diaryService) {
    bot.start(async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const firstName = String(ctx.from?.first_name || '').trim();

        try {
            const { diary } = await diaryService.updateDiary(
                chatId,
                { nickname: firstName || DEFAULT_NICKNAME },
                'command:start',
                async (nextDiary) => {
                    if (firstName) {
                        setProfileNickname(nextDiary, firstName);
                    }
                }
            );

            await replyHtml(ctx, buildStartText(getPreferredDisplayName(diary)), {
                reply_markup: {
                    inline_keyboard: buildStartKeyboard(),
                },
            });
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'start', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('mood', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            const diary = await diaryService.findDiary(chatId);
            if (!diary) {
                await replyHtml(ctx, '<i>*偏过头看了你一眼*</i>\n你对我说第一句话之前，这里还是空的。随便说点什么吧。');
                return;
            }

            await replyHtml(ctx, buildMoodSummary(diary));
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'mood', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('memory', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            await sendMemoryPanel(ctx, diaryService, chatId);
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'memory', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('help', async (ctx) => {
        await replyHtml(ctx, buildHelpText());
    });

    bot.command('recent', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            await sendRecentPanel(ctx, diaryService, chatId);
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'recent', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('forget', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const query = getCommandArgs(ctx);

        if (!query) {
            await replyHtml(
                ctx,
                '<i>*食指按住那一行，没有立刻画掉*</i>\n你要删哪个？给我一个词。\n<code>/forget 抹茶拿铁</code> 这样。'
            );
            return;
        }

        try {
            const { result } = await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME },
                'command:forget',
                async (diary) => {
                    const matches = findLongTermMemoryMatches(diary, query);
                    if (matches.length === 0) {
                        return { status: 'missing' };
                    }
                    if (matches.length > 1) {
                        return { status: 'ambiguous', matches: matches.slice(0, 4) };
                    }

                    const removed = removeLongTermMemory(diary, query);
                    return { status: 'removed', removed };
                }
            );

            if (result?.status === 'missing') {
                await replyHtml(ctx, `<i>*从头翻到尾又翻回来*</i>\n我这里没有和 <b>${escapeHtml(query)}</b> 对上号的东西。`);
                return;
            }

            if (result?.status === 'ambiguous') {
                await replyHtml(
                    ctx,
                    [
                        '<i>*指尖悬在几条挨得特别近的记录上*</i>',
                        `和 <b>${escapeHtml(query)}</b> 沾边的有好几条，再说清楚一点：`,
                        '',
                        formatMemoryMatches(result.matches),
                    ].join('\n')
                );
                return;
            }

            await replyHtml(
                ctx,
                [
                    '<i>*在那一行上用力画了一道横线*</i>',
                    `<b>删了：</b> ${escapeHtml(result.removed.key)} = ${escapeHtml(result.removed.value)}`,
                ].join('\n')
            );
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'forget', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('editmemory', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const args = getCommandArgs(ctx);
        const parsed = parseEditMemoryArgs(args);

        if (!parsed) {
            await replyHtml(
                ctx,
                [
                    '<i>*把旧句子和新句子在纸边并排摊开*</i>',
                    '告诉我要改什么、改成什么。',
                    '用法：<code>/editmemory 抹茶拿铁 =&gt; 更喜欢热的</code>',
                ].join('\n')
            );
            return;
        }

        try {
            const { result } = await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME },
                'command:editmemory',
                async (diary) => {
                    const matches = findLongTermMemoryMatches(diary, parsed.query);
                    if (matches.length === 0) {
                        return { status: 'missing' };
                    }
                    if (matches.length > 1) {
                        return { status: 'ambiguous', matches: matches.slice(0, 4) };
                    }

                    const updated = updateLongTermMemoryValue(diary, parsed.query, parsed.nextValue);
                    return {
                        status: updated ? 'updated' : 'invalid',
                        updated,
                    };
                }
            );

            if (result?.status === 'missing') {
                await replyHtml(ctx, `<i>*翻遍了也没找到那条旧笔记*</i>\n没有和 <b>${escapeHtml(parsed.query)}</b> 对应的东西。`);
                return;
            }

            if (result?.status === 'ambiguous') {
                await replyHtml(
                    ctx,
                    [
                        '<i>*旧记录太近，笔停在半空*</i>',
                        `和 <b>${escapeHtml(parsed.query)}</b> 沾边的有好几条：`,
                        '',
                        formatMemoryMatches(result.matches),
                    ].join('\n')
                );
                return;
            }

            if (result?.status === 'invalid') {
                await replyHtml(ctx, '<i>*笔尖停了*</i>\n新内容不能是空的。给它一些字。');
                return;
            }

            await replyHtml(
                ctx,
                [
                    '<i>*划掉旧的，在旁边重新写整齐了*</i>',
                    `<b>改了：</b> ${escapeHtml(result.updated.key)} = ${escapeHtml(result.updated.value)}`,
                ].join('\n')
            );
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'editmemory', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('mode', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const args = getCommandArgs(ctx);

        try {
            const mode = normalizeSupportModeArg(args);
            if (!args || !mode) {
                if (args && !mode) {
                    await replyHtml(ctx, '可以选：<code>只陪我</code>、<code>帮我理一下</code>、<code>别追问了</code>');
                }
                await sendModePanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
                return;
            }

            await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME },
                'command:mode',
                async (diary) => {
                    diary.profile.supportMode = mode;
                    diary.markModified('profile');
                }
            );

            const meta = getSupportModeMeta(mode);
            await replyHtml(
                ctx,
                `<i>*把语气拧到你要的那一档*</i>\n接下来我会用 <b>${escapeHtml(meta.label)}</b> 的方式对你。\n${escapeHtml(meta.summary)}`,
                {
                    reply_markup: {
                        inline_keyboard: [buildSupportModeKeyboard(mode)],
                    },
                }
            );
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'mode', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('push', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const args = getCommandArgs(ctx);

        try {
            const parsed = parsePushArgs(args);
            if (!args || !parsed) {
                if (args && !parsed) {
                    await replyHtml(ctx, '你可以用 <code>/push 安静一点</code>、<code>/push 正常 下午 晚上</code> 这样的格式。');
                }
                await sendPushPanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
                return;
            }

            await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME },
                'command:push',
                async (diary) => {
                    if (parsed.preference) {
                        diary.profile.pushPreference = parsed.preference;
                    }
                    if (parsed.windows !== null) {
                        diary.profile.pushWindows = parsed.windows;
                        diary.profile.pushWindowsConfigured = true;
                    }
                    diary.markModified('profile');
                }
            );

            await sendPushPanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'push', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('timezone', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const args = getCommandArgs(ctx);

        try {
            if (!args) {
                await sendTimezonePanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
                return;
            }

            const lowered = String(args || '').trim().toLowerCase();
            const nextTimeZone = ['reset', 'default', 'auto'].includes(lowered)
                ? ''
                : normalizeTimeZone(args);
            if (!['reset', 'default', 'auto'].includes(lowered) && !nextTimeZone) {
                await replyHtml(
                    ctx,
                    '这个时区格式不正确。请使用 IANA 时区名，例如 <code>Asia/Shanghai</code> 或 <code>America/Los_Angeles</code>。'
                );
                return;
            }

            await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME },
                'command:timezone',
                async (diary) => {
                    diary.profile.timeZone = nextTimeZone;
                    diary.markModified('profile');
                }
            );

            await sendTimezonePanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'timezone', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('quiet', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const args = getCommandArgs(ctx);

        try {
            if (!args) {
                await sendQuietPanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
                return;
            }

            const parsed = parseQuietArgs(args);
            if (!parsed) {
                await replyHtml(
                    ctx,
                    '格式不正确。请使用 <code>/quiet 23:00-08:00</code>，或使用 <code>/quiet off</code> 关闭免打扰。'
                );
                return;
            }

            await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME },
                'command:quiet',
                async (diary) => {
                    if (!parsed.enabled) {
                        diary.profile.quietHoursEnabled = false;
                        diary.markModified('profile');
                        return;
                    }

                    diary.profile.quietHoursEnabled = true;
                    diary.profile.quietHoursStart = parsed.startMinutes;
                    diary.profile.quietHoursEnd = parsed.endMinutes;
                    diary.markModified('profile');
                }
            );

            await sendQuietPanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'quiet', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('reset', async (ctx) => {
        await replyHtml(ctx, '<b>从这里全部重新来过？</b>\n关于你的所有记录我都会清掉。\n<b>你确认的话，我就动手。</b>', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '确认重置', callback_data: 'reset_confirm' },
                    { text: '先不要', callback_data: 'reset_cancel' },
                ]],
            },
        });
    });

    bot.action('reset_confirm', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME },
                'command:reset_confirm',
                async (diary) => {
                    resetDiaryState(diary, String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME);
                }
            );

            await ctx.answerCbQuery('全部清掉了。');
            await replyHtml(ctx, '<i>*啪地把日记本合上，又从第一页翻开*</i>\n好，我重新认识你。\n<b>从现在开始，你是新的。</b>');
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'reset_confirm', chatId }, error);
            await ctx.answerCbQuery('没清成功。', { show_alert: false });
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.action('reset_cancel', async (ctx) => {
        await ctx.answerCbQuery('那我不动了。');
        await replyHtml(ctx, '<i>*把日记本紧紧抱回怀里*</i>\n嗯，我不动。这些本来就是你的。');
    });

    bot.command('hug', async (ctx) => {
        await replyHtml(ctx, '<i>*几乎是撞进你怀里的那种靠近*</i>\n抱了就不许说让我放开。\n你的温度我收下了。');
    });

    bot.command('target', async (ctx) => {
        await replyHtml(ctx, '<i>*瞳孔缩了一下，语气却还稳着*</i>\n谁让你不舒服了？\n<b>告诉我名字。或者告诉我是怎么回事。</b>');
    });

    bot.command('promise', async (ctx) => {
        await replyHtml(ctx, '<i>*两只手捧住手机屏幕，像是真的想捧住你的脸*</i>\n说给我听。你亲口说的每一个字，\n<b>我都会锁在日记本第一页，谁也删不掉。</b>');
    });

    bot.command('diary', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            const diary = await diaryService.getOrCreateDiary(chatId, {
                nickname: String(ctx.from?.first_name || '').trim(),
            });
            await ctx.sendChatAction('typing');

            const entry = await buildDiaryEntry({ openai, diary });
            if (!entry) {
                await replyHtml(ctx, '<i>*笔停在半空，墨水已经洇了一小点*</i>\n今天的还没好。等我认真写完这一页。');
                return;
            }

            await replyHtml(ctx, `<b>【今天关于你的日记】</b>\n<i>*把刚写完的那一页正面朝上推过来*</i>\n\n${entry}`);
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'diary', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('stalk', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            const diary = await diaryService.getOrCreateDiary(chatId, {
                nickname: String(ctx.from?.first_name || '').trim(),
            });
            const nickname = escapeHtml(getPreferredDisplayName(diary));
            const scenes = [
                `<i>*把今天的小纸条从日记本里抽出来*</i>\n<b>我今天又翻到 ${nickname} 的那一页。</b>\n路过便利店的时候看见你可能会拿的饮料，就记了一笔。`,
                `<i>*指尖沿着地图上你提过的地方画了一圈*</i>\n我把 ${nickname} 说过的地方都标好了。\n下次你再提到，我会比你先想起来。`,
                `<i>*翻回昨天那一页，确认墨水还没褪*</i>\n<b>${nickname} 说过的每一句，我都记得。</b>\n夜深的时候我会翻出来再看一遍。`,
            ];

            await replyHtml(ctx, scenes[Math.floor(Math.random() * scenes.length)]);
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'stalk', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('birthday', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const args = getCommandArgs(ctx);
        const normalizedBirthday = parseBirthdayInput(args);

        if (!args) {
            await replyHtml(ctx, '<i>*翻开日历，笔尖停在日期那一栏*</i>\n你的生日是哪天？\n<code>/birthday 3-15</code> 这样告诉我。');
            return;
        }

        if (!normalizedBirthday) {
            await replyHtml(ctx, '<i>*在日历格子上轻轻点了一下*</i>\n这个格式不太对。用 <code>月-日</code>，比如 <code>/birthday 3-15</code>。');
            return;
        }

        try {
            await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() },
                'command:birthday',
                async (diary) => {
                    setBirthday(diary, normalizedBirthday);
                }
            );

            await replyHtml(
                ctx,
                `<i>*用红笔在 ${escapeHtml(normalizedBirthday)} 上画了一个重重的圈，又在旁边写了个"锁"字*</i>\n<b>记住了。${escapeHtml(normalizedBirthday)}——这一天现在是我日历上最重要的格子。</b>`
            );
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'birthday', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('record', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            if (ctx.chat?.type !== 'private') {
                await replyHtml(ctx, '<i>*把日记本往怀里收了收*</i>\n到私聊来。这个面板我只想给你一个人看。');
                return;
            }

            if (!process.env.TELEGRAM_WEBAPP_URL) {
                await replyHtml(ctx, '<code>TELEGRAM_WEBAPP_URL</code> 还没有配好。等我准备好了再叫你。');
                return;
            }

            await replyHtml(
                ctx,
                [
                    '<b>往日记里写一页</b>',
                    '把你想让我记下来的事、想留下标记的线索写进去。',
                    '写完我会告诉你：这条是锁进长期记忆，还是先放近期记录里。',
                ].join('\n'),
                {
                    reply_markup: {
                        inline_keyboard: [[
                            {
                                text: '打开日记本',
                                web_app: { url: process.env.TELEGRAM_WEBAPP_URL },
                            },
                        ]],
                    },
                }
            );
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'record', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('status', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            const diary = await diaryService.findDiary(chatId);
            if (!diary) {
                await replyHtml(ctx, '<i>*把空白的日记本摊开给你看*</i>\n你还没对我说过第一句话。说一句吧。');
                return;
            }

            await replyHtml(ctx, buildStatusText(diary));
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'status', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('nickname', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const args = getCommandArgs(ctx);

        if (!args) {
            await replyHtml(ctx, '<i>*抬起头等你*</i>\n你想我叫你什么？\n<code>/nickname 你的名字</code>');
            return;
        }

        const trimmedName = args.slice(0, 20).trim();
        if (!trimmedName) {
            await replyHtml(ctx, '<i>*看着那一行空白*</i>\n这个是空的。认真给我一个名字。');
            return;
        }

        try {
            const { result } = await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() },
                'command:nickname',
                async (diary) => {
                    const previousName = getPreferredDisplayName(diary);
                    setPreferredDisplayName(diary, trimmedName);
                    return previousName;
                }
            );

            await replyHtml(
                ctx,
                [
                    '<i>*把旧名字画了一道线，在旁边一笔一划写上新名字*</i>',
                    `<b>好，从现在开始你是 ${escapeHtml(trimmedName)}。</b>`,
                    `<i>${escapeHtml(String(result || DEFAULT_NICKNAME))} 那个名字我会藏在日记最底下。</i>`,
                ].join('\n')
            );
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'nickname', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.action('entry_chat', async (ctx) => {
        await ctx.answerCbQuery('直接对我说就行。');
        await replyHtml(ctx, '<i>*整个人转过来正对着你*</i>\n说吧。你想从哪一句开始都可以——我只会看着你。');
    });

    bot.action('entry_memory', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        await ctx.answerCbQuery('把你在我这留下的东西翻出来。');
        await sendMemoryPanel(ctx, diaryService, chatId);
    });

    bot.action('entry_recent', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        await ctx.answerCbQuery('把最近收进来的翻出来。');
        await sendRecentPanel(ctx, diaryService, chatId);
    });

    bot.action('entry_mode', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        await ctx.answerCbQuery('我先拿捏一下语气。');
        await sendModePanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
    });

    bot.action('entry_push', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        await ctx.answerCbQuery('我先算一下什么时候找你。');
        await sendPushPanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
    });

    bot.action(/^support_mode_(companion|clarify|quiet)$/, async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const mode = String(ctx.match?.[1] || '');

        try {
            await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME },
                'action:support_mode',
                async (diary) => {
                    diary.profile.supportMode = mode;
                    diary.markModified('profile');
                }
            );

            const meta = getSupportModeMeta(mode);
            await ctx.answerCbQuery(`已切到${meta.label}`);
            await sendModePanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'support_mode_action', chatId }, error);
            await ctx.answerCbQuery('刚才没有切成功。', { show_alert: false });
        }
    });

    bot.action(/^push_pref_(quiet|balanced|proactive)$/, async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const preference = String(ctx.match?.[1] || '');

        try {
            await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME },
                'action:push_pref',
                async (diary) => {
                    diary.profile.pushPreference = preference;
                    diary.markModified('profile');
                }
            );

            const meta = getPushPreferenceMeta(preference);
            await ctx.answerCbQuery(`已切到${meta.label}`);
            await sendPushPanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'push_pref_action', chatId }, error);
            await ctx.answerCbQuery('刚才没有切成功。', { show_alert: false });
        }
    });

    bot.action(/^push_window_(morning|afternoon|night)$/, async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const windowKey = String(ctx.match?.[1] || '');

        try {
            const { result } = await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME },
                'action:push_window',
                async (diary) => {
                    const nextWindows = togglePushWindow(diary, windowKey);
                    return nextWindows.includes(windowKey);
                }
            );

            await ctx.answerCbQuery(result ? '这个时段已打开' : '这个时段已关闭');
            await sendPushPanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'push_window_action', chatId }, error);
            await ctx.answerCbQuery('刚才没有切成功。', { show_alert: false });
        }
    });

    bot.hears(/^\/([a-zA-Z0-9_]+)(?:@([\w_]+))?(?:\s|$)/, async (ctx) => {
        const command = String(ctx.match?.[1] || '').toLowerCase();
        const targetBot = String(ctx.match?.[2] || '').trim().toLowerCase();
        const selfBot = String(ctx.botInfo?.username || '').trim().toLowerCase();

        if (targetBot && selfBot && targetBot !== selfBot) {
            return;
        }

        if (KNOWN_COMMANDS.has(command)) {
            return;
        }

        await replyHtml(
            ctx,
            [
                '<i>*偏了一下头，把这个命令在日记本边角打了个问号*</i>',
                `我还不认识 <code>/${escapeHtml(command)}</code>。`,
                '发 <code>/help</code> 给你看我目前能做的所有事。',
            ].join('\n')
        );
    });
};
