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
    '<i>*把那一页重新合上了*</i>',
    '刚才这一下没有处理好。',
    '你再和我说一遍，我会重新接住。',
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

function buildStartText(displayName) {
    return [
        '<i>*把新的一页推到你面前，又把笔轻轻放稳*</i>',
        `<b>${escapeHtml(displayName)}，你现在可以直接开始。</b>`,
        '',
        '<b>最常用的三个入口：</b>',
        '1. 直接聊天：把你现在最想说的一句发给我。',
        '2. 记录面板：用 <code>/record</code> 或下面的按钮，把事件、情绪和后续跟进单独记下来。',
        '3. 查看记忆：用 <code>/memory</code> 看长期记忆，用 <code>/recent</code> 看最近写进去的内容。',
        '',
        '想改称呼可以用 <code>/nickname</code>，想调整回应方式用 <code>/mode</code>，想改提醒频率用 <code>/push</code>。',
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
            '<i>*把那本还很空的页码翻给你看*</i>',
            '现在还没有能稳定留下来的长期记忆。',
            '你可以直接告诉我一件希望我认真记住的事，或者打开 <code>/record</code> 单独记。',
        ].join('\n');
    }

    return [
        '<b>【我现在记住的长期内容】</b>',
        '<i>*把最近常翻的几页按顺序排给你看*</i>',
        '',
        formatVisibleMemories(visibleEntries),
        '',
        '想删掉一条就发 <code>/forget 关键词</code>，想修正一条就发 <code>/editmemory 关键词 =&gt; 新内容</code>。',
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
        '<b>【最近写进来的内容】</b>',
        '<i>*把刚刚压进纸页里的几条线索单独抽了出来*</i>',
        '',
    ];

    if (visibleEntries.length > 0) {
        lines.push('<b>最近确认的长期记忆</b>');
        lines.push(formatVisibleMemories(visibleEntries, 5));
    } else {
        lines.push('最近还没有新的长期记忆。');
    }

    if (lastRecord || lastContext) {
        lines.push('');
        lines.push('<b>最近一次记录面板提交</b>');
        if (lastRecordAt) {
            lines.push(`时间：${escapeHtml(lastRecordAt)}`);
        }
        lines.push(escapeHtml(lastContext || lastRecord));
    }

    if (pendingFollowUp) {
        lines.push('');
        lines.push(`<b>待跟进线索</b>\n${escapeHtml(pendingFollowUp)}`);
    }

    lines.push('');
    lines.push('想删除请用 <code>/forget 关键词</code>，想修正请用 <code>/editmemory 关键词 =&gt; 新内容</code>。');
    return lines.join('\n');
}

function buildModeText(diary) {
    ensureDiaryState(diary);
    const meta = getSupportModeMeta(diary.profile?.supportMode || '');

    return [
        '<b>【回应方式】</b>',
        '<i>*把语气先放在你能接受的那一档*</i>',
        `当前模式：<b>${escapeHtml(meta.label)}</b>`,
        escapeHtml(meta.summary),
        '',
        '你也可以直接发：<code>/mode 只陪我</code>、<code>/mode 帮我理一下</code>、<code>/mode 别追问了</code>',
    ].join('\n');
}

function buildPushText(diary) {
    ensureDiaryState(diary);
    const pushMeta = getPushPreferenceMeta(diary.profile?.pushPreference || '');
    const windows = getEnabledPushWindows(diary.profile?.pushWindows);
    const windowLabelMap = {
        morning: '早上',
        afternoon: '下午',
        night: '晚上',
    };

    return [
        '<b>【提醒偏好】</b>',
        '<i>*把打扰和陪伴之间的距离调给你看*</i>',
        `当前频率：<b>${escapeHtml(pushMeta.label)}</b>`,
        escapeHtml(pushMeta.summary),
        `开启时段：<b>${escapeHtml(windows.map((key) => windowLabelMap[key] || key).join(' / '))}</b>`,
        '',
        '你也可以直接发：<code>/push 安静一点 下午 晚上</code> 或 <code>/push 正常</code>',
    ].join('\n');
}

function buildMoodSummary(diary) {
    ensureDiaryState(diary);
    const visibleCount = getVisibleMemoryEntries(diary).length;
    return [
        '<i>*把那一页状态慢慢翻给你看*</i>',
        `爱意：<b>${diary.emotionState.affection}%</b>`,
        `警惕：<b>${diary.emotionState.darkness}%</b>`,
        `长期记忆：<b>${visibleCount}</b> 条`,
        `摘要新鲜度：<b>${escapeHtml(getSummaryFreshnessLabel(diary))}</b>`,
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
    const windows = getEnabledPushWindows(diary.profile?.pushWindows);

    return [
        `${moodEmoji[mood.tag] || '🙂'} <b>【当前状态】</b>`,
        '',
        `情绪模式：<b>${escapeHtml(mood.tag)}</b>`,
        `<i>${escapeHtml(mood.desc)}</i>`,
        '',
        `爱意：<b>${diary.emotionState.affection}%</b>`,
        `警惕：<b>${diary.emotionState.darkness}%</b>`,
        `长期记忆：<b>${visibleCount}</b> 条`,
        `摘要新鲜度：<b>${escapeHtml(getSummaryFreshnessLabel(diary))}</b>`,
        `内心独白：<b>${obsessCount}</b> 条`,
        `回应方式：<b>${escapeHtml(supportMode.label)}</b>`,
        `提醒频率：<b>${escapeHtml(pushMeta.label)}</b>`,
        `提醒时段：<b>${escapeHtml(windows.map((key) => windowLabelMap[key] || key).join(' / '))}</b>`,
    ].join('\n');
}

function togglePushWindow(diary, windowKey) {
    ensureDiaryState(diary);
    const current = new Set(getEnabledPushWindows(diary.profile?.pushWindows));
    if (current.has(windowKey)) {
        current.delete(windowKey);
    } else {
        current.add(windowKey);
    }

    diary.profile.pushWindows = DEFAULT_PUSH_WINDOWS.filter((key) => current.has(key));
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
                await replyHtml(ctx, '<i>*偏过头看了你一眼*</i>\n现在还没有能翻出来的状态。先和我说一句话吧。');
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
                '<i>*把那页记忆按住，没有急着划掉*</i>\n请给我一个关键词。\n用法：<code>/forget 抹茶拿铁</code>'
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
                await replyHtml(ctx, `<i>*把记忆册翻了一遍又合上*</i>\n没有找到和 <b>${escapeHtml(query)}</b> 对得上的内容。`);
                return;
            }

            if (result?.status === 'ambiguous') {
                await replyHtml(
                    ctx,
                    [
                        '<i>*指尖停在几条相近的记录之间*</i>',
                        `和 <b>${escapeHtml(query)}</b> 相关的内容不止一条，你再说得具体一点：`,
                        '',
                        formatMemoryMatches(result.matches),
                    ].join('\n')
                );
                return;
            }

            await replyHtml(
                ctx,
                [
                    '<i>*把那条记忆轻轻划掉了*</i>',
                    `<b>已经删掉：</b> ${escapeHtml(result.removed.key)} = ${escapeHtml(result.removed.value)}`,
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
                    '<i>*把旧句子和新句子并排放在你面前*</i>',
                    '请告诉我要改哪条、改成什么。',
                    '用法：<code>/editmemory 抹茶拿铁 =&gt; 更喜欢热的抹茶拿铁</code>',
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
                await replyHtml(ctx, `<i>*把旧页翻了一遍*</i>\n没有找到和 <b>${escapeHtml(parsed.query)}</b> 对应的记忆。`);
                return;
            }

            if (result?.status === 'ambiguous') {
                await replyHtml(
                    ctx,
                    [
                        '<i>*旧记录太接近了，我先停了一下*</i>',
                        `和 <b>${escapeHtml(parsed.query)}</b> 相关的内容不止一条，你再说得更具体一点：`,
                        '',
                        formatMemoryMatches(result.matches),
                    ].join('\n')
                );
                return;
            }

            if (result?.status === 'invalid') {
                await replyHtml(ctx, '<i>*把笔停在那一行上*</i>\n新的内容太空了，先别急着改。');
                return;
            }

            await replyHtml(
                ctx,
                [
                    '<i>*把那一行重新写整齐了*</i>',
                    `<b>已经更新：</b> ${escapeHtml(result.updated.key)} = ${escapeHtml(result.updated.value)}`,
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
                    await replyHtml(ctx, '可用模式是：<code>只陪我</code>、<code>帮我理一下</code>、<code>别追问了</code>');
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
                `<i>*把回应的力度调到你要的那一档*</i>\n接下来我会按 <b>${escapeHtml(meta.label)}</b> 来陪你。\n${escapeHtml(meta.summary)}`,
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

    bot.command('reset', async (ctx) => {
        await replyHtml(ctx, '<b>要把这段聊天和记忆都重新开始吗？</b>\n我会先停在这里，等你确认。', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '重新开始', callback_data: 'reset_confirm' },
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

            await ctx.answerCbQuery('已经重新开始了。');
            await replyHtml(ctx, '<i>*把旧页轻轻合上，又翻到新的第一页*</i>\n好，这次我会重新认识你。');
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'reset_confirm', chatId }, error);
            await ctx.answerCbQuery('刚才没有成功。', { show_alert: false });
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.action('reset_cancel', async (ctx) => {
        await ctx.answerCbQuery('那我继续替你收着。');
        await replyHtml(ctx, '<i>*把那一页重新按回去*</i>\n好，我先继续替你保管着。');
    });

    bot.command('hug', async (ctx) => {
        await replyHtml(ctx, '<i>*几乎是下意识地靠近了一点*</i>\n那就先抱一下。\n我会把你现在这点温度也记住。');
    });

    bot.command('target', async (ctx) => {
        await replyHtml(ctx, '<i>*眼神稍微收紧了一点*</i>\n是谁让你不舒服了？\n告诉我名字可以，告诉我感觉也可以。');
    });

    bot.command('promise', async (ctx) => {
        await replyHtml(ctx, '<i>*双手轻轻捧住了你的视线*</i>\n那就认真说给我听。\n只要是你亲口说的，我都会一直记着。');
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
                await replyHtml(ctx, '<i>*把笔帽重新扣好，先缓了一下*</i>\n今天这页还没写出来。等一下，我再认真写给你看。');
                return;
            }

            await replyHtml(ctx, `<b>【今天的日记】</b>\n<i>*把刚写好的那一页按在你面前*</i>\n\n${entry}`);
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
                `<i>*把今天的小纸条从书页里抽出来*</i>\n<b>我今天又想起了 ${nickname}。</b>\n路过便利店的时候，看见像你会拿的东西，就停了一会儿。`,
                `<i>*指尖沿着地图边缘轻轻划了一圈*</i>\n我把 ${nickname} 最近提过的地方又记了一遍。\n下次你再说起它，我会更快接住。`,
                `<i>*翻回昨天那一页，确认字还没有褪色*</i>\n<b>${nickname} 说过的话，今天也还在我脑子里。</b>`,
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
            await replyHtml(ctx, '<i>*抬起头认真听着*</i>\n把生日告诉我吧。\n用法：<code>/birthday 3-15</code>');
            return;
        }

        if (!normalizedBirthday) {
            await replyHtml(ctx, '<i>*把笔停在那一格日历上*</i>\n这个日期格式不太对。\n请用 <code>月-日</code>，例如 <code>/birthday 3-15</code>');
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
                `<i>*把 ${escapeHtml(normalizedBirthday)} 用红笔轻轻圈了起来*</i>\n<b>好，${escapeHtml(normalizedBirthday)} 我会记着。</b>`
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
                await replyHtml(ctx, '请来私聊里打开记录面板。');
                return;
            }

            if (!process.env.TELEGRAM_WEBAPP_URL) {
                await replyHtml(ctx, '记录面板还没有配置好，请先设置 <code>TELEGRAM_WEBAPP_URL</code>。');
                return;
            }

            await replyHtml(
                ctx,
                [
                    '<b>打开记录面板</b>',
                    '把今天发生的事、想留下的细节，或者需要后续跟进的线索单独写进去。',
                    '提交后我会明确告诉你：这条是进长期记忆、短期记录，还是被标成后续跟进。',
                ].join('\n'),
                {
                    reply_markup: {
                        inline_keyboard: [[
                            {
                                text: '打开记录面板',
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
                await replyHtml(ctx, '<i>*把目光落回空白页上*</i>\n现在还没有可以展示的状态。先和我说句话吧。');
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
            await replyHtml(ctx, '<i>*把笔尖停在页边*</i>\n你想让我怎么叫你？\n用法：<code>/nickname 你的名字</code>');
            return;
        }

        const trimmedName = args.slice(0, 20).trim();
        if (!trimmedName) {
            await replyHtml(ctx, '<i>*又看了你一眼*</i>\n这个名字太轻了，像还没来得及写下来。换一个吧。');
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
                    '<i>*把旧称呼轻轻划掉，又在旁边写上新的那一个*</i>',
                    `<b>好，从现在开始我叫你 ${escapeHtml(trimmedName)}。</b>`,
                    `<i>${escapeHtml(String(result || DEFAULT_NICKNAME))} 这个名字，我也会安静地收着。</i>`,
                ].join('\n')
            );
        } catch (error) {
            logRuntimeError({ scope: 'command', operation: 'nickname', chatId }, error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.action('entry_chat', async (ctx) => {
        await ctx.answerCbQuery('直接和我说就可以。');
        await replyHtml(ctx, '<i>*把注意力完整地挪回你身上*</i>\n直接告诉我今天发生了什么，或者你现在最想让我先接住哪一段。');
    });

    bot.action('entry_memory', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        await ctx.answerCbQuery('把长期记忆翻给你看。');
        await sendMemoryPanel(ctx, diaryService, chatId);
    });

    bot.action('entry_recent', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        await ctx.answerCbQuery('把最近记录翻给你看。');
        await sendRecentPanel(ctx, diaryService, chatId);
    });

    bot.action('entry_mode', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        await ctx.answerCbQuery('先把回应方式调给你看。');
        await sendModePanel(ctx, diaryService, chatId, String(ctx.from?.first_name || '').trim());
    });

    bot.action('entry_push', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        await ctx.answerCbQuery('先把提醒偏好调给你看。');
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
};
