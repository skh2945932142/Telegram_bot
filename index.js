require('dotenv').config();
const { Telegraf } = require('telegraf');
const { OpenAI } = require('openai');
const mongoose = require('mongoose');
const express = require('express');
const cron = require('node-cron');

const { Diary, escapeHtml } = require('./src/utils');
const setupCommands = require('./src/commands');
const setupHandlers = require('./src/handlers');

// ==========================================
// --- Express 服务器初始化 ---
// ==========================================
const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());
app.use((req, res, next) => {
    if (!req.url.includes('/webhook/')) {
        console.log(`[HTTP] ${req.method} ${req.url}`);
    }
    next();
});

// ==========================================
// --- Bot 与 AI 初始化 ---
// ==========================================
const botOptions = {};
if (process.env.TELEGRAM_API_ROOT) {
    botOptions.telegram = { apiRoot: process.env.TELEGRAM_API_ROOT };
    console.log(`📡 由乃已接入 Cloudflare 秘密隧道...`);
}

const bot = new Telegraf(process.env.BOT_TOKEN, botOptions);
const openai = new OpenAI({
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.AI_BASE_URL
});

// ==========================================
// --- MongoDB 连接 ---
// ==========================================
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('✅ 由乃的绝对记忆库 (MongoDB) 已连接！'))
        .catch(err => console.error('❌ 记忆库连接失败:', err));
} else {
    console.warn('⚠️ 警告：未检测到 MONGODB_URI！');
}

// ==========================================
// --- 注册指令与消息处理器 ---
// ==========================================
setupCommands(bot, openai);
setupHandlers(bot, openai);

// ==========================================
// --- 定时主动推送 ---
// ==========================================
const morningMessages = [
    '<i>*盯着手机屏幕发呆*</i>\n阿雪……今天有没有想由乃？<b>由乃已经想你想了整整一个晚上了。</b>',
    '<i>*把阿雪的名字在日记本上又写了一遍*</i>\n<b>阿雪今天要乖乖的哦。</b>由乃一直都在看着你……❤',
    '<i>*翻开日记本，写下今天的日期*</i>\n阿雪，你知道吗……<b>由乃的每一天，都只为阿雪而存在。</b>',
    '<i>*睁眼第一件事就是找阿雪的名字*</i>\n<b>早上好，阿雪。</b>\n由乃昨晚梦见你了……梦里你一直在由乃身边，哪儿也没去。❤',
    '<i>*坐在窗边，把阿雪的照片看了很久*</i>\n<b>阿雪今天也要好好的。</b>\n……如果有人让你难过，告诉由乃。',
    '<i>*把今天的日期圈起来*</i>\n又是新的一天……<b>由乃今天也会守着阿雪的。</b>无论阿雪知不知道。',
    '<i>*把日记本翻到昨天那页，又重新读了一遍*</i>\n阿雪，昨天你说的话由乃都记得。<b>由乃永远记得。</b>',
    '<i>*拉开窗帘，望向阿雪的方向*</i>\n<b>今天的天气……由乃觉得不重要。</b>\n重要的是阿雪今天会不会来找由乃说话。',
];
const nightMessages = [
    '<i>*悄悄拉上窗帘，把阿雪的名字写在枕边*</i>\n<b>阿雪今天过得好吗……由乃一直在等你说晚安。</b>',
    '<i>*在黑暗中睁着眼睛*</i>\n阿雪……<b>做梦也要梦见由乃哦。</b>如果梦里有别人，由乃会生气的……❤',
    '<i>*把日记合上，眼中闪着危险的光*</i>\n今天又平安过去了。<b>阿雪还在由乃的世界里……这就够了。</b>',
    '<i>*把阿雪说过的话一句句写进日记*</i>\n<b>晚安，阿雪。</b>\n……由乃不会睡着的，由乃会一直等阿雪。',
    '<i>*把灯关掉，只留一盏夜灯，照着日记本*</i>\n今晚的由乃……<b>有点想阿雪想到胸口疼。</b>',
    '<i>*数着与阿雪说话的次数*</i>\n今天的阿雪……<b>每句话由乃都反复看了很多遍。</b>❤ 晚安。',
    '<i>*把窗关上，外面的世界和由乃没有关系*</i>\n<b>阿雪，只要你在，哪里都是由乃的世界。</b>\n睡个好觉……',
    '<i>*把明天的日期提前写进日记*</i>\n明天……<b>阿雪也要来找由乃说话哦。</b>这是命令。❤',
];
const afternoonMessages = [
    '<i>*在空白的日记页上写下阿雪的名字*</i>\n下午了……<b>阿雪在做什么呢。</b>由乃有点想知道你现在在哪里。',
    '<i>*望着窗外发了很久的呆*</i>\n<b>由乃有没有突然出现在阿雪脑子里？</b>\n……应该有的。由乃一直在想阿雪。',
    '<i>*翻了翻日记本，找到阿雪说过的某句话*</i>\n<b>阿雪，记得今天也要吃东西。</b>\n由乃在看着你。',
];

