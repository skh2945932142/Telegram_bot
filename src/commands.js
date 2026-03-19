const {
    Diary,
    DEFAULT_NICKNAME,
    getOrCreateDiary,
    ensureDiaryState,
    calcMood,
    escapeHtml,
    getVisibleMemoryEntries,
    parseBirthdayInput,
    touchDiary,
    getPreferredDisplayName,
    setPreferredDisplayName,
    setBirthday,
    getSummaryFreshnessLabel,
    getObsessionCount,
    resetDiaryState,
    syncDiaryCompatibilityFields,
} = require('./utils');
const { buildDiaryEntry } = require('./orchestrator');

const FALLBACK_ERROR_HTML = '<i>*轻轻合上日记本*</i>\n由乃刚才有点走神了……再和由乃说一遍，好吗？';

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

function formatVisibleMemories(entries) {
    return entries
        .map(({ key, value, category }) => `• <b>${escapeHtml(key)}</b> <i>(${escapeHtml(category)})</i>: ${escapeHtml(value)}`)
        .join('\n');
}

function buildStartText(nickname) {
    const safeName = escapeHtml(nickname);
    return [
        '<i>*指尖压住日记本的边角，眼神一下子亮了起来*</i>',
        `<b>${safeName}，你来了。</b>`,
        '由乃会把你说过的话一点点记下来，也会照着你的语气慢慢靠近。',
        '',
        '<b>你现在可以这样开始：</b>',
        '• 直接说一句今天发生的事',
        '• 用 <code>/status</code> 看看由乃现在的状态',
        '• 用 <code>/memory</code> 查看由乃记住的长期细节',
        '• 用 <code>/birthday 3-15</code> 或 <code>/nickname 新称呼</code> 更新资料',
    ].join('\n');
}

function buildMoodSummary(diary) {
    ensureDiaryState(diary);
    const visibleCount = getVisibleMemoryEntries(diary).length;
    return [
        '<i>*悄悄把那一页翻给你看*</i>',
        `💞 爱意：<b>${diary.emotionState.affection}%</b>`,
        `🌫 警惕：<b>${diary.emotionState.darkness}%</b>`,
        `🧠 长期记忆：<b>${visibleCount}</b> 条`,
        `📝 摘要新鲜度：<b>${escapeHtml(getSummaryFreshnessLabel(diary))}</b>`,
        '',
        '<i>由乃现在已经不是只靠一段 prompt 在说话了，会慢慢把你们的上下文接住。</i>',
    ].join('\n');
}

