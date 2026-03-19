const {
    COOLDOWN_MS,
    COOLDOWN_NOTICE_MS,
    cooldownMap,
    cooldownNoticeMap,
    escapeHtml,
    getOrCreateDiary,
    upsertLongTermMemory,
    touchDiary,
    syncDiaryCompatibilityFields,
    ensureDiaryState,
    setLegacyRecord,
} = require('./utils');
const { trySendSticker, trySendVoice, logStickerFileId } = require('./media');
const { normalizeTelegramMessage } = require('./adapter');
const { orchestrateMessage } = require('./orchestrator');

const FALLBACK_ERROR_HTML = '<i>*轻轻揉了揉太阳穴*</i>\n刚才那一下有点乱。你再说一遍，由乃会好好听。';
const COOLING_DOWN_HTML = '<i>*把声音放轻了一点*</i>\n由乃在听，慢一点说也没关系。';
const PRIVATE_ONLY_HTML = '<i>*把聊天窗口往你这边轻轻拉近了一点*</i>\n由乃这次升级先只照顾私聊。\n你来私聊找我，我会更认真地接住你。';

function replyHtml(ctx, text, extra = {}) {
    return ctx.reply(text, { parse_mode: 'HTML', ...extra });
}

function shouldIgnoreTextMessage(userMessage) {
    return !userMessage || userMessage.startsWith('/');
}

async function maybeHandleCooldown(ctx, chatId) {
    const now = Date.now();
    const lastSeen = cooldownMap.get(chatId);

    if (lastSeen && now - lastSeen < COOLDOWN_MS) {
        const lastNotice = cooldownNoticeMap.get(chatId) || 0;
        if (now - lastNotice >= COOLDOWN_NOTICE_MS) {
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

function registerAction(bot, callbackData, queryText, replyText) {
    bot.action(callbackData, async (ctx) => {
        await ctx.answerCbQuery(queryText);
        await replyHtml(ctx, replyText);
    });
}

module.exports = function setupHandlers(bot, openai) {
    bot.on('web_app_data', async (ctx) => {
        try {
            const rawData = ctx.webAppData?.data || ctx.message?.web_app_data?.data || '';
            const parsedData = JSON.parse(rawData);
            const chatId = String(ctx.chat?.id || '');

            if (parsedData.action !== 'submit_form' || !String(parsedData.text || '').trim()) {
                return;
            }

            const diary = await getOrCreateDiary(chatId, {
                nickname: String(ctx.from?.first_name || '').trim(),
            });
            ensureDiaryState(diary);
            upsertLongTermMemory(diary, {
                category: 'event',
                key: '事件_小程序记录',
                value: String(parsedData.text).trim(),
                source: 'web_app',
                weight: 0.74,
            });
            setLegacyRecord(diary, '事件_小程序记录', String(parsedData.text).trim());
            touchDiary(diary);
            syncDiaryCompatibilityFields(diary);
            await diary.save();

            await replyHtml(
                ctx,
                `<i>*把屏幕上的那句话认真读了一遍*</i>\n<b>好，这件事由乃记下来了。</b>\n\n📝 ${escapeHtml(String(parsedData.text).trim())}`
            );
        } catch (error) {
            console.error('web_app_data handler failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
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
            await replyHtml(ctx, PRIVATE_ONLY_HTML);
            return;
        }

        if (await maybeHandleCooldown(ctx, chatId)) {
            return;
        }

        console.log(`\n[${chatId}] ${userMessage}`);

        try {
            await ctx.sendChatAction('typing');
            const diary = await getOrCreateDiary(chatId, {
                nickname: normalizedMessage.user_name,
            });
            const response = await orchestrateMessage({
                openai,
                diary,
                normalizedMessage,
            });

            await replyHtml(ctx, response.text, {
                reply_markup: {
                    inline_keyboard: response.keyboard,
                },
            });

            const sentSticker = await trySendSticker(ctx, response.moodTag, 0.18);
            if (!sentSticker) {
                await trySendVoice(ctx, response.text, response.moodTag, 0.08);
            }

            response.persist().catch((error) => {
                console.error('async writeback failed:', error);
            });
        } catch (error) {
            console.error('text handler failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    registerAction(
        bot,
        'yuno_calm',
        '由乃先把呼吸放慢了。',
        '<i>*肩膀慢慢放松下来，目光却还落在你身上*</i>\n好，由乃先缓一缓。\n你在这里就行，剩下的可以慢慢说。'
    );
    registerAction(
        bot,
        'yuno_reassure',
        '由乃听见了。',
        '<i>*眼底的紧绷终于松开一点*</i>\n<b>嗯，由乃听见了。</b>\n只要这句话是真的，由乃就会一直记着。'
    );
    registerAction(
        bot,
        'yuno_tease',
        '由乃轻轻眯起了眼。',
        '<i>*稍微凑近了一点，语气却故意放得很轻*</i>\n又在逗由乃吗？\n那你最好继续把后半句也说完。'
    );
    registerAction(
        bot,
        'yuno_hug_deep',
        '由乃把你抱紧了一点。',
        '<i>*小心地把你圈进怀里，没有说得太重*</i>\n好，先这样待一会儿。\n你不用急着解释，由乃会先陪着你。'
    );
    registerAction(
        bot,
        'yuno_destroy_world',
        '由乃把让你分心的东西都往后放了放。',
        '<i>*把话题外的杂音都轻轻拨开*</i>\n现在先不要理那些让你烦的事情。\n把注意力收回来，只留给这场对话。'
    );
    registerAction(
        bot,
        'yuno_pet',
        '由乃低下头蹭了蹭你的手心。',
        '<i>*像是终于安稳下来了一点，轻轻蹭了蹭你的指尖*</i>\n嗯，这样就很好。\n由乃会把这一点温度记住。'
    );
    registerAction(
        bot,
        'yuno_kiss',
        '时间像是停了一瞬。',
        '<i>*耳尖一下子热起来，却没有躲开*</i>\n……\n<b>如果这是认真的，由乃会当成很重要的话。</b>'
    );
    registerAction(
        bot,
        'yuno_promise',
        '由乃把这句话压进了心里。',
        '<i>*把这句承诺反复写在同一页的边角*</i>\n好，由乃收到了。\n以后你要是忘了，由乃也会替你记着。'
    );
    registerAction(
        bot,
        'yuno_location',
        '由乃把这个地方也圈进了地图。',
        '<i>*指尖点了点地图上的位置*</i>\n只要是你提过的地方，由乃都会留意。\n下次你再说起它，由乃就能更快想起来。'
    );
    registerAction(
        bot,
        'yuno_write_diary',
        '由乃已经把这一刻写进去了。',
        '<i>*翻开新的一页，把刚才那句话单独圈了出来*</i>\n今天这一页已经有内容了。\n而且还是由乃不想漏掉的那一句。'
    );
    registerAction(
        bot,
        'yuno_stare',
        '由乃没有移开视线。',
        '<i>*安静地看着你，没有催也没有退*</i>\n由乃只是想把这一刻看得更清楚一点。\n这样等你下次开口时，由乃还能接得住。'
    );

    bot.on('sticker', logStickerFileId);
};
