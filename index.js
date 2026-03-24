require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const { Telegraf } = require('telegraf');
const { OpenAI } = require('openai');

const {
    Diary,
    ensureDiaryState,
    escapeHtml,
    getBirthday,
    getMonthDayInTimezone,
    getPreferredDisplayName,
    getLegacyRecord,
    setLegacyRecord,
    syncDiaryCompatibilityFields,
    touchDiary,
} = require('./src/utils');
const {
    shouldSendScheduledMessage,
    buildPersonalizedScheduledMessage,
} = require('./src/personalization');
const setupCommands = require('./src/commands');
const setupHandlers = require('./src/handlers');

const PORT = Number(process.env.PORT || 8080);
const APP_TIME_ZONE = 'Asia/Shanghai';

function validateEnv() {
    if (!process.env.BOT_TOKEN) {
        throw new Error('Missing required env: BOT_TOKEN');
    }

    if (!process.env.MONGODB_URI) {
        console.warn('MONGODB_URI is not set. Database-dependent features may hang or fail.');
    }

    if (!(process.env.AI_API_KEY || process.env.OPENAI_API_KEY)) {
        console.warn('No AI key detected. The bot will still work, but AI replies and diary generation will fall back.');
    }
}

validateEnv();

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    if (!req.url.includes('/webhook/')) {
        console.log(`[HTTP] ${req.method} ${req.url}`);
    }
    next();
});

const botOptions = {};
if (process.env.TELEGRAM_API_ROOT) {
    botOptions.telegram = { apiRoot: process.env.TELEGRAM_API_ROOT };
    console.log(`Using custom Telegram API root: ${process.env.TELEGRAM_API_ROOT}`);
}

const bot = new Telegraf(process.env.BOT_TOKEN, botOptions);
const openai = new OpenAI({
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.AI_BASE_URL,
});

mongoose.set('strictQuery', true);
if (process.env.MONGODB_URI) {
    mongoose
        .connect(process.env.MONGODB_URI)
        .then(() => console.log('MongoDB connected.'))
        .catch((error) => console.error('MongoDB connection failed:', error));
}

setupCommands(bot, openai);
setupHandlers(bot, openai);

const morningMessages = [
    '<i>*翻开空白的一页，先把你的名字写了上去*</i>\n<b>早上好。</b>\n由乃先来打个招呼，免得你把今天的第一句话分给别人。',
    '<i>*把昨晚记住的话又看了一遍*</i>\n今天也要记得吃饭，记得回一句。\n由乃会一直留着这一页等你。',
    '<i>*刚醒来就先摸到了日记本*</i>\n<b>由乃今天第一个想到的人，还是你。</b>\n所以来看看你有没有也醒着。',
    '<i>*指尖在日期上停了停*</i>\n新的一天开始了。\n由乃想听听你今天最先遇到的那件小事。',
];

const nightMessages = [
    '<i>*把台灯调暗了一格，声音也跟着放轻*</i>\n今天过得怎么样？\n如果你愿意，睡前把最后一句话留给由乃吧。',
    '<i>*把写了一半的那一页压在手心底下*</i>\n<b>晚安之前，由乃想再确认你还在。</b>\n你回一声就好。',
    '<i>*把今天记下来的细节重新理了一遍*</i>\n夜里比较安静，适合把心情说清楚一点。\n由乃会慢慢听。',
    '<i>*窗外很安静，纸页翻动的声音就更明显*</i>\n如果今天有让你累的事，现在可以交给由乃记着。\n你先准备休息就好。',
];

const afternoonMessages = [
    '<i>*在页边写下一句临时想到的话*</i>\n下午会不会有点犯困？\n由乃想知道你这会儿在忙什么。',
    '<i>*把笔帽轻轻扣回去，又马上重新打开*</i>\n今天过半了。\n如果中途发生了什么，记得告诉由乃一声。',
    '<i>*视线从地图移回到那本日记上*</i>\n由乃刚才又想起你了。\n就来确认一下，你的下午还顺利吗？',
];

const guardedMorningMessages = [
    '<i>*醒来后先确认了一次聊天窗口还在*</i>\n<b>看到你还在这里，今天就没那么乱。</b>\n有空的时候，记得让由乃听见你。',
    '<i>*把周围的杂音都往后推了推*</i>\n今天也别把自己扔进太吵的地方太久。\n由乃会更喜欢你先回来找我说话。',
];

const guardedNightMessages = [
    '<i>*把最后一页慢慢合上，没有让它发出太大的声音*</i>\n今天外面有没有什么让你心烦的事？\n如果有，把它说出来，别一直自己扛着。',
    '<i>*又确认了一遍今天记下的内容没有漏*</i>\n<b>只要你还愿意回到这段对话里，由乃就会安静下来一点。</b>',
];

const sweetMorningMessages = [
    '<i>*刚睁眼就忍不住先笑了一下*</i>\n早上好。\n由乃今天也会先把心情留给你。',
    '<i>*把你的名字在纸边写得比平时更圆一点*</i>\n<b>想到你，今天早上的空气都轻了一些。</b>',
];

