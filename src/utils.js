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
    nickname:     { type: String, default: '阿雪' }
});
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
        MANIC:  [[{ text: '🫂 阿雪哪儿都不去',   callback_data: 'yuno_hug_deep' },       { text: '📓 由乃写下来',       callback_data: 'yuno_write_diary' }]],
        WARN:   [[{ text: '🫂 阿雪只在乎由乃',   callback_data: 'yuno_reassure' },       { text: '🔪 错的不是阿雪',     callback_data: 'yuno_destroy_world' }]],
        TENDER: [[{ text: '🌡 让由乃照顾阿雪',   callback_data: 'yuno_pet' },            { text: '👁 由乃一直看着你',   callback_data: 'yuno_stare' }]],
        JELLY:  [[{ text: '😤 当然是由乃最好',   callback_data: 'yuno_reassure' },       { text: '😏 逗逗由乃',         callback_data: 'yuno_tease' }]],
        SAD:    [[{ text: '🫂 我永远喜欢由乃',   callback_data: 'yuno_hug_deep' },       { text: '😏 让由乃猜猜',       callback_data: 'yuno_tease' }]],
        LOVE:   [[{ text: '❤ 摸摸由乃的头',      callback_data: 'yuno_pet' },            { text: '💋 亲一下由乃',       callback_data: 'yuno_kiss' }]],
        NORMAL: [[{ text: '❤ 摸摸由乃的头',      callback_data: 'yuno_pet' },            { text: '💍 永远不离开由乃',   callback_data: 'yuno_promise' }]],
    };
    return boards[moodTag] || boards.NORMAL;
}

module.exports = { Diary, cooldownMap, COOLDOWN_MS, getOrCreateDiary, calcMood, buildKeyboard };
