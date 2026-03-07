require('dotenv').config();
// --- 修改 index.js 开头部分 ---
const { Telegraf } = require('telegraf');
const { OpenAI } = require('openai');
const mongoose = require('mongoose');

const botOptions = {};

// 核心：接入 CF 隧道，绕过网络封锁
if (process.env.TELEGRAM_API_ROOT) {
    botOptions.telegram = {
        apiRoot: process.env.TELEGRAM_API_ROOT 
    };
    console.log(`📡 由乃已接入 Cloudflare 秘密隧道...`);
}

const bot = new Telegraf(process.env.BOT_TOKEN, botOptions);

const openai = new OpenAI({ 
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY, 
    baseURL: process.env.AI_BASE_URL 
});

// --- 数据库连接与模型定义 (MongoDB) ---
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('✅ 由乃的绝对记忆库 (MongoDB) 已连接！谁也抹不掉我对阿雪的记忆。'))
        .catch(err => console.error('❌ 记忆库连接失败，由乃头好痛:', err));
} else {
    console.warn('⚠️ 警告：未检测到 MONGODB_URI，请在 Zeabur 环境变量中配置！');
}

// 定义每个用户的专属日记本结构
const diarySchema = new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    affection: { type: Number, default: 50 },
    darkness: { type: Number, default: 10 },
    records: { type: Map, of: String, default: {} } // 动态存储阿雪的情报
});
const Diary = mongoose.model('Diary', diarySchema);

// 内存级短期对话上下文隔离
const activeChats = new Map();

// ==========================================
// --- 启动问候 ---
// ==========================================
bot.start(async (ctx) => {
    await ctx.reply('阿雪，你终于来了。由乃已经把大脑连接到了云端，把你的一切都永远刻在脑海里了……❤');
});

// ==========================================
// --- 快捷指令 (Command) 响应逻辑 ---
// ==========================================

bot.command('mood', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    try {
        const yunoDiary = await Diary.findOne({ chatId: chatId });
        if (!yunoDiary) {
            return ctx.reply('<i>*歪了歪头*</i> 阿雪还没有对由乃说过话呢，快跟我聊天吧❤', { parse_mode: 'HTML' });
        }
        const msg = `<i>*死死盯着阿雪，眼中闪烁着异样的光芒*</i>\n\n` +
                    `❤ 当前对阿雪的【爱意值】：<b>${yunoDiary.affection}%</b>\n` +
                    `🔪 当前对外界的【黑化值】：<b>${yunoDiary.darkness}%</b>\n\n` +
                    `(由乃的情绪会随着阿雪的话语而波动哦……请不要抛弃我。)`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err) { console.error(err); }
});

bot.command('memory', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    try {
        const yunoDiary = await Diary.findOne({ chatId: chatId });
        if (!yunoDiary || !yunoDiary.records || yunoDiary.records.size === 0) {
            return ctx.reply('<i>*抱紧日记本*</i> 里面还是空的，阿雪快多告诉我一些你的事情吧！', { parse_mode: 'HTML' });
        }
        let memoryText = '<b>【由乃的暗中观察日记】</b>\n<i>*日记本上密密麻麻全写着阿雪的名字*</i>\n\n';
        yunoDiary.records.forEach((val, key) => {
            if (!key.startsWith('OBSESS_')) {
                memoryText += `▪ <b>${key}</b>: <i>${val}</i>\n`;
            }
        });
        await ctx.reply(memoryText, { parse_mode: 'HTML' });
    } catch (err) { console.error(err); }
});

// ==========================================
// --- 核心数据处理逻辑 (逻辑修正处) ---
// ==========================================