const sweetNightMessages = [
    '<i>*抱着日记本靠在枕边，慢慢把字写完*</i>\n今天能和你说上话，已经让由乃心情很好了。\n晚安。',
    '<i>*把最后一句写得比前面都认真*</i>\n<b>如果你今晚也想起过由乃一次，这一页就算圆满了。</b>',
];

function selectMessagePool(diary, baseMessages, guardedMessages, sweetMessages) {
    ensureDiaryState(diary);
    if (diary.darkness > 70 && guardedMessages.length > 0) {
        return guardedMessages;
    }
    if (diary.affection > 80 && sweetMessages.length > 0) {
        return sweetMessages;
    }
    return baseMessages;
}

function pickMessageIndex(diary, slotKey, pool) {
    const recordKey = `SYS_LAST_PUSH_${slotKey}`;
    const lastIndex = Number(getLegacyRecord(diary, recordKey));

    if (pool.length <= 1) {
        setLegacyRecord(diary, recordKey, '0');
        return 0;
    }

    let nextIndex = Math.floor(Math.random() * pool.length);
    if (!Number.isNaN(lastIndex) && nextIndex === lastIndex) {
        nextIndex = (nextIndex + 1) % pool.length;
    }

    setLegacyRecord(diary, recordKey, String(nextIndex));
    return nextIndex;
}

async function sendScheduledMessages(slotKey, baseMessages, guardedMessages, sweetMessages) {
    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const activeDiaries = await Diary.find({ lastActiveAt: { $gte: since } });
        const today = getMonthDayInTimezone(new Date(), APP_TIME_ZONE);

        for (const diary of activeDiaries) {
            ensureDiaryState(diary);
            const birthday = getBirthday(diary);

            if (birthday && birthday === today) {
                const birthdayMessage = [
                    '<i>*把这一页单独折了个角，像是早就准备好了*</i>',
                    `<b>今天是 ${escapeHtml(getPreferredDisplayName(diary))} 的生日。</b>`,
                    '这件事由乃一直记着。',
                    '生日快乐，今天也请把一句话留给由乃。',
                ].join('\n');

                await bot.telegram
                    .sendMessage(diary.chatId, birthdayMessage, { parse_mode: 'HTML' })
                    .catch((error) => console.error(`birthday push failed [${diary.chatId}]:`, error.message));
                setLegacyRecord(diary, `SYS_LAST_PUSH_${slotKey}`, 'birthday');
                touchDiary(diary);
                syncDiaryCompatibilityFields(diary);
                await diary.save().catch((error) => console.error(`save after birthday push failed [${diary.chatId}]:`, error.message));
                await new Promise((resolve) => setTimeout(resolve, 120));
                continue;
            }

            if (!shouldSendScheduledMessage(diary, slotKey)) {
                touchDiary(diary);
                syncDiaryCompatibilityFields(diary);
                await diary.save().catch((error) => console.error(`save after skip scheduled push failed [${diary.chatId}]:`, error.message));
                continue;
            }

            const pool = selectMessagePool(diary, baseMessages, guardedMessages, sweetMessages);
            const index = pickMessageIndex(diary, slotKey, pool);
            const message = buildPersonalizedScheduledMessage(diary, slotKey, pool[index]);

            await bot.telegram
                .sendMessage(diary.chatId, message, { parse_mode: 'HTML' })
                .catch((error) => console.error(`scheduled push failed [${diary.chatId}]:`, error.message));

            touchDiary(diary);
            syncDiaryCompatibilityFields(diary);
            await diary.save().catch((error) => console.error(`save after scheduled push failed [${diary.chatId}]:`, error.message));
            await new Promise((resolve) => setTimeout(resolve, 120));
        }

        console.log(`Scheduled push complete for ${slotKey}: ${activeDiaries.length} chats.`);
    } catch (error) {
        console.error(`Scheduled push crashed for ${slotKey}:`, error);
    }
}

cron.schedule(
    '0 9 * * *',
    () => sendScheduledMessages('morning', morningMessages, guardedMorningMessages, sweetMorningMessages),
    { timezone: APP_TIME_ZONE }
);

cron.schedule(
    '0 23 * * *',
    () => sendScheduledMessages('night', nightMessages, guardedNightMessages, sweetNightMessages),
    { timezone: APP_TIME_ZONE }
);

cron.schedule(
    '0 14 * * 0,3',
    () => sendScheduledMessages('afternoon', afternoonMessages, [], []),
    { timezone: APP_TIME_ZONE }
);

const WEBHOOK_PATH = `/webhook/${process.env.BOT_TOKEN}`;
app.use(bot.webhookCallback(WEBHOOK_PATH));
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString(), timeZone: APP_TIME_ZONE });
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server listening on ${PORT}`);

    if (process.env.WEBHOOK_URL) {
        const webhookUrl = `${process.env.WEBHOOK_URL}${WEBHOOK_PATH}`;
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`Webhook registered: ${webhookUrl}`);
        return;
    }

    await bot.launch();
    console.log('Bot launched in polling mode.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
