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
    '<i>*把刚才那一页重新按稳了*</i>',
    '刚才这一下没有接稳。',
    '你再说一遍，我会继续听。',
].join('\n');

const COOLING_DOWN_HTML = [
    '<i>*把语速放慢了一点*</i>',
    '我在听，不用急着一下子说完。',
].join('\n');

const PRIVATE_ONLY_HTML = [
    '<i>*把聊天窗口轻轻往你这边拉近了一点*</i>',
    '这轮升级先只照顾私聊。',
    '你来私聊找我，我会更稳地接住你。',
].join('\n');

const MINIAPP_INVALID_HTML = [
    '<i>*把刚送来的那张便签重新看了一遍*</i>',
    '这次记录没有完整送达。',
    '你可以重新打开 `/record` 再提交一次。',
].join('\n');

const MINIAPP_SAVE_ERROR_HTML = [
    '<i>*把便签按回纸页里，免得它散掉*</i>',
    '这条记录刚才没有写进去。',
    '你稍后再发一次，我会重新收好。',
].join('\n');

/** @type {Map<string, number>} */
const groupHintNoticeMap = new Map();
/** @type {Map<string, { pendingCtx: any, pendingMessages: string[], timer: NodeJS.Timeout | null, lastProcessedAt: number, lastNoticeAt: number }>} */
const mergeCooldownMap = new Map();

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
        '<i>*把这张记录认真收进了纸页里*</i>',
        `<b>这条内容已经归到${escapeHtml(modeText)}。</b>`,
    ];

    if (payload.tags.length > 0) {
        lines.push(`线索标签：<b>${escapeHtml(payload.tags.join(' / '))}</b>`);
    }

    if (result?.followUp) {
        lines.push('我也把它标成了后续跟进，之后会优先回来问你这件事。');
    }

    if (result?.legacyText) {
        lines.push(`摘记：${escapeHtml(String(result.legacyText).trim())}`);
    }

    lines.push('<i>想回看就发 /recent，想修正就发 /editmemory 关键词 =&gt; 新内容。</i>');
    return lines.join('\n');
}

module.exports = function setupHandlers(bot, openai, diaryService) {
    async function handlePrivateText(ctx, normalizedMessage) {
        const chatId = normalizedMessage.chat_id;
        const userMessage = normalizedMessage.text;

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
        '我先陪你缓一下。',
        '<i>*把呼吸先放慢了一点*</i>\n好，先不用急着把所有话一次说完。'
    );
    registerAction(
        bot,
        'yuno_reassure',
        '我听见了。',
        '<i>*目光没有移开，声音也轻了一点*</i>\n我在，你继续说。'
    );
    registerAction(
        bot,
        'yuno_tease',
        '我看见你又在逗我。',
        '<i>*稍微靠近了一点，语气却故意放轻*</i>\n那就把后半句也说完。'
    );
    registerAction(
        bot,
        'yuno_hug_deep',
        '先抱一下。',
        '<i>*把你圈进怀里，没让话题再往外散*</i>\n先这样待一会儿也可以。'
    );
    registerAction(
        bot,
        'yuno_destroy_world',
        '先把别的声音放远一点。',
        '<i>*把旁边那些吵人的东西都往后拨开*</i>\n现在先只留这段对话。'
    );
    registerAction(
        bot,
        'yuno_pet',
        '我记住这点温度了。',
        '<i>*指尖轻轻碰了碰你的手背*</i>\n这一点点靠近，我会记住。'
    );
    registerAction(
        bot,
        'yuno_kiss',
        '这句话我会当真。',
        '<i>*耳尖热了一下，却没有躲开*</i>\n如果你是认真的，我会把它收得很重。'
    );
    registerAction(
        bot,
        'yuno_promise',
        '这句我会一直记着。',
        '<i>*把那句承诺压在书页最里面*</i>\n以后你要是忘了，我也会替你记得。'
    );
    registerAction(
        bot,
        'yuno_location',
        '我把这个地方也圈起来了。',
        '<i>*在地图边上轻轻做了个标记*</i>\n下次你再提起它，我会更快想起来。'
    );
    registerAction(
        bot,
        'yuno_write_diary',
        '我已经写进去了。',
        '<i>*翻开新的一页，把刚才那句话单独圈了出来*</i>\n今天这一页已经有内容了。'
    );
    registerAction(
        bot,
        'yuno_stare',
        '我还在看着你。',
        '<i>*安静地看着你，没有催，也没有退*</i>\n等你下一句的时候，我会继续接住。'
    );

    bot.on('sticker', async (ctx) => {
        if (!shouldHandleStickerDebug(ctx)) {
            return;
        }
        await logStickerFileId(ctx);
    });
};