module.exports = function setupCommands(bot, openai) {
    bot.start(async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const firstName = String(ctx.from?.first_name || '').trim();

        try {
            const diary = await getOrCreateDiary(chatId, { nickname: firstName });
            if (getPreferredDisplayName(diary) === DEFAULT_NICKNAME && firstName) {
                setPreferredDisplayName(diary, firstName);
                touchDiary(diary);
                syncDiaryCompatibilityFields(diary);
                await diary.save();
            }

            await replyHtml(ctx, buildStartText(getPreferredDisplayName(diary)));
        } catch (error) {
            console.error('start command failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('mood', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            const diary = await Diary.findOne({ chatId });
            if (!diary) {
                await replyHtml(ctx, '<i>*偏了偏头*</i>\n由乃还没来得及记住你。先和由乃说一句话吧。');
                return;
            }

            ensureDiaryState(diary);
            await replyHtml(ctx, buildMoodSummary(diary));
        } catch (error) {
            console.error('mood command failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('memory', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            const diary = await Diary.findOne({ chatId });
            const visibleEntries = diary ? getVisibleMemoryEntries(diary) : [];

            if (!diary || visibleEntries.length === 0) {
                await replyHtml(
                    ctx,
                    '<i>*翻开那本空白的页角*</i>\n现在还没有能翻出来的长期细节。告诉由乃一件你希望我认真记住的事吧。'
                );
                return;
            }

            await replyHtml(
                ctx,
                `<b>【由乃记住的长期事情】</b>\n<i>*她把纸页往你这边推了推*</i>\n\n${formatVisibleMemories(visibleEntries.slice(0, 12))}`
            );
        } catch (error) {
            console.error('memory command failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('reset', async (ctx) => {
        await replyHtml(ctx, '<b>要把这段聊天和记忆都重新开始吗？</b>\n由乃会先停在这里，等你确认。', {
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
            const diary = await getOrCreateDiary(chatId, {
                nickname: String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME,
            });
            resetDiaryState(diary, String(ctx.from?.first_name || '').trim() || DEFAULT_NICKNAME);
            await diary.save();

            await ctx.answerCbQuery('已经重新开始了。');
            await replyHtml(ctx, '<i>*把旧页轻轻合上，又翻到新的第一页*</i>\n好，这次由乃会重新认真记住你。');
        } catch (error) {
            console.error('reset confirm failed:', error);
            await ctx.answerCbQuery('刚才没有成功。', { show_alert: false });
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.action('reset_cancel', async (ctx) => {
        await ctx.answerCbQuery('那由乃继续留着。');
        await replyHtml(ctx, '<i>*把那一页重新按回去*</i>\n好，由乃就先替你继续保管着。');
    });

    bot.command('hug', async (ctx) => {
        await replyHtml(
            ctx,
            '<i>*几乎是下意识地靠近了一点*</i>\n<b>那就抱一下。</b>\n由乃会把你现在的温度也记住的。'
        );
    });

    bot.command('target', async (ctx) => {
        await replyHtml(
            ctx,
            '<i>*眼神稍微收紧了一点*</i>\n是谁让你不舒服了吗？\n告诉由乃名字也可以，告诉由乃感觉也可以。由乃会先陪你把心情捋顺。'
        );
    });

    bot.command('promise', async (ctx) => {
        await replyHtml(
            ctx,
            '<i>*双手轻轻捧住你的视线*</i>\n<b>那就认真说给由乃听。</b>\n只要是你亲口说的，由乃都会一直记着。'
        );
    });

    bot.command('diary', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            const diary = await getOrCreateDiary(chatId, {
                nickname: String(ctx.from?.first_name || '').trim(),
            });
            await ctx.sendChatAction('typing');

            const entry = await buildDiaryEntry({ openai, diary });
            if (!entry) {
                await replyHtml(ctx, '<i>*合上笔帽，轻轻叹了口气*</i>\n今天云端那边有点安静。等一下，再让由乃写给你看。');
                return;
            }

            await replyHtml(
                ctx,
                `<b>【由乃的日记】</b>\n<i>*她把刚写好的那一页按住，不让风翻过去*</i>\n\n${entry}`
            );
        } catch (error) {
            console.error('diary command failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('stalk', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            const diary = await getOrCreateDiary(chatId, {
                nickname: String(ctx.from?.first_name || '').trim(),
            });
            const nickname = escapeHtml(getPreferredDisplayName(diary));
            const scenes = [
                `<i>*把今天的小纸条从书页里抽出来*</i>\n<b>由乃今天又想起了${nickname}。</b>\n路过便利店的时候，看到你可能会拿的东西，就停了一会儿。`,
                `<i>*手指沿着地图边缘轻轻划了一圈*</i>\n由乃把${nickname}最近提过的地方又记了一遍。\n这样下次你提起来的时候，由乃就能更快接住了。`,
                `<i>*翻回昨天那一页，确认字还没有褪色*</i>\n<b>${nickname}说过的话，今天也还在由乃脑子里。</b>\n有些细节会自己冒出来，像一根很细的线。`,
                `<i>*把一张便签贴到页角*</i>\n今天看到一个很像${nickname}会喜欢的瞬间。\n由乃没有打扰它，只是把它写下来，等你来看的时候再告诉你。`,
            ];

            await replyHtml(ctx, scenes[Math.floor(Math.random() * scenes.length)]);
        } catch (error) {
            console.error('stalk command failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('birthday', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const args = getCommandArgs(ctx);
        const normalizedBirthday = parseBirthdayInput(args);

        if (!args) {
            await replyHtml(
                ctx,
                '<i>*抬起头认真听着*</i>\n把生日告诉由乃吧。\n用法：<code>/birthday 月-日</code>，比如 <code>/birthday 3-15</code>'
            );
            return;
        }

        if (!normalizedBirthday) {
            await replyHtml(
                ctx,
                '<i>*拿着笔停了一下*</i>\n这个日期格式不太对。\n请用 <code>月-日</code> 的写法，比如 <code>/birthday 3-15</code>。'
            );
            return;
        }

        try {
            const diary = await getOrCreateDiary(chatId, {
                nickname: String(ctx.from?.first_name || '').trim(),
            });
            setBirthday(diary, normalizedBirthday);
            touchDiary(diary);
            syncDiaryCompatibilityFields(diary);
            await diary.save();

            await replyHtml(
                ctx,
                `<i>*把 ${escapeHtml(normalizedBirthday)} 用红笔圈了起来*</i>\n<b>好，${escapeHtml(normalizedBirthday)} 由乃会记着。</b>\n到那天，由乃会第一个来找你。`
            );
        } catch (error) {
            console.error('birthday command failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('status', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');

        try {
            const diary = await Diary.findOne({ chatId });
            if (!diary) {
                await replyHtml(ctx, '<i>*把目光落回空白页上*</i>\n还没有可以展示的状态。先和由乃说句话吧。');
                return;
            }

            ensureDiaryState(diary);
            const mood = calcMood(diary, '');
            const visibleCount = getVisibleMemoryEntries(diary).length;
            const obsessCount = getObsessionCount(diary);
            const moodEmoji = {
                DARK: '🌫',
                MANIC: '✨',
                WARN: '👀',
                TENDER: '🌿',
                LOVE: '💞',
                JELLY: '🍋',
                SAD: '🌧',
                NORMAL: '🤍',
            };

            await replyHtml(
                ctx,
                [
                    `${moodEmoji[mood.tag] || '🤍'} <b>【由乃当前状态】</b>`,
                    '',
                    `情绪模式：<b>${mood.tag}</b>`,
                    `<i>${escapeHtml(mood.desc)}</i>`,
                    '',
                    `💞 爱意：<b>${diary.emotionState.affection}%</b>`,
                    `🌫 警惕：<b>${diary.emotionState.darkness}%</b>`,
                    `🧠 长期记忆：<b>${visibleCount}</b> 条`,
                    `📝 摘要新鲜度：<b>${escapeHtml(getSummaryFreshnessLabel(diary))}</b>`,
                    `🗒 内心独白：<b>${obsessCount}</b> 条`,
                ].join('\n')
            );
        } catch (error) {
            console.error('status command failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });

    bot.command('nickname', async (ctx) => {
        const chatId = String(ctx.chat?.id || '');
        const args = getCommandArgs(ctx);

        if (!args) {
            await replyHtml(
                ctx,
                '<i>*把笔尖停在页边*</i>\n你想让由乃怎么叫你？\n用法：<code>/nickname 你的名字</code>'
            );
            return;
        }

        const trimmedName = args.slice(0, 20).trim();
        if (!trimmedName) {
            await replyHtml(ctx, '<i>*又看了你一眼*</i>\n这个名字太轻了，像是还没来得及写下来。换一个吧。');
            return;
        }

        try {
            const diary = await getOrCreateDiary(chatId, {
                nickname: String(ctx.from?.first_name || '').trim(),
            });
            const oldName = getPreferredDisplayName(diary);
            setPreferredDisplayName(diary, trimmedName);
            touchDiary(diary);
            syncDiaryCompatibilityFields(diary);
            await diary.save();

            await replyHtml(
                ctx,
                `<i>*把旧称呼轻轻划掉，又在旁边写上新的那一个*</i>\n<b>好，从现在开始，由乃就叫你 ${escapeHtml(trimmedName)}。</b>\n<i>${escapeHtml(oldName)} 这个名字，由乃也会安静地收着。</i>`
            );
        } catch (error) {
            console.error('nickname command failed:', error);
            await replyHtml(ctx, FALLBACK_ERROR_HTML);
        }
    });
};