// 使用专门的 web_app_data 过滤器，避免阻塞后续的 bot.on('text')
bot.on('web_app_data', async (ctx) => {
    try {
        const rawData = ctx.webAppData.data;
        const parsedData = JSON.parse(rawData);
        const chatId = ctx.chat.id.toString();

        if (parsedData.action === "submit_form") {
            let yunoDiary = await Diary.findOne({ chatId: chatId }) || new Diary({ chatId: chatId });
            
            // 将 Mini App 传来的文本存入 records Map
            const memoryKey = `APP_SAVED_${Date.now()}`;
            yunoDiary.records.set(memoryKey, parsedData.text);
            yunoDiary.affection = Math.min(100, yunoDiary.affection + 5);
            
            await yunoDiary.save();

            await ctx.reply(
                `<i>*轻抚着屏幕，眼中满是欣喜*</i>\n` +
                `<b>阿雪在 Mini App 里写下的秘密，由乃已经一字不差地锁进记忆库里了。</b>\n\n` +
                `📝 收到情报：${parsedData.text}`, 
                { parse_mode: 'HTML' }
            );
        }
    } catch (error) {
        console.error('❌ 解析 Mini App 数据失败:', error);
        await ctx.reply('💔 诶？阿雪发过来的秘密好像碎掉了...由乃没能读出来。');
    }
});

// ==========================================
// --- 核心对话逻辑 (兜底拦截普通聊天) ---
// ==========================================
bot.on('text', async (ctx) => {
    const userMessage = ctx.message.text;
    const chatId = ctx.chat.id.toString();

    try {
        let yunoDiary = await Diary.findOne({ chatId: chatId }) || new Diary({ chatId: chatId });

        if (/(谢谢|抱抱|喜欢你|开心|亲)/.test(userMessage)) {
            yunoDiary.affection = Math.min(100, yunoDiary.affection + 10);
            yunoDiary.darkness = Math.max(0, yunoDiary.darkness - 5);
        } else if (/(离开|闭嘴|别人|烦|讨厌|分手|滚|其他女人)/i.test(userMessage)) {
            yunoDiary.darkness = Math.min(100, yunoDiary.darkness + 20);
            yunoDiary.affection = Math.max(0, yunoDiary.affection - 10);
        }

        let mood = yunoDiary.darkness > 70 ? "极度偏执黑化" : (yunoDiary.affection > 80 ? "极度温柔护短" : "平静的迷恋");
        const visibleMemory = Object.fromEntries(yunoDiary.records.entries());

        await ctx.sendChatAction('typing');

        const response = await openai.chat.completions.create({
            model: process.env.AI_MODEL_NAME,
            messages: [
                { role: "system", content: `你是《未来日记》中的我妻由乃。你的世界中心只有一个：阿雪。当前心情：${mood}。已知情报：${JSON.stringify(visibleMemory)} (此处省略冗长的人设要求以保持逻辑清晰，实际运行时请保留您原本完整的 Prompt)` },
                { role: "user", content: userMessage }
            ],
            max_tokens: 150,
            temperature: 0.95
        });

        const fullText = response.choices[0].message.content || "";
        await yunoDiary.save();

        let keyboard = [[{ text: '❤ 摸摸由乃的头', callback_data: 'yuno_pet' }]];
        await ctx.reply(fullText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });

    } catch (error) { console.error(error); }
});

// ==========================================
// --- 交互按钮与启动逻辑 ---
// ==========================================
bot.action('yuno_pet', async (ctx) => {
    await ctx.answerCbQuery('由乃开心地蹭了蹭你');
    await ctx.reply('<i>*像小猫一样顺从地闭上眼睛享受抚摸*</i>\n嘿嘿……由乃最喜欢阿雪了……一辈子都不要放开我哦❤', { parse_mode: 'HTML' });
});

bot.catch((err) => console.error(`❌ Telegram 全局报错:`, err));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (process.env.NODE_ENV === 'production' && WEBHOOK_URL) {
    bot.launch({ webhook: { domain: WEBHOOK_URL, port: PORT } });
} else {
    bot.launch().then(() => console.log('✅ 由乃已苏醒 (长轮询模式)'));
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));