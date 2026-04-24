// @ts-check

const DEFAULT_NICKNAME = '你';
const DEFAULT_AFFECTION = 50;
const DEFAULT_DARKNESS = 10;
const MAX_CHAT_HISTORY = 16;
const SUMMARY_TRIGGER_TURNS = 3;
const MEMORY_PREFIX_LIMIT = 10;
const OBSESS_LIMIT = 20;
const LONG_TERM_MEMORY_LIMIT = 32;
const CHAPTER_SUMMARY_LIMIT = 6;
const RELEVANT_MEMORY_LIMIT = 3;
const COOLDOWN_MS = 2000;
const COOLDOWN_NOTICE_MS = 6000;
const TELEGRAM_HTML_TAGS = ['b', 'i', 'u', 's', 'code'];
const SAVE_MEMORY_PREFIXES = ['事件_', '偏好_', '情感_', '关系_'];
const HIDDEN_MEMORY_PREFIXES = ['OBSESS_', 'SYS_'];
const MEMORY_CATEGORY_LABELS = {
    preference: '偏好',
    boundary: '边界',
    topic: '话题',
    event: '事件',
    relationship: '关系',
    roleplay: '设定',
    profile: '资料',
};

module.exports = {
    DEFAULT_NICKNAME,
    DEFAULT_AFFECTION,
    DEFAULT_DARKNESS,
    MAX_CHAT_HISTORY,
    SUMMARY_TRIGGER_TURNS,
    MEMORY_PREFIX_LIMIT,
    OBSESS_LIMIT,
    LONG_TERM_MEMORY_LIMIT,
    CHAPTER_SUMMARY_LIMIT,
    RELEVANT_MEMORY_LIMIT,
    COOLDOWN_MS,
    COOLDOWN_NOTICE_MS,
    TELEGRAM_HTML_TAGS,
    SAVE_MEMORY_PREFIXES,
    HIDDEN_MEMORY_PREFIXES,
    MEMORY_CATEGORY_LABELS,
};
