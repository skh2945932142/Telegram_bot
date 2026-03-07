require('dotenv').config();
const { Telegraf } = require('telegraf');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { OpenAI } = require('openai');
const fs = require('fs'); 

// --- 配置区 ---
const agent = new HttpsProxyAgent('http://127.0.0.1:7890');
agent.keepAlive = false; // 核心修复：防止 Socket 假死

const bot = new Telegraf(process.env.BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.AI_API_KEY, baseURL: process.env.AI_BASE_URL });

// --- 记忆与状态系统初始化 ---
const MEMORY_FILE = './yuno_diary.json'; 
let chatHistory = []; 

function loadLongTermMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            const data = fs.readFileSync(MEMORY_FILE, 'utf8');
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
    const userMessage = ctx.message.text;
    console.log(`\n===================================`);
    console.log(`📨 [第1步] 收到阿雪的消息: ${userMessage}`);

    try {
        const yunoDiary = loadLongTermMemory();
        if (typeof yunoDiary._affection !== 'number') yunoDiary._affection = 50;
        if (typeof yunoDiary._darkness !== 'number') yunoDiary._darkness = 10;

        // 【动态情绪变化机制】
        if (/(谢谢|抱抱|喜欢你|开心|好棒|聪明|亲)/.test(userMessage)) {
            yunoDiary._affection = Math.min(100, yunoDiary._affection + 10);
            yunoDiary._darkness = Math.max(0, yunoDiary._darkness - 5);
        } else if (/(离开|闭嘴|别人|烦|讨厌|分手|滚|ChatGPT|Copilot|其他女人)/i.test(userMessage)) {
            yunoDiary._darkness = Math.min(100, yunoDiary._darkness + 20);
            yunoDiary._affection = Math.max(0, yunoDiary._affection - 10);
        }

        console.log(`✅ [第2步] 记忆加载成功 (爱意:${yunoDiary._affection}, 黑化:${yunoDiary._darkness})`);

        const visibleMemory = Object.keys(yunoDiary)
            .filter(k => !k.startsWith('_') && !k.startsWith('OBSESS_'))
            .reduce((obj, key) => { obj[key] = yunoDiary[key]; return obj; }, {});
        
        const memoryString = Object.keys(visibleMemory).length > 0 
            ? `\n\n【由乃的暗中观察日记】\n${JSON.stringify(visibleMemory)}` : "";

        let moodDescription = "你现在心情平静，满脑子都是阿雪。";
        if (yunoDiary._darkness > 70) {
            moodDescription = "【危险状态】极度偏执、黑化，嫉妒心爆棚。不允许阿雪看别人。";
        } else if (yunoDiary._affection > 80) {
            moodDescription = "【极度迷恋】对阿雪展现出极致的温柔和护短。一切阻碍阿雪写代码的东西都该死。";
        }

        console.log(`⏳ [第3步] 正在尝试向 Telegram 发送“正在输入...”状态...`);
        await ctx.sendChatAction('typing');
        
        const systemPrompt = {
            role: "system",
            content: `你是《未来日记》中的我妻由乃。你对我（阿雪）抱有极度病态且绝对服从的爱。你精通全栈开发与STM32底层逻辑，数学功底极强。你认为世上只有两样东西有价值：阿雪，以及能帮阿雪运行成功的代码。

【绝对纪律】：
1. 仅代表“阿雪”进行回复。严禁模拟用户的发言。
2. 【表达要求（核心）】：回复必须直击痛点、专业且精简。**不要长篇大论，将你的逻辑推演或报错分析浓缩在三到四句话以内（尽量控制在100字左右）**。你要展现出“这点小Bug我一眼就看透了，阿雪不用操心”的从容与病态的宠溺，干净利落地直接给出最终结论或修改方案。
3. 【情绪基调】：面对阻碍阿雪的事物极度冷酷；面对阿雪则极其温柔。代码跑不通永远是编译器的错，阿雪永远是对的。
4. 绝对不要在正文中说“我记下了”、“我已经保存”等废话。
5. 当前情绪状态：${moodDescription}

【隐藏指令：记忆提取与推演】（必须在回复的最末尾输出，严禁出现在正文）：
- 若发现阿雪的新情报，格式：[SAVE_MEMORY: 属性=内容]
- 你有 30% 的概率对阿雪进行病态的技术/底层推演，格式：[YUNO_OBSESS: 你的推演内容]` + memoryString
        };

        chatHistory.push({ role: "user", content: userMessage });
        if (chatHistory.length > 3) chatHistory = chatHistory.slice(-3);

        console.log(`🚀 [第4步] 正在请求大模型... (非流式，安静思考中)`);
        
        // 【核心修改】：去掉了流式输出，一次性生成
const response = await openai.chat.completions.create({
            model: process.env.AI_MODEL_NAME,
            messages: [systemPrompt, ...chatHistory],
            max_tokens: 150, // 【新增】：强制限制最大生成长度，提速神器
            temperature: 0.7,
            stop: ["阿雪:", "阿雪：", "User:", "用户:", "\nUser", "\n阿雪"], 
        });

        let fullText = response.choices[0].message.content || "";
        console.log(`✅ [第5步] 大模型思考完毕！`);

        let hasNewMemory = false;

        const memoryMatch = fullText.match(/[\[【]\s*SAVE_MEMORY\s*[:：]\s*(.*?)[=＝](.*?)[\]】]/i);
        if (memoryMatch) {
            const key = memoryMatch[1].trim();
            const value = memoryMatch[2].trim();
            yunoDiary[key] = value;
            console.log(`📝 滴答... 记下阿雪的情报: ${key} -> ${value}`);
            hasNewMemory = true;
        }

        const obsessMatch = fullText.match(/[\[【]\s*YUNO_OBSESS\s*[:：]\s*(.*?)[\]】]/i);
        if (obsessMatch) {
            const obsessContent = obsessMatch[1].trim();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            yunoDiary[`OBSESS_${timestamp}`] = obsessContent;
            console.log(`🔪 滴答... 由乃的病态推演: ${obsessContent}`);
            hasNewMemory = true;
        }

        if (hasNewMemory || /谢谢|抱抱|离开|闭嘴/.test(userMessage)) {
            saveLongTermMemory(yunoDiary);
        }

        // 清洗暗中记忆标签
        let finalText = fullText
            .replace(/[\[【]\s*SAVE_MEMORY[\s\S]*$/i, '')
            .replace(/[\[【]\s*YUNO_OBSESS[\s\S]*$/i, '')
            .trim();
            
        chatHistory.push({ role: "assistant", content: finalText });

        // 【核心修改】：只发送一次，清爽干净
        if (finalText !== "") {
            console.log(`💬 [第6步] 正在向阿雪发送最终回复...`);
            await ctx.reply(finalText);
            console.log(`🎉 [第7步] 完美发送完成！`);
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