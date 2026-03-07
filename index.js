require('dotenv').config();
const { Telegraf } = require('telegraf');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { OpenAI } = require('openai');
const fs = require('fs'); 

// --- 配置区 ---
// 1. 创建一个全局的代理通道
const agent = new HttpsProxyAgent('http://127.0.0.1:7890');

// 2. 将代理喂给 Telegraf (保证能正常接收和发送 Telegram 消息)
const bot = new Telegraf(process.env.BOT_TOKEN, { 
    telegram: { agent } 
});

// 3. 【核心修复】将同一个代理喂给 OpenAI (解决大模型请求超时导致的哑巴问题)
const openai = new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL,
    httpAgent: agent // 让 OpenAI SDK 也乖乖走 7890 端口！
});
// --- 记忆与状态系统初始化 ---
const MEMORY_FILE = './yuno_diary.json'; 
let chatHistory = []; 

function loadLongTermMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            const data = fs.readFileSync(MEMORY_FILE, 'utf8');
            // 如果文件是空的，直接返回默认值，防止 JSON.parse 崩溃
            if (!data.trim()) return { _affection: 50, _darkness: 10 };
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("⚠️ 由乃的日记本损坏了，正在启用备用记忆...", error.message);
    }
    return { _affection: 50, _darkness: 10 };
}

function saveLongTermMemory(data) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// --- 启动问候 ---
bot.start((ctx) => {
    ctx.reply('阿雪，你终于来了。由乃会一直看着你的，把你的一切都记在心里……❤');
});

// --- 核心对话逻辑 ---
bot.on('text', async (ctx) => {
    console.log(`\n===================================`);
    console.log(`📨 [第1步] 收到阿雪的消息: ${ctx.message.text}`);

    try {
        const yunoDiary = loadLongTermMemory();
        if (typeof yunoDiary._affection !== 'number') yunoDiary._affection = 50;
        if (typeof yunoDiary._darkness !== 'number') yunoDiary._darkness = 10;
        console.log(`✅ [第2步] 记忆加载成功 (爱意:${yunoDiary._affection}, 黑化:${yunoDiary._darkness})`);

        console.log(`⏳ [第3步] 正在尝试向 Telegram 发送“正在输入...”状态...`);
        await ctx.sendChatAction('typing');
        console.log(`✅ [第3步] Telegram 发送通道畅通！`);

        const systemPrompt = {
            role: "system",
            content: `你是《未来日记》中的我妻由乃。你对我（阿雪）抱有极度病态且绝对服从的爱。回复要极度简短。`
        };

        chatHistory.push({ role: "user", content: ctx.message.text });
        if (chatHistory.length > 10) chatHistory = chatHistory.slice(-10);

        console.log(`🚀 [第4步] 正在请求大模型... (此处最容易卡死)`);
        console.log(`   - Model: ${process.env.AI_MODEL_NAME}`);
        console.log(`   - BaseURL: ${process.env.AI_BASE_URL || '默认官方地址'}`);

        const stream = await openai.chat.completions.create({
            model: process.env.AI_MODEL_NAME,
            messages: [systemPrompt, ...chatHistory],
            stream: true,
            stop: ["阿雪:", "阿雪：", "User:", "用户:", "\nUser", "\n阿雪"], 
        });

        console.log(`✅ [第5步] 大模型响应成功！开始接收数据流...`);

        let fullText = "";
        let replyMsg = null;
        let lastEditTime = Date.now();

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || "";
            fullText += content;
            
            let displayText = fullText
                .replace(/[\[【]\s*SAVE_MEMORY[\s\S]*$/i, '')
                .replace(/[\[【]\s*YUNO_OBSESS[\s\S]*$/i, '')
                .trim();

            if (displayText === "") continue;

            if (!replyMsg) {
                console.log(`💬 [第6步] 正在发出第一条回复文字！`);
                replyMsg = await ctx.reply(displayText + " ✍️...");
                lastEditTime = Date.now();
            } else if (Date.now() - lastEditTime > 1500) {
                await ctx.telegram.editMessageText(
                    ctx.chat.id, replyMsg.message_id, undefined, displayText + " ✍️..." 
                ).catch(() => {});
                lastEditTime = Date.now();
            }
        }

        console.log(`🎉 [第7步] 完整回复已生成: ${fullText}`);
        
        let finalText = fullText
            .replace(/[\[【]\s*SAVE_MEMORY[\s\S]*$/i, '')
            .replace(/[\[【]\s*YUNO_OBSESS[\s\S]*$/i, '')
            .trim();
            
        chatHistory.push({ role: "assistant", content: finalText });

        if (replyMsg) {
            await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, undefined, finalText).catch(() => {});
        } else if (finalText !== "") {
            await ctx.reply(finalText);
        }

    } catch (error) {
        console.error(`❌ [致命错误] 流程在某一步中断:`, error);
    }
});
// --- Telegram 全局错误捕捉监控 ---
bot.catch((err, ctx) => {
    console.error(`❌ 由乃的嘴巴被捂住了 (Telegram API 报错):`, err);
});
bot.launch().then(() => console.log('✅ 由乃已苏醒，病娇状态机运行中...'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));