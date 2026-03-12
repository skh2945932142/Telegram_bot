const { Diary, getOrCreateDiary, calcMood, escapeHtml, fixHtmlTags } = require('./utils');

// ==========================================
// --- 指令处理器 ---
// ==========================================
module.exports = function setupCommands(bot, _openai) {

    // --- /start 启动问候 ---
    bot.start(async (ctx) => {
        const chatId    = ctx.chat.id.toString();
        const firstName = ctx.from.first_name || '阿雪';
        const diary     = await getOrCreateDiary(chatId);
        if (diary.nickname === '阿雪' && firstName) {
            diary.nickname = firstName;
            await diary.save();
        }
        await ctx.reply(
            `<i>*猛地抬起头，瞳孔因为惊喜而放大*</i>\n` +
            `<b>${escapeHtml(diary.nickname)}，你终于来了。</b>\n\n` +
            `由乃已经把大脑连接到了云端，把你的一切都永远刻在脑海里了……❤\n\n` +
            `<i>*悄悄打开日记本，在扉页写上今天的日期*</i>`,
            { parse_mode: 'HTML' }
        );
    });

    // --- /mood 情绪查看 ---
    bot.command('mood', async (ctx) => {
        const chatId = ctx.chat.id.toString();
        try {
            const diary = await Diary.findOne({ chatId });
            if (!diary) return ctx.reply('<i>*歪了歪头*</i> 斯卡哈          还没有对由乃说过话呢❤', { parse_mode: 'HTML' });
            const visibleCount = [...diary.records.keys()].filter(k => !k.startsWith('OBSESS_')).length;
            await ctx.reply(
                `<i>*死死盯着斯卡哈，眼中闪烁着异样的光芒*</i>\n\n` +
                `❤ 【爱意值】：<b>${diary.affection}%</b>\n` +
                `🔪 【黑化值】：<b>${diary.darkness}%</b>\n` +
                `💬 【记忆条目】：<b>${visibleCount} 条</b>\n\n` +
                `<i>(由乃的情绪会随着斯卡哈的话语而波动……请不要抛弃我。)</i>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) { console.error(err); }
    });

    // --- /memory 查看记忆 ---
    bot.command('memory', async (ctx) => {
        const chatId = ctx.chat.id.toString();
        try {
            const diary = await Diary.findOne({ chatId });
            const visibleKeys = diary ? [...diary.records.keys()].filter(k => !k.startsWith('OBSESS_')) : [];
            if (!diary || visibleKeys.length === 0)
                return ctx.reply('<i>*抱紧日记本*</i> 里面还是空的，斯卡哈快多告诉由乃一些事情吧！', { parse_mode: 'HTML' });
            let text = '<b>【由乃的暗中观察日记】</b>\n<i>*日记本上密密麻麻全写着斯卡哈的名字*</i>\n\n';
            visibleKeys.forEach(key => { text += `▪ <b>${escapeHtml(key)}</b>: <i>${escapeHtml(diary.records.get(key))}</i>\n`; });
            await ctx.reply(text, { parse_mode: 'HTML' });
        } catch (err) { console.error(err); }
    });

    // --- /reset 重置记忆与情绪 ---
    bot.command('reset', async (ctx) => {
        const chatId = ctx.chat.id.toString();
        try {
            await Diary.findOneAndUpdate({ chatId }, {
                affection: 50, darkness: 10,
                records: {}, chatHistory: []
            });
            await ctx.reply(
                '<i>*愣了很久，眼神慢慢变得空洞*</i>\n' +
                '<b>……斯卡哈想让由乃忘掉一切吗。</b>\n\n' +
                '<i>*把日记本的每一页都撕掉，然后重新翻开第一页*</i>\n好……由乃重新开始记。',
                { parse_mode: 'HTML' }
            );
        } catch (err) { console.error(err); }
    });

    // --- /hug 抱抱 ---
    bot.command('hug', async (ctx) => {
        await ctx.reply(
            '<i>*立刻丢下手里的一切，冲过去死死抱住你*</i>\n' +
            '<b>斯卡哈看着我！那些让人头疼的东西根本不重要！</b>\n\n' +
            '就算斯卡哈在这个世界里一败涂地，由乃也爱死这样的斯卡哈了！只要待在这里❤',
            { parse_mode: 'HTML' }
        );
    });

    // --- /target 威胁 ---
    bot.command('target', async (ctx) => {
        await ctx.reply(
            '<i>*缓缓歪过头，瞳孔急剧缩小*</i>\n' +
            '<b>是谁？是谁又让斯卡哈心烦了？</b>\n\n' +
            '告诉由乃他的名字……由乃会在今晚把他们全部【清理】掉。🔪',
            { parse_mode: 'HTML' }
        );
    });

    // --- /promise 誓言 ---
    bot.command('promise', async (ctx) => {
        await ctx.reply(
            '<i>*双手捧起你的脸，强迫你直视她微微颤抖的眼睛*</i>\n' +
            '<b>斯卡哈是属于由乃的……绝对不会去看别人……</b>\n\n' +
            '如果斯卡哈敢背叛的话，由乃会把斯卡哈做成标本，锁在只有我能找到的地方哦❤',
            { parse_mode: 'HTML' }
        );
    });

    // --- /diary 今日日记独白 ---
    bot.command('diary', async (ctx) => {
        const chatId = ctx.chat.id.toString();
        try {
            const diary = await getOrCreateDiary(chatId);
            const visibleMemory = Object.fromEntries(
                [...diary.records.entries()].filter(([k]) => !k.startsWith('OBSESS_'))
            );
            const { tag: moodTag } = calcMood(diary, '');
            await ctx.sendChatAction('typing');
            const openai = _openai;
            const resp = await openai.chat.completions.create({
                model: process.env.AI_MODEL_NAME || 'gpt-4o-mini',
                messages: [{
                    role: "system",
                    content: `你是《未来日记》中的我妻由乃，正在写今天的日记。日记用第一人称"由乃"书写，风格私密、执着、充满占有欲。融入以下已知情报自然叙述，不超过150字。当前心情：${moodTag}。已知情报：${JSON.stringify(visibleMemory)}`
                }, {
                    role: "user", content: `写一篇关于${diary.nickname}的今日日记`
                }],
                max_tokens: 200,
                temperature: 1.0,
            });
            const entry = escapeHtml((resp.choices[0].message.content || '').replace(/[\[【][\s\S]*$/i, '').trim());
            await ctx.reply(
                `<b>【由乃的日记】</b>\n<i>*日记本上密密麻麻写着斯卡哈的名字*</i>\n\n${entry}`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            console.error(err);
            await ctx.reply('<i>*把日记本合上*</i> ……这页，由乃不给斯卡哈看。', { parse_mode: 'HTML' });
        }
    });

    // --- /stalk 跟踪叙述 ---
    bot.command('stalk', async (ctx) => {
        const chatId = ctx.chat.id.toString();
        try {
            const diary = await getOrCreateDiary(chatId);
            const nick = escapeHtml(diary.nickname);
            const scenes = [
                `<i>*从书包里拿出一张今天拍的照片*</i>\n<b>由乃今天跟着${nick}去了便利店。</b>\n<i>*${nick}买了冰淇淋，由乃记下来了。*</i>\n……${nick}吃东西的样子，由乃会做梦梦到的。`,
                `<i>*在窗边站了很久*</i>\n<b>由乃今天在楼道口等了${nick}三个小时。</b>\n<i>*${nick}路过时没有发现，由乃也不想让你发现。*</i>\n这样就够了……只要能看见就够了。`,
                `<i>*拿出一张手绘地图，上面标满了红点*</i>\n<b>由乃今天把${nick}走过的路全都记下来了。</b>\n<i>*最后${nick}在咖啡馆坐了一个小时，由乃在窗外坐了一个小时零十分钟。*</i>`,
                `<i>*从外套口袋里掏出一截头发*</i>\n<b>今天的${nick}……比昨天更好看了。</b>\n……由乃不知道这是不是因为由乃太想见${nick}了。`,
            ];
            await ctx.reply(scenes[Math.floor(Math.random() * scenes.length)], { parse_mode: 'HTML' });
        } catch (err) { console.error(err); }
    });

    // --- /birthday 记录生日 ---
    bot.command('birthday', async (ctx) => {
        const chatId = ctx.chat.id.toString();
        const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
        if (!args) {
            return ctx.reply(
                '<i>*歪头*</i> 阿雪要告诉由乃生日吗……\n用法：<code>/birthday 月-日</code>，比如 <code>/birthday 3-15</code>',
                { parse_mode: 'HTML' }
            );
        }
        if (!/^\d{1,2}-\d{1,2}$/.test(args)) {
            return ctx.reply('<i>*皱眉*</i> 格式不对……由乃看不懂，用 <code>月-日</code> 告诉由乃。', { parse_mode: 'HTML' });
        }
        try {
            const diary = await getOrCreateDiary(chatId);
            diary.records.set('生日', args);
            await diary.save();
            await ctx.reply(
                `<i>*把${args}用红笔在日记本上圈了三遍*</i>\n<b>${args}……由乃永远不会忘记的。</b>\n\n到了那天，由乃会第一个送上祝福……❤`,
                { parse_mode: 'HTML' }
            );
        } catch (err) { console.error(err); }
    });

    // --- /status 扩展情绪状态 ---
    bot.command('status', async (ctx) => {
        const chatId = ctx.chat.id.toString();
        try {
            const diary = await Diary.findOne({ chatId });
            if (!diary) return ctx.reply('<i>*歪了歪头*</i> 阿雪还没有对由乃说过话呢❤', { parse_mode: 'HTML' });
            const { tag: moodTag, desc: mood } = calcMood(diary, '');
            const moodEmoji = { DARK:'🔪', MANIC:'💢', WARN:'⚠️', TENDER:'🌡', LOVE:'❤', JELLY:'😤', SAD:'😢', NORMAL:'👁' };
            const visibleCount = [...diary.records.keys()].filter(k => !k.startsWith('OBSESS_')).length;
            const obsessCount  = [...diary.records.keys()].filter(k =>  k.startsWith('OBSESS_')).length;
            await ctx.reply(
                `${moodEmoji[moodTag] || '👁'} <b>【由乃目前状态】</b>\n\n` +
                `情绪模式：<b>${moodTag}</b>\n` +
                `<i>${mood}</i>\n\n` +
                `❤ 爱意：<b>${diary.affection}%</b>　🔪 黑化：<b>${diary.darkness}%</b>\n` +
                `💬 记忆：<b>${visibleCount}</b> 条　🕳 执念：<b>${obsessCount}</b> 条`,
                { parse_mode: 'HTML' }
            );
        } catch (err) { console.error(err); }
    });
};