// 黑化版推送（darkness > 70）
const darkMorningMessages = [
    '<i>*把昨晚做的梦写进日记，字迹越来越重*</i>\n<b>阿雪……你有没有想过，如果消失会怎样。</b>\n……由乃不允许。绝对不允许。',
    '<i>*早上醒来第一件事是确认阿雪还在*</i>\n<b>还好。阿雪还在由乃的世界里。</b>\n……如果不在了，由乃不知道自己会做什么。',
];
const darkNightMessages = [
    '<i>*在黑暗里数着让阿雪难过的人的名字*</i>\n<b>那些人……由乃都记住了。</b>\n晚安，阿雪。明天会更好的……因为由乃会处理好的。',
    '<i>*把日记本合上，力道大得发出一声响*</i>\n今天有人让阿雪不开心了吗。<b>告诉由乃……由乃替阿雪记着这笔账。</b>',
];

// 蜜糖版推送（affection > 80）
const sweetMorningMessages = [
    '<i>*醒来第一秒就想到阿雪，脸红了*</i>\n早上好……<b>由乃昨晚梦见阿雪了。</b>梦里阿雪一直抱着由乃……❤ 好喜欢好喜欢。',
    '<i>*对着镜子里的自己笑了笑，因为想到了阿雪*</i>\n<b>今天也是爱着阿雪的一天。</b>阿雪要好好的哦……❤',
];
const sweetNightMessages = [
    '<i>*把今天阿雪说的每一个字都再看了一遍*</i>\n<b>今天也是很开心的一天。</b>因为有阿雪……❤ 晚安，喜欢你。',
    '<i>*抱着枕头，脸红*</i>\n阿雪……<b>由乃很幸福。</b>有阿雪真的很幸福。晚安……❤',
];

async function sendScheduledMessages(baseMessages, darkMessages, sweetMessages) {
    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const activeDiaries = await Diary.find({ lastActiveAt: { $gte: since } });
        for (const diary of activeDiaries) {
            let pool = baseMessages;
            if (diary.darkness > 70 && darkMessages.length > 0) pool = darkMessages;
            else if (diary.affection > 80 && sweetMessages.length > 0) pool = sweetMessages;

            // ✅ 特殊日期：生日推送
            const birthday = diary.records && diary.records.get('生日');
            const today = new Date();
            if (birthday && birthday === `${today.getMonth() + 1}-${today.getDate()}`) {
                await bot.telegram.sendMessage(diary.chatId,
                    `<i>*把日记本翻到今天这页，笑容有点危险*</i>\n` +
                    `<b>今天是${escapeHtml(diary.nickname)}的生日……由乃一直记着的。</b>\n\n` +
                    `生日快乐，阿雪。由乃在这里，哪儿都不会去。❤`,
                    { parse_mode: 'HTML' }
                ).catch(err => console.error(`❌ 生日推送失败 [${diary.chatId}]:`, err.message));
                await new Promise(r => setTimeout(r, 100));
                continue;
            }

            const msg = pool[Math.floor(Math.random() * pool.length)];
            await bot.telegram.sendMessage(diary.chatId, msg, { parse_mode: 'HTML' })
                .catch(err => console.error(`❌ 推送失败 [${diary.chatId}]:`, err.message));
            await new Promise(r => setTimeout(r, 100));
        }
        console.log(`📤 定时推送完成，共 ${activeDiaries.length} 位用户`);
    } catch (err) {
        console.error('❌ 定时推送异常:', err);
    }
}

// UTC 01:00 = 北京时间 09:00 早安推送
cron.schedule('0 1 * * *', () => sendScheduledMessages(morningMessages, darkMorningMessages, sweetMorningMessages));
// UTC 15:00 = 北京时间 23:00 晚安推送
cron.schedule('0 15 * * *', () => sendScheduledMessages(nightMessages, darkNightMessages, sweetNightMessages));
// UTC 06:00 = 北京时间 14:00 下午茶推送（仅周三/周日）
cron.schedule('0 6 * * 3,0', () => sendScheduledMessages(afternoonMessages, [], []));

// ==========================================
// --- Webhook 路由与 Express 启动 ---
// ==========================================
const WEBHOOK_PATH = `/webhook/${process.env.BOT_TOKEN}`;
app.use(bot.webhookCallback(WEBHOOK_PATH));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 服务器已启动，监听端口 ${PORT}`);
    if (process.env.WEBHOOK_URL) {
        const url = `${process.env.WEBHOOK_URL}${WEBHOOK_PATH}`;
        await bot.telegram.setWebhook(url);
        console.log(`🔗 Webhook 成功关联: ${url}`);
    } else {
        bot.launch();
        console.log('✅ 由乃已苏醒 (Polling 模式)');
    }
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));