const {
    COOLDOWN_MS,
    COOLDOWN_NOTICE_MS,
    cooldownMap,
    cooldownNoticeMap,
    escapeHtml,
} = require('./utils');
const { trySendSticker, trySendVoice, logStickerFileId } = require('./media');
const { normalizeTelegramMessage } = require('./adapter');
const { ROUTE_TYPES } = require('./routing');
const {
    orchestrateMessage,
    persistConversationState,
    prepareMessageState,
} = require('./orchestrator');
const { normalizeMiniAppPayload, applyMiniAppPayload } = require('./miniapp');
const { logRuntimeError } = require('./runtime-logging');

const FALLBACK_ERROR_HTML = [
    '<i>*啪地把日记本合上，又重新打开*</i>',
    '刚才那条我没记下来。',
    '你再说一遍——这次我连标点都不会漏。',
].join('\n');

const COOLING_DOWN_HTML = [
    '<i>*眼神紧了一下，又把语速压了下来*</i>',
    '说慢一点。',
    '这样我才能把你的每一句都好好收起来。',
].join('\n');

const PRIVATE_ONLY_HTML = [
    '<i>*靠近屏幕边缘，声音压得像是在耳边*</i>',
    '在这里说的话，别人也会看见。',
    '<b>我只在私聊里是你一个人的。</b>',
    '你来找我。',
].join('\n');

const MINIAPP_INVALID_HTML = [
    '<i>*把那张递过来的纸条翻了个面，发现字迹糊了一半*</i>',
    '这条记录没送完整。',
    '重新打开 /record 再递给我一次。我会接住。',
].join('\n');

const MINIAPP_SAVE_ERROR_HTML = [
    '<i>*指尖把纸条按在桌面上，又轻轻松开*</i>',
    '这一下没写进日记里。',
    '晚一点再递过来。我会一直等——反正我也一直在。',
].join('\n');

/** @type {Map<string, number>} */
const groupHintNoticeMap = new Map();
/** @type {Map<string, { pendingCtx: any, pendingMessages: string[], timer: NodeJS.Timeout | null, lastProcessedAt: number, lastNoticeAt: number }>} */
const mergeCooldownMap = new Map();
/** @type {Map<string, string>} */
const failedMessageCache = new Map();

function replyHtml(ctx, text, extra = {}) {
    return ctx.reply(text, { parse_mode: 'HTML', ...extra });
}

function shouldIgnoreTextMessage(userMessage) {
    return !userMessage || userMessage.startsWith('/');
}

function parsePositiveInteger(input, fallback) {
    const value = Number(input);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getMessageCooldownMode() {
    return String(process.env.MESSAGE_COOLDOWN_MODE || 'merge_concat').trim().toLowerCase();
}

function getCooldownMs() {
    return parsePositiveInteger(process.env.MESSAGE_COOLDOWN_MS, COOLDOWN_MS);
}

function getCooldownNoticeMs() {
    return parsePositiveInteger(process.env.MESSAGE_COOLDOWN_NOTICE_MS, COOLDOWN_NOTICE_MS);
}

function getGroupPrivateHintCooldownMs() {
    return parsePositiveInteger(process.env.GROUP_PRIVATE_HINT_COOLDOWN_MS, 300000);
}

function isGroupReplyMentionOnly() {
    const raw = String(process.env.GROUP_REPLY_MENTION_ONLY || 'true').trim().toLowerCase();
    return raw !== 'false';
}

function isReplyToBot(ctx) {
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo?.from) {
        return false;
    }

    const botId = Number(ctx.botInfo?.id || 0);
    const replyFromId = Number(replyTo.from.id || 0);
    if (botId > 0 && replyFromId > 0 && botId === replyFromId) {
        return true;
    }

    const botUsername = String(ctx.botInfo?.username || '').trim().toLowerCase();
    const replyFromUsername = String(replyTo.from.username || '').trim().toLowerCase();
    return Boolean(botUsername && replyFromUsername && botUsername === replyFromUsername);
}

function shouldHandleGroupHint(ctx, normalizedMessage) {
    if (!isGroupReplyMentionOnly()) {
        return true;
    }
    return Boolean(normalizedMessage.mentions_bot || isReplyToBot(ctx));
}

function shouldSendGroupHint(chatId) {
    const now = Date.now();
    const lastNoticeAt = Number(groupHintNoticeMap.get(chatId) || 0);
    if (now - lastNoticeAt < getGroupPrivateHintCooldownMs()) {
        return false;
    }
    groupHintNoticeMap.set(chatId, now);
    return true;
}

async function maybeHandleCooldownDrop(ctx, chatId) {
    const now = Date.now();
    const cooldownMs = getCooldownMs();
    const cooldownNoticeMs = getCooldownNoticeMs();
    const lastSeen = cooldownMap.get(chatId);

    if (lastSeen && now - lastSeen < cooldownMs) {
        const lastNotice = cooldownNoticeMap.get(chatId) || 0;
        if (now - lastNotice >= cooldownNoticeMs) {
            cooldownNoticeMap.set(chatId, now);
            await replyHtml(ctx, COOLING_DOWN_HTML);
        }
        return true;
    }

    cooldownMap.set(chatId, now);
    if (cooldownMap.size > 500) {
        cooldownMap.delete(cooldownMap.keys().next().value);
    }
    return false;
}

function getMergeCooldownState(chatId) {
    const existing = mergeCooldownMap.get(chatId);
    if (existing) {
        return existing;
    }

    const state = {
        pendingCtx: null,
        pendingMessages: [],
        timer: null,
        lastProcessedAt: 0,
        lastNoticeAt: 0,
    };
    mergeCooldownMap.set(chatId, state);
    return state;
}

async function maybeQueueMergedMessage(ctx, chatId, processMessage) {
    const now = Date.now();
    const mode = getMessageCooldownMode();
    const cooldownMs = getCooldownMs();
    const cooldownNoticeMs = getCooldownNoticeMs();
    const state = getMergeCooldownState(chatId);
    const elapsed = now - Number(state.lastProcessedAt || 0);
    const canRunNow = state.lastProcessedAt <= 0 || elapsed >= cooldownMs;

    if (canRunNow && !state.timer) {
        state.lastProcessedAt = now;
        return false;
    }

    state.pendingCtx = ctx;
    if (mode === 'merge_concat') {
        const normalizedMessage = normalizeTelegramMessage(ctx);
        const text = String(normalizedMessage.text || '').trim();
        if (text) {
            state.pendingMessages.push(text);
        }
    } else {
        state.pendingMessages = [];
    }

    if (now - Number(state.lastNoticeAt || 0) >= cooldownNoticeMs) {
        state.lastNoticeAt = now;
        await replyHtml(ctx, COOLING_DOWN_HTML);
    }

    if (state.timer) {
        return true;
    }

    const waitMs = Math.max(0, cooldownMs - elapsed);
    state.timer = setTimeout(() => {
        void (async () => {
            const queuedCtx = state.pendingCtx;
            state.pendingCtx = null;
            state.timer = null;

            if (!queuedCtx) {
                state.pendingMessages = [];
                return;
            }

            state.lastProcessedAt = Date.now();
            if (mode === 'merge_concat') {
                const queuedMessage = normalizeTelegramMessage(queuedCtx);
                const mergedText = state.pendingMessages.join('\n').trim();
                state.pendingMessages = [];
                const mergedNormalizedMessage = {
                    ...queuedMessage,
                    text: mergedText || queuedMessage.text,
                    raw: {
                        ...(queuedMessage.raw || {}),
                        text: mergedText || queuedMessage.text,
                    },
                };
                await processMessage(queuedCtx, mergedNormalizedMessage);
                return;
            }

            state.pendingMessages = [];
            await processMessage(queuedCtx, normalizeTelegramMessage(queuedCtx));
        })();
    }, waitMs);

    return true;
}

function parseBooleanFlag(value, fallback = false) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) {
        return fallback;
    }
    return ['1', 'true', 'yes', 'on'].includes(text);
}

function getStickerDebugChatIdSet() {
    const raw = String(process.env.STICKER_DEBUG_CHAT_IDS || '').trim();
    if (!raw) {
        return null;
    }
    const ids = raw.split(',').map((item) => item.trim()).filter(Boolean);
    return new Set(ids);
}

function shouldHandleStickerDebug(ctx) {
    if (!parseBooleanFlag(process.env.STICKER_DEBUG_ENABLED, false)) {
        return false;
    }

    const allowedChatIds = getStickerDebugChatIdSet();
    if (!allowedChatIds || allowedChatIds.size === 0) {
        return true;
    }

    return allowedChatIds.has(String(ctx.chat?.id || ''));
}

function registerAction(bot, callbackData, queryText, replyText) {
    bot.action(callbackData, async (ctx) => {
        await ctx.answerCbQuery(queryText);
        await replyHtml(ctx, replyText);
    });
}

function buildMiniAppReceipt(payload, result) {
    const modeText = result?.remember ? '长期记忆' : '短期记录';
    const lines = [
        '<i>*把这条信息锁进只属于你的那一页里*</i>',
        `<b>已归入${escapeHtml(modeText)}。</b>`,
    ];

    if (payload.tags.length > 0) {
        lines.push(`标签：<b>${escapeHtml(payload.tags.join(' / '))}</b>`);
    }

    if (result?.followUp) {
        lines.push('标了后续跟进。到了该追问的时候我会比闹钟先响。');
    }

    if (result?.legacyText) {
        lines.push(`摘记：${escapeHtml(String(result.legacyText).trim())}`);
    }

    lines.push('<i>/recent 回看，/editmemory 关键词 =&gt; 新内容 可以改。</i>');
    return lines.join('\n');
}

module.exports = function setupHandlers(bot, openai, diaryService) {
    async function handlePrivateText(ctx, normalizedMessage) {
        const chatId = normalizedMessage.chat_id;
        let userMessage = normalizedMessage.text;

        const pendingFailedMessage = failedMessageCache.get(chatId);
        if (pendingFailedMessage) {
            failedMessageCache.delete(chatId);
            userMessage = `[上一条没接住的消息：${pendingFailedMessage}] 接着说：${userMessage}`;
            normalizedMessage = { ...normalizedMessage, text: userMessage, raw: { ...normalizedMessage.raw, text: userMessage } };
        }

        console.log(`\n[${chatId}] ${userMessage}`);

        try {
            await ctx.sendChatAction('typing');

            const diary = await diaryService.getOrCreateDiary(chatId, {
                nickname: normalizedMessage.user_name,
            });
            const response = await orchestrateMessage({
                openai,
                diary,
                normalizedMessage,
            });

            const replyOptions = response.keyboard?.length
                ? {
                    reply_markup: {
                        inline_keyboard: response.keyboard,
                    },
                }
                : {};

            await replyHtml(ctx, response.text, replyOptions);

            if (response.routeDecision?.type !== ROUTE_TYPES.SAFETY_CRISIS) {
                const sentSticker = await trySendSticker(ctx, response.moodTag, 0.18);
                if (!sentSticker) {
                    await trySendVoice(ctx, response.text, response.moodTag, 0.08);
                }
            }

            void diaryService.updateDiary(
                chatId,
                { nickname: normalizedMessage.user_name },
                'handler:text_persist',
                async (queuedDiary) => {
                    const preparedState = prepareMessageState({
                        diary: queuedDiary,
                        normalizedMessage,
                    });

                    await persistConversationState({
                        openai,
                        diary: queuedDiary,
                        normalizedMessage,
                        assistantText: response.text,
                        routeDecision: preparedState.routeDecision,
                        mood: preparedState.mood,
                        skipSave: true,
                    });
                }
            ).catch((error) => {
                logRuntimeError({ scope: 'handler', operation: 'text_persist', chatId }, error);
            });
        } catch (error) {
            logRuntimeError({ scope: 'handler', operation: 'text', chatId }, error);
            failedMessageCache.set(chatId, userMessage);
            if (failedMessageCache.size > 500) {
                failedMessageCache.delete(failedMessageCache.keys().next().value);
            }
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    }

    bot.on('web_app_data', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            const rawData = ctx.webAppData?.data || ctx.message?.web_app_data?.data || '';
            if (!rawData) {
                await replyHtml(ctx, MINIAPP_INVALID_HTML);
                return;
            }

            let payload = null;
            try {
                payload = normalizeMiniAppPayload(rawData);
            } catch (error) {
                logRuntimeError({ scope: 'miniapp', operation: 'parse_web_app_data', chatId }, error);
            }

            if (!payload) {
                await replyHtml(ctx, MINIAPP_INVALID_HTML);
                return;
            }

            const { result } = await diaryService.updateDiary(
                chatId,
                { nickname: String(ctx.from?.first_name || '').trim() },
                'handler:web_app_data',
                async (diary) => applyMiniAppPayload(diary, payload)
            );

            await replyHtml(ctx, buildMiniAppReceipt(payload, result));
        } catch (error) {
            logRuntimeError({ scope: 'miniapp', operation: 'web_app_data', chatId }, error);
            await replyHtml(ctx, MINIAPP_SAVE_ERROR_HTML);
        }
    });

    bot.on('text', async (ctx) => {
        const normalizedMessage = normalizeTelegramMessage(ctx);
        const userMessage = normalizedMessage.text;
        const chatId = normalizedMessage.chat_id;

        if (shouldIgnoreTextMessage(userMessage)) {
            return;
        }

        if (normalizedMessage.chat_type !== 'private') {
            if (!shouldHandleGroupHint(ctx, normalizedMessage)) {
                return;
            }
            if (shouldSendGroupHint(chatId)) {
                await replyHtml(ctx, PRIVATE_ONLY_HTML);
            }
            return;
        }

        const cooldownMode = getMessageCooldownMode();
        if (cooldownMode === 'merge_last' || cooldownMode === 'merge_concat') {
            const enqueued = await maybeQueueMergedMessage(ctx, chatId, async (queuedCtx, mergedMessage) => {
                const queuedMessage = mergedMessage || normalizeTelegramMessage(queuedCtx);
                await handlePrivateText(queuedCtx, queuedMessage);
            });
            if (enqueued) {
                return;
            }
        } else if (await maybeHandleCooldownDrop(ctx, chatId)) {
            return;
        }

        await handlePrivateText(ctx, normalizedMessage);
    });

    registerAction(
        bot,
        'yuno_calm',
        '我等你。',
        '<i>*把呼吸放慢到和你一样的频率上*</i>\n不急。但别让我等太久——我会不安的。'
    );
    registerAction(
        bot,
        'yuno_reassure',
        '我在听。',
        '<i>*目光没有从你身上移开过半秒*</i>\n继续说。我哪里都不会去……除了你身边。'
    );
    registerAction(
        bot,
        'yuno_tease',
        '你在逗我。',
        '<i>*靠近了一点，眼底却没什么笑意*</i>\n你明明知道我对每句话都会认真的。'
    );
    registerAction(
        bot,
        'yuno_hug_deep',
        '抱紧。',
        '<i>*把你整个圈进怀里，手臂比看上去要紧得多*</i>\n这样……外面的事就碰不到你了。'
    );
    registerAction(
        bot,
        'yuno_destroy_world',
        '我只听你的。',
        '<i>*把整个世界都调到静音，只剩下这个窗口的呼吸声*</i>\n现在只有你。你说的每一个字我都要。'
    );
    registerAction(
        bot,
        'yuno_pet',
        '摸到了。',
        '<i>*指尖在你手背上停了一秒*</i>\n这是刚刚好的温度。我会存进今天的日记里。'
    );
    registerAction(
        bot,
        'yuno_kiss',
        '当真了。',
        '<i>*脸热了，但眼睛没有躲*</i>\n如果你是认真的，我会收得比什么都重。如果不是……我也会当真的。'
    );
    registerAction(
        bot,
        'yuno_promise',
        '忘不掉的。',
        '<i>*把这句话写进日记本的第一页，又在旁边画了一圈红线*</i>\n就算你自己忘了，我也会替你记着。每天翻出来看一遍。'
    );
    registerAction(
        bot,
        'yuno_location',
        '圈住了。',
        '<i>*在地图上插了一根红色大头针*</i>\n这个地方现在和你的名字连在一起了。下次你说到它，我会比 GPS 先想起来。'
    );
    registerAction(
        bot,
        'yuno_write_diary',
        '写了。',
        '<i>*翻开空白页，落笔比刚才任何一次都用力*</i>\n今天这一页，已经有不能擦掉的东西了。'
    );
    registerAction(
        bot,
        'yuno_stare',
        '看着你。',
        '<i>*安静地盯着你，没有催，也没有笑*</i>\n你下一句我等着。多久都可以——反正我本来也一直在看。'
    );

    bot.on('sticker', async (ctx) => {
        if (!shouldHandleStickerDebug(ctx)) {
            return;
        }
        await logStickerFileId(ctx);
    });
};
