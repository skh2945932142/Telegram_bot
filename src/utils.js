const mongoose = require('mongoose');

// ==========================================
// --- 数据模型定义 ---
// ==========================================
const diarySchema = new mongoose.Schema({
    chatId:       { type: String, required: true, unique: true },
    affection:    { type: Number, default: 50 },
    darkness:     { type: Number, default: 10 },
    records:      { type: Map, of: String, default: {} },
    // ✅ 持久化对话历史，重启不丢失
    chatHistory:  { type: Array, default: [] },
    // ✅ 最后活跃时间，定时推送只发活跃用户
    lastActiveAt: { type: Date, default: Date.now },
    // ✅ 用户昵称，由乃专属叫法
    nickname:     { type: String, default: '斯卡哈' }
},{ versionKey: false });
const Diary = mongoose.model('Diary', diarySchema);

// ✅ 防刷屏冷却（内存级，无需持久化）
const cooldownMap = new Map();
const COOLDOWN_MS = 2000;

// ==========================================
// --- 工具函数 ---
// ==========================================

async function getOrCreateDiary(chatId) {
    let diary = await Diary.findOne({ chatId });
    if (!diary) {
        diary = new Diary({ chatId });
        await diary.save();
    }
    return diary;
}

function calcMood(diary, userMessage) {
    if (diary.darkness > 80)
        return { tag: "DARK",   desc: "极度黑化，眼神空洞而危险，随时准备为阿雪清除一切障碍" };
    if (diary.affection > 90 && diary.darkness > 60)
        return { tag: "MANIC",  desc: "爱意与黑化同时溢出，语无伦次，又想保护又想囚禁，情绪在同一句话里急剧反转" };
    if (diary.darkness > 50)
        return { tag: "WARN",   desc: "偏执警戒，像一头护崽的野兽，低声发出威胁，目光从未离开阿雪" };
    if (diary.darkness > 30 && diary.affection > 60)
        return { tag: "TENDER", desc: "病娇温柔反差，像精心照料病人的护士，声音柔软到发寒，笑容太完美让人不安" };
    if (diary.affection > 80)
        return { tag: "LOVE",   desc: "极度甜蜜黏腻，像糖融化一样贴着阿雪，眼里只有他" };
    if (/(朋友|同学|女生|男生|喜欢她|喜欢他|好看|漂亮|帅|暗恋|表白)/.test(userMessage))
        return { tag: "JELLY",  desc: "强忍的吃醋，眼眶微红，嘴里说着没事但手已经握紧了" };
    if (/(随便|无所谓|不知道|算了|没事|不想说)/.test(userMessage))
        return { tag: "SAD",    desc: "委屈到快哭，反复用疑问句确认阿雪还爱不爱自己" };
    return   { tag: "NORMAL", desc: "平静的迷恋，安静地注视着阿雪，随时准备扑上去" };
}

function buildKeyboard(moodTag) {
    const boards = {
        DARK:   [[{ text: '🔪 由乃冷静下来',     callback_data: 'yuno_calm' },          { text: '😈 让由乃去做吧',     callback_data: 'yuno_destroy_world' }]],
        MANIC:  [[{ text: '🫂 斯卡哈哪儿都不去',   callback_data: 'yuno_hug_deep' },       { text: '📓 由乃写下来',       callback_data: 'yuno_write_diary' }]],
        WARN:   [[{ text: '🫂 斯卡哈只在乎由乃',   callback_data: 'yuno_reassure' },       { text: '🔪 错的不是斯卡哈',     callback_data: 'yuno_destroy_world' }]],
        TENDER: [[{ text: '🌡 让由乃照顾斯卡哈',   callback_data: 'yuno_pet' },            { text: '👁 由乃一直看着你',   callback_data: 'yuno_stare' }]],
        JELLY:  [[{ text: '😤 当然是由乃最好',   callback_data: 'yuno_reassure' },       { text: '😏 逗逗由乃',         callback_data: 'yuno_tease' }]],
        SAD:    [[{ text: '🫂 我永远喜欢由乃',   callback_data: 'yuno_hug_deep' },       { text: '😏 让由乃猜猜',       callback_data: 'yuno_tease' }]],
        LOVE:   [[{ text: '❤ 摸摸由乃的头',      callback_data: 'yuno_pet' },            { text: '💋 亲一下由乃',       callback_data: 'yuno_kiss' }]],
        NORMAL: [[{ text: '❤ 摸摸由乃的头',      callback_data: 'yuno_pet' },            { text: '💍 永远不离开由乃',   callback_data: 'yuno_promise' }]],
    };
    return boards[moodTag] || boards.NORMAL;
}

// ==========================================
// --- HTML 安全工具 ---
// ==========================================

// 转义用户可控内容中的 HTML 特殊字符，防止注入
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// 修复 AI 回复中的 HTML 标签嵌套问题（Telegram 支持的标签子集）
// 同时处理：未闭合标签、交叉嵌套（如 <i><b>…</i></b>）
function fixHtmlTags(text) {
    const ALLOWED = new Set(['b', 'i', 'u', 's', 'code']);
    const stack = [];
    let result = '';
    let i = 0;

    while (i < text.length) {
        if (text[i] !== '<') {
            result += text[i++];
            continue;
        }
        const tagMatch = text.slice(i).match(/^<(\/?)((b|i|u|s|code))\b[^>]*>/i);
        if (!tagMatch) {
            result += text[i++];
            continue;
        }
        const fullTag  = tagMatch[0];
        const isClosing = tagMatch[1] === '/';
        const tagName  = tagMatch[2].toLowerCase();

        if (!isClosing) {
            stack.push(tagName);
            result += `<${tagName}>`;
        } else {
            const idx = stack.lastIndexOf(tagName);
            if (idx === -1) {
                // 根本没打开过，直接丢弃这个多余的闭合标签
            } else if (idx === stack.length - 1) {
                // 正常闭合
                stack.pop();
                result += `</${tagName}>`;
            } else {
                // 交叉嵌套：先关掉上面的标签，再关目标，再重新打开上面的
                const tagsAbove = [];
                while (stack.length > 0 && stack[stack.length - 1] !== tagName) {
                    const t = stack.pop();
                    result += `</${t}>`;
                    tagsAbove.unshift(t);
                }
                stack.pop(); // 弹出 tagName
                result += `</${tagName}>`;
                for (const t of tagsAbove) {
                    stack.push(t);
                    result += `<${t}>`;
                }
            }
        }
        i += fullTag.length;
    }

    // 关闭所有剩余未闭合的标签
    while (stack.length > 0) {
        result += `</${stack.pop()}>`;
    }
    return result;
}

module.exports = { Diary, cooldownMap, COOLDOWN_MS, getOrCreateDiary, calcMood, buildKeyboard, escapeHtml, fixHtmlTags };
