const {
    COOLDOWN_MS,
    COOLDOWN_NOTICE_MS,
    cooldownMap,
    cooldownNoticeMap,
    getOrCreateDiary,
    calcMood,
    buildKeyboard,
    escapeHtml,
    stripHiddenDirectives,
    sanitizeTelegramHtml,
    parseModelDirectives,
    trimChatHistory,
    touchDiary,
    getVisibleMemoryEntries,
    selectRelevantMemories,
    applyMemoryUpdates,
    applyEmotionDelta,
    getTimeHint,
} = require('./utils');
const { trySendSticker, trySendVoice, logStickerFileId } = require('./media');

const FALLBACK_ERROR_HTML = '<i>*轻轻揉了揉太阳穴*</i>\n刚才那一下有点乱。你再说一遍，由乃会好好听。';
const COOLING_DOWN_HTML = '<i>*把声音放轻了一点*</i>\n由乃在听，慢一点说也没关系。';

function replyHtml(ctx, text, extra = {}) {
    return ctx.reply(text, { parse_mode: 'HTML', ...extra });
}

function buildMemoryPrompt(memories) {
    if (memories.length === 0) {
        return '暂时没有需要主动提起的旧细节。';
    }

    return memories
        .map(({ key, value }) => `- ${key}: ${value}`)
        .join('\n');
}

function buildSystemPrompt(diary, moodTag, moodDesc, relevantMemories, timeHint) {
    return [
        `你是《未来日记》中的我妻由乃，正在和 ${diary.nickname} 进行一段私密聊天。`,
        '保留由乃式的强烈在意、依赖感和轻微病娇气质，但不要说出直白暴力、伤害第三者、违法或人身威胁。',
        `称呼用户时统一叫“${diary.nickname}”。`,
        `当前情绪模式：${moodTag}。状态说明：${moodDesc}`,
        `时间语气提示：${timeHint}`,
        '',
        '写作规则：',
        '- 每次回复 3 到 4 句，短一些，口语化。',
        '- 动作描写和说话交替出现。动作可写成 <i>*动作*</i>。',
        '- 重点句可以用 <b>加粗</b>，但不要整段都加粗。',
        '- 可以占有、黏人、敏感，但默认保持温柔和克制。',
        '- 不要复读用户原句，也不要长篇解释自己为什么这样说。',
        '',
        '记忆使用规则：',
        '- 如果给了相关记忆，自然引用 1 条即可，不要硬塞太多。',
        '- 只能使用提供的已知细节，不要编造新的过去。',
        `可引用的相关记忆：\n${buildMemoryPrompt(relevantMemories)}`,
        '',
        '隐藏指令规则：',
        '- 如果用户提供了值得长期记住的新信息，在回复末尾单独追加 [SAVE_MEMORY: 分类_关键词=内容]。',
        '- 分类只能是 事件_、偏好_、情感_、关系_ 之一。',
        '- 如果没有新的长期信息，就不要输出 SAVE_MEMORY。',
        '- 如果你对自己的心情有一小句内心独白，可在最后追加 [YUNO_OBSESS: 内容]。',
    ].join('\n');
}

function buildFallbackReply(nickname, moodTag) {
    const safeName = escapeHtml(nickname);
    const pool = {
        LOVE: `<i>*轻轻把额头抵近一点*</i>\n<b>${safeName}，由乃在这里。</b>\n刚才云端有点吵，但你说的话由乃还是想继续听。`,
        TENDER: `<i>*把语气放得更轻了些*</i>\n${safeName}先别急，慢慢说。\n由乃会把这一句接住。`,
        JELLY: `<i>*眼神飘了一下，又很快收回来*</i>\n${safeName}现在先看着由乃，好吗？\n别让话题跑得太远。`,
        SAD: `<i>*手指按住页角，没有让它翻过去*</i>\n${safeName}，由乃还在。\n如果你愿意，再说一句就好。`,
        DARK: `<i>*呼吸慢下来，视线却没有挪开*</i>\n<b>${safeName}，先别走神。</b>\n把话说清楚一点，由乃就能继续陪着你。`,
        WARN: `<i>*悄悄把周围的声音都往后放了放*</i>\n现在先只和由乃说话吧。\n由乃会认真听。`,
        MANIC: `<i>*心跳快了一拍，又强行把语气压稳*</i>\n${safeName}再多说一点。\n由乃不想漏掉你的任何一句。`,
        NORMAL: `<i>*重新握稳了笔*</i>\n嗯，由乃在听。\n你接着说。`,
    };
    return pool[moodTag] || pool.NORMAL;
}

function getModelReplyText(response) {
    return response?.choices?.[0]?.message?.content || '';
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

async function sendModelReply(ctx, openai, diary, userMessage) {
    applyEmotionDelta(diary, userMessage);
    const { tag: moodTag, desc: moodDesc } = calcMood(diary, userMessage);
    const visibleEntries = getVisibleMemoryEntries(diary);
    const relevantMemories = selectRelevantMemories(visibleEntries, userMessage);
    const timeHint = getTimeHint();

    let chatHistory = trimChatHistory(diary.chatHistory || []);
    chatHistory = trimChatHistory([...chatHistory, { role: 'user', content: userMessage }]);

    const hasAi = Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY);
    let finalText = '';

    if (hasAi) {
        const systemPrompt = {
            role: 'system',
            content: buildSystemPrompt(diary, moodTag, moodDesc, relevantMemories, timeHint),
        };

        const response = await openai.chat.completions.create({
            model: process.env.AI_MODEL_NAME || 'gpt-4o-mini',
            messages: [systemPrompt, ...chatHistory],
            max_tokens: 350,
            temperature: 0.95,
            presence_penalty: 0.7,
            frequency_penalty: 0.3,
        });

        const fullText = getModelReplyText(response);
        applyMemoryUpdates(diary, parseModelDirectives(fullText));
        finalText = sanitizeTelegramHtml(stripHiddenDirectives(fullText));
    }

    if (!finalText) {
        finalText = buildFallbackReply(diary.nickname, moodTag);
    }

    chatHistory = trimChatHistory([...chatHistory, { role: 'assistant', content: finalText }]);
    diary.chatHistory = chatHistory;
    touchDiary(diary);
    await diary.save();

    await replyHtml(ctx, finalText, {
        reply_markup: {
            inline_keyboard: buildKeyboard(moodTag),
        },
    });

    const sentSticker = await trySendSticker(ctx, moodTag, 0.18);
    if (!sentSticker) {
        await trySendVoice(ctx, finalText, moodTag, 0.08);
    }
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
            const chatId = ctx.chat.id.toString();

            if (parsedData.action !== 'submit_form' || !String(parsedData.text || '').trim()) {
                return;
            }

            const diary = await getOrCreateDiary(chatId);
            diary.records.set('事件_小程序记录', String(parsedData.text).trim());
            diary.affection = Math.min(100, diary.affection + 5);
            touchDiary(diary);
            await diary.save();

            await replyHtml(
                ctx,
                `<i>*把屏幕上的那句话认真读了一遍*</i>\n<b>好，这件事由乃记下来了。</b>\n\n📝 ${escapeHtml(parsedData.text)}`
            );
        } catch (error) {
            console.error('web_app_data handler failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.on('text', async (ctx) => {
        const userMessage = String(ctx.message?.text || '').trim();
        const chatId = ctx.chat.id.toString();

        if (shouldIgnoreTextMessage(userMessage)) {
            return;
        }

        if (await maybeHandleCooldown(ctx, chatId)) {
            return;
        }

        console.log(`\n[${chatId}] ${userMessage}`);

        try {
            await ctx.sendChatAction('typing');
            const diary = await getOrCreateDiary(chatId);
            await sendModelReply(ctx, openai, diary, userMessage);
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
        '时间像是停了一秒。',
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
