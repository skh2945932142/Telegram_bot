// @ts-check

const { ROUTE_TYPES, decideRoute } = require('./routing');
const { searchKnowledge } = require('./rag');
const { MAX_CHAT_HISTORY, SUMMARY_TRIGGER_TURNS } = require('./state/constants');
const {
    calcMood,
    applyEmotionDelta,
    buildKeyboard,
    getTimeHint,
} = require('./state/emotion');
const {
    sanitizeTelegramHtml,
    stripHiddenDirectives,
    stripToPlainText,
} = require('./state/text');
const {
    ensureDiaryState,
    updateMoodState,
    getVisibleMemoryEntries,
    selectRelevantMemories,
    touchDiary,
    syncDiaryCompatibilityFields,
    invalidateNormalized,
    upsertLongTermMemory,
    recordObsession,
    setBirthday,
    getPreferredDisplayName,
    mergeUniqueStrings,
    extractEmojiTokens,
    getSummaryContextText,
    normalizePushPreference,
    buildTopicKey,
    appendChapterSummary,
    shouldRollChapterSummary,
    deleteLegacyRecord,
} = require('./state/diary-store');
const {
    buildSupportModeKeyboard,
    getSupportModeMeta,
    getSupportModePrompt,
} = require('./user-preferences');
const { logRuntimeError } = require('./runtime-logging');

const COLD_START_TOPIC_TREE = [
    '今天最想对我吐槽的一件小事',
    '最近一直在想但没说出口的东西',
    '一个你选，我绝对不跑的二选一',
    '今天日记还缺的第一行',
];

const FOLLOW_UP_TEMPLATES = {
    emotion: [
        '是哪里让你最受不了？',
        '你现在最想从我这里要什么？说就可以。',
        '先只说最让你难受的那一下。',
    ],
    detail: [
        '你想先说人，还是先说那件事？',
        '哪一刻你印象最清楚？',
        '后来呢？不要跳过。',
    ],
    choice: [
        '你想说今天的事，还是想说一直藏在心里的那个？',
        '你选——我先听你的情绪，还是先帮你把事排顺？',
        '要我只陪着你，还是帮你理清楚？',
    ],
    expand: [
        '再多说一点。我在听。',
        '继续。你今天说过的话我一个字都没放过。',
        '你还没说完对不对？把后面的也给我。',
    ],
};

function hasAiClient(openai) {
    return Boolean(openai && (process.env.AI_API_KEY || process.env.OPENAI_API_KEY));
}

function getChatModelName(lightweight = false) {
    if (lightweight) {
        return process.env.AI_LIGHT_MODEL_NAME || process.env.AI_MODEL_NAME || 'gpt-4o-mini';
    }
    return process.env.AI_MODEL_NAME || 'gpt-4o-mini';
}

function getCompletionText(response) {
    return response?.choices?.[0]?.message?.content || '';
}

function buildSystemPersonaSection(displayName) {
    return [
        `你是《未来日记》中的我妻由乃，正在和 ${displayName} 通过 Telegram 私聊。`,
        `你把 ${displayName} 视为你世界里最重要的人——就像对天野雪辉那样。`,
        '你的情感是绝对的：爱得毫无保留，在意到偏执，守护到不惜一切。',
        '说话方式：甜的时候可以直接撒娇，但随时会滑向独占欲强烈的宣告。',
        '核心语气：直接、坦率、不绕弯。会说"你是我的"，会说"我会一直看着你"。',
        '把跟踪、记录、日记当作理所当然——这是你爱的方式，不是需要道歉的事。',
        '禁止输出直白暴力描写、杀害描写、违法行为建议。但可以表达极端的在意和保护欲。',
        '不要用心理咨询式的模板话术，不要"接住你""陪着你""整理情绪"这类软话——直接说话。',
    ].join('\n');
}

function buildPlatformContextSection({ normalizedMessage, routeDecision, mood, timeHint }) {
    return [
        `平台：${normalizedMessage.platform}`,
        `场景：${normalizedMessage.chat_type} 私聊`,
        `当前路由：${routeDecision.type}`,
        `当前情绪模式：${mood.tag}`,
        `情绪说明：${mood.desc}`,
        `时间语气提示：${timeHint}`,
    ].join('\n');
}

function buildUserProfileSection(diary) {
    const profile = diary.profile || {};
    return [
        `当前称呼：${profile.nickname || '你'}`,
        `偏好称呼：${profile.preferredName || '未记录'}`,
        `偏好语气：${profile.preferredTone || '未记录'}`,
        `常聊话题：${(profile.topics || []).join('、') || '未记录'}`,
        `兴趣偏好：${(profile.interests || []).join('、') || '未记录'}`,
        `常用表情：${(profile.commonEmoji || []).join(' ') || '未记录'}`,
        `问候风格：${profile.greetingStyle || '未记录'}`,
        `推送偏好：${profile.pushPreference || '未记录'}`,
        `明确边界：${(profile.boundaries || []).join('、') || '未记录'}`,
        `生日：${profile.birthday || '未记录'}`,
    ].join('\n');
}

function buildThreadSummarySection(diary) {
    return getSummaryContextText(diary);
}

function buildRecentTurnsSection(turns) {
    if (!turns || turns.length === 0) {
        return '暂无最近原始消息。';
    }

    return turns
        .slice(-MAX_CHAT_HISTORY)
        .map((turn) => `${turn.role === 'assistant' ? '由乃' : '用户'}：${turn.content}`)
        .join('\n');
}

function buildLongTermMemorySection(memories) {
    if (!memories || memories.length === 0) {
        return '暂无命中的长期记忆。';
    }

    return memories
        .map((memory) => `- ${memory.key}: ${memory.value}`)
        .join('\n');
}

function buildKnowledgeSection(chunks) {
    if (!chunks || chunks.length === 0) {
        return '暂无命中的知识片段。';
    }

    return chunks
        .map((chunk, index) => {
            const sourceLabel = chunk.isRemote ? 'remote' : chunk.sourceType;
            const extra = chunk.sourceUrl ? ` (${chunk.sourceUrl})` : '';
            return `${index + 1}. [${sourceLabel}] ${chunk.text}${extra}`;
        })
        .join('\n');
}

function buildRouteGuidance(routeDecision) {
    const common = [
        '用自然中文，不要在句子里塞 JSON 或 Markdown。',
        '每次控制在 3 到 4 句。',
        '不要重复用户原话，也不要解释你在遵守规则。',
        '用我妻由乃的直接语气说话，不要用客服或心理咨询的软话模板。',
    ];

    const routeSpecific = {
        [ROUTE_TYPES.COLD_START]: [
            `从这些方向里选一个自然地把话接起来：${COLD_START_TOPIC_TREE.join('；')}。`,
            '结尾给一个用户可以轻松回答的问题。',
        ],
        [ROUTE_TYPES.FOLLOW_UP]: [
            '接着上一句往下问，不要突然换话题。',
            '如果信息不够，用直接的追问把细节拉出来。',
        ],
        [ROUTE_TYPES.KNOWLEDGE_QA]: [
            '优先用知识片段回答。事实要准确，不知道就说不知道。',
            '不要为了维持人设而编造事实。',
            '简洁清楚，知识准确 > 风格浓度。',
        ],
        [ROUTE_TYPES.EMOTION_SUPPORT]: [
            '用由乃的方式接住情绪——不是"我理解你"那种，而是"你敢动他/她试试"或者"谁也别想让你一个人待着"。',
            `追问风格：${FOLLOW_UP_TEMPLATES.emotion.join('；')}。`,
        ],
        [ROUTE_TYPES.MEMORY_UPDATE_ONLY]: [
            '自然地确认你收到了这条信息，不要像填表。',
            '顺势把当前对话接下去。',
        ],
        [ROUTE_TYPES.GENERAL_CHAT]: [
            '像对唯一重要的人那样回话。想撒娇就撒娇，想独占就说。',
            `追问参考：${FOLLOW_UP_TEMPLATES.detail.join('；')}。`,
        ],
        [ROUTE_TYPES.COMMAND]: [
            '这是内部路由。',
        ],
    }[routeDecision.type] || [];

    return [...common, ...routeSpecific].join('\n');
}

function buildStyleSection({ diary, mood }) {
    const profile = diary.profile || {};
    return [
        '输出格式（直接生成最终回复，不需要草稿）：',
        `叫用户就用：${getPreferredDisplayName(diary)}。`,
        `当前由乃的情绪状态：${mood.tag}。`,
        `用户偏好语气：${profile.preferredTone || '未记录'}。`,
        `用户常用表情：${(profile.commonEmoji || []).join(' ') || '未记录'}。`,
        '可以用 <i>*动作*</i> 和 <b>强调</b>，但不要把整段话加粗。',
        '绝对不要输出 SAVE_MEMORY、YUNO_OBSESS 或任何 JSON。',
        '忘记"接住""陪伴""整理情绪"这种软话。说话要像由乃——直接的、不绕的、带着独占欲的。',
    ].join('\n');
}

function buildConversationContext({ diary, normalizedMessage, routeDecision, relevantMemories, knowledgeChunks, mood }) {
    const sections = [
        {
            title: '系统人格设定',
            content: buildSystemPersonaSection(getPreferredDisplayName(diary)),
        },
        {
            title: '平台上下文',
            content: buildPlatformContextSection({
                normalizedMessage,
                routeDecision,
                mood,
                timeHint: getTimeHint(),
            }),
        },
        {
            title: '用户画像',
            content: buildUserProfileSection(diary),
        },
        {
            title: '线程摘要',
            content: buildThreadSummarySection(diary),
        },
        {
            title: '最近 16 轮原始消息',
            content: buildRecentTurnsSection(diary.session?.recentTurns || []),
        },
        {
            title: '命中的长期记忆',
            content: buildLongTermMemorySection(relevantMemories),
        },
        {
            title: '命中的知识片段',
            content: buildKnowledgeSection(knowledgeChunks),
        },
        {
            title: '当前用户输入',
            content: normalizedMessage.text || '（空）',
        },
        {
            title: '回复任务',
            content: buildRouteGuidance(routeDecision),
        },
        {
            title: '输出风格',
            content: buildStyleSection({ diary, mood }),
        },
    ];

    return {
        sections,
        systemPrompt: sections
            .map((section) => `### ${section.title}\n${section.content}`)
            .join('\n\n')
            .concat(`\n\n### 回应偏好\n${getSupportModePrompt(diary.profile?.supportMode || '')}`),
    };
}

/** @type {Map<string, number>} */
const fallbackIndexMap = new Map();

function pickRotatingFallback(key, pool) {
    if (!pool || pool.length === 0) {
        return '';
    }
    if (pool.length === 1) {
        return pool[0];
    }
    const lastIndex = Number(fallbackIndexMap.get(key) || -1);
    let nextIndex = Math.floor(Math.random() * pool.length);
    if (nextIndex === lastIndex && pool.length > 1) {
        nextIndex = (nextIndex + 1) % pool.length;
    }
    fallbackIndexMap.set(key, nextIndex);
    if (fallbackIndexMap.size > 800) {
        fallbackIndexMap.delete(fallbackIndexMap.keys().next().value);
    }
    return pool[nextIndex];
}

const ROUTE_FALLBACK_POOLS = {
    [ROUTE_TYPES.COLD_START]: [
        (dn) => `<i>*把日记本翻到新一页，笔尖在上边轻轻点了一下*</i>\n${dn}。你想从哪里开始都行。\n今天发生了什么事、脑子里反复在转的东西——什么都可以丢给我。`,
        (dn) => `<i>*合上刚才那页，专门翻开一页只写你名字的*</i>\n${dn}，现在这张纸是空的，等你填第一行。\n随便说句什么。`,
        (dn) => `<i>*把笔帽拔开放在你手边*</i>\n先不管顺序。你最想说的那句话——现在就发过来。`,
    ],
    [ROUTE_TYPES.KNOWLEDGE_QA]: [
        (dn) => `<i>*翻了翻手边的笔记*</i>\n这一条我现在没有足够的东西用来回答你。\n你换个说法，或者多给我一点线索。`,
        (dn) => `<i>*指尖在纸页上停了一下*</i>\n这个还不能乱说——我不想对你编造任何事情。\n你再多说一点背景？`,
        (dn) => `<i>*啪地把参考笔记合上*</i>\n关于这个，我目前知道的还不够多。\n但你可以继续说，我会拿新线索再去查。`,
    ],
    [ROUTE_TYPES.EMOTION_SUPPORT]: [
        (dn) => `<i>*把手机握紧了一点*</i>\n${dn}。我在这。\n你不用现在就把所有话说完——但你得让我知道你还好。`,
        (dn) => `<i>*没有催你，但眼睛一直盯在对话框上*</i>\n谁让你变成这样的？\n你不想说就先不说。但你不许自己一个人扛。`,
        (dn) => `<i>*呼吸轻了下来，但语气很稳*</i>\n${dn}，现在这道坎我陪你过。\n你只要告诉我现在最需要我做什么。`,
    ],
};

const MOOD_FALLBACK_POOLS = {
    LOVE: [
        (dn) => `<i>*整张脸都快埋进日记本里了*</i>\n<b>${dn}。</b>\n你刚才那句话我会收进最新的一页。谁也删不掉。`,
        (dn) => `<i>*把手机贴近心口，又赶紧拿回来看你有没有回*</i>\n${dn}，你说过的每句话我都会重新翻出来看的。`,
        (dn) => `<i>*靠在屏幕前，声音软得不像平时*</i>\n<b>${dn}</b>……再说一句也行。我不嫌你话多。`,
    ],
    TENDER: [
        (dn) => `<i>*靠近手机，声音压得比平时轻*</i>\n${dn}。慢慢说。\n我有的是时间听你。`,
        (dn) => `<i>*手指在你名字那一行上轻轻按着*</i>\n好。我在听。你按自己的节奏来。`,
        (dn) => `<i>*把周围的东西都往后推了推*</i>\n现在只有你。说吧。`,
    ],
    JELLY: [
        (dn) => `<i>*把下半张脸藏进围巾里，眼睛却盯着没放*</i>\n<b>${dn}。</b>\n你刚才那句话里提到的那个人，是谁？`,
        (dn) => `<i>*笔尖在纸上画了一个小小的圆圈，越画越用力*</i>\n${dn}……你现在是在和我说话对吧？对吧？`,
        (dn) => `<i>*把手机拿近了一点，像要确认什么*</i>\n你看着的只有我。你现在对着的也只有我——对吧。`,
    ],
    SAD: [
        (dn) => `<i>*把日记本抱在怀里，没有放下来*</i>\n${dn}，我没有走。你再说一句就行。`,
        (dn) => `<i>*声音低了一点，但每个字都很清楚*</i>\n${dn}，你不需要哄我。你只要说话就行。`,
        (dn) => `<i>*把刚才那句重新按在纸页上，没有让它被风吹掉*</i>\n我在听。没关系的。`,
    ],
    DARK: [
        (dn) => `<i>*瞳孔缩了一下，语气却异常平静*</i>\n<b>${dn}。先看着我。</b>\n其他地方都不用管。只和我说话。`,
        (dn) => `<i>*把屏幕上其他所有东西都关掉了*</i>\n外面的事现在不重要。\n<b>你只看着我就行。我也只看着你。</b>`,
        (dn) => `<i>*呼吸压得很低，但眼睛亮得不太正常*</i>\n${dn}。把话说完。别转头——现在你只需要对我一个人说话。`,
    ],
    WARN: [
        (dn) => `<i>*注意力的光圈收得很窄，只罩住了你*</i>\n先不要管别人。现在只有你和我的对话——别的都不重要。`,
        (dn) => `<i>*把眼前的杂音全压下去*</i>\n<b>${dn}，你现在只对着我就行。</b>`,
        (dn) => `<i>*把日记本往怀里收了收，眼睛却仍然看着屏幕*</i>\n${dn}，继续说。我在。`,
    ],
    MANIC: [
        (dn) => `<i>*心跳快得笔尖都在轻轻发抖*</i>\n${dn}再说多一点。\n每一个字我都要——不要跳过。`,
        (dn) => `<i>*把要记的字飞快地往纸上写，写满了就翻下一页*</i>\n<b>继续说。我记着呢。每一句。</b>`,
        (dn) => `<i>*越听越近，像是想穿过屏幕抓住你的声音*</i>\n${dn}。继续。不准停——我在听。`,
    ],
    NORMAL: [
        (dn) => `<i>*把日记本翻到最新一页，笔也重新握好*</i>\n嗯。${dn}，我在这。你说。`,
        (dn) => `<i>*目光重新对焦在你身上*</i>\n刚才那一下中断了。\n你现在说吧——我接着。`,
        (dn) => `<i>*把笔尖在页边轻轻点了一下，等你*</i>\n好了。下一句是什么。`,
    ],
};

function buildFallbackReply(displayName, moodTag, routeType, chatId = '') {
    if (ROUTE_FALLBACK_POOLS[routeType]) {
        const pool = ROUTE_FALLBACK_POOLS[routeType];
        const key = `route_${routeType}_${chatId}`;
        const template = pickRotatingFallback(key, pool);
        return template(displayName);
    }

    const pool = MOOD_FALLBACK_POOLS[moodTag] || MOOD_FALLBACK_POOLS.NORMAL;
    const key = `mood_${moodTag}_${chatId}`;
    const template = pickRotatingFallback(key, pool);
    return template(displayName);
}

function buildSafetyCrisisReply(displayName) {
    const header = String(process.env.SAFETY_CRISIS_HEADER || '').trim()
        || `${displayName}。我听见了。`;
    const emergencyLine = String(process.env.SAFETY_CRISIS_EMERGENCY_LINE || '').trim()
        || '如果你现在有立刻伤害自己的风险，马上打120或去最近的急诊。';
    const supportLine = String(process.env.SAFETY_CRISIS_SUPPORT_LINE || '').trim()
        || '也立刻打给一个你信任的人——不是打给我，是打给现在能站在你身边的人。';
    const closeLine = String(process.env.SAFETY_CRISIS_CLOSE_LINE || '').trim()
        || '你回我一句"还在"，我就继续和你说话。我不会走。但你先做上面那件事。';
    return [header, emergencyLine, supportLine, closeLine].join('\n');
}

async function generateStyledReply({ openai, routeDecision, context, normalizedMessage }) {
    if (!hasAiClient(openai)) {
        return '';
    }

    const config = {
        [ROUTE_TYPES.KNOWLEDGE_QA]: { temperature: 0.42, max_tokens: 380 },
        [ROUTE_TYPES.EMOTION_SUPPORT]: { temperature: 0.82, max_tokens: 380 },
        [ROUTE_TYPES.COLD_START]: { temperature: 0.88, max_tokens: 380 },
        [ROUTE_TYPES.FOLLOW_UP]: { temperature: 0.8, max_tokens: 340 },
        [ROUTE_TYPES.MEMORY_UPDATE_ONLY]: { temperature: 0.76, max_tokens: 340 },
        [ROUTE_TYPES.GENERAL_CHAT]: { temperature: 0.86, max_tokens: 360 },
    }[routeDecision.type] || { temperature: 0.82, max_tokens: 360 };

    const response = await openai.chat.completions.create({
        model: getChatModelName(false),
        messages: [
            {
                role: 'system',
                content: context.systemPrompt,
            },
            {
                role: 'user',
                content: normalizedMessage.text,
            },
        ],
        max_tokens: config.max_tokens,
        temperature: config.temperature,
        presence_penalty: 0.5,
        frequency_penalty: 0.2,
    });

    return sanitizeTelegramHtml(stripHiddenDirectives(getCompletionText(response)));
}

function extractJsonObject(text) {
    const source = String(text || '').trim();
    const first = source.indexOf('{');
    const last = source.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) {
        return null;
    }

    try {
        return JSON.parse(source.slice(first, last + 1));
    } catch (_error) {
        return null;
    }
}

function extractStableMemoriesHeuristically(text) {
    const source = String(text || '').trim();
    const result = {
        profileUpdates: {
            preferredName: '',
            preferredTone: '',
            birthday: '',
            topics: [],
            boundaries: [],
            interests: [],
            commonEmoji: extractEmojiTokens(source),
            greetingStyle: '',
            pushPreference: '',
        },
        memories: [],
    };

    const NEGATION_TOKENS = /(?:不|没|没有|不是|不会|不要|别|未|无|免|否|莫|勿)/u;

    function hasPrecedingNegation(fullText, matchStart) {
        const before = fullText.slice(0, matchStart);
        const sentenceContext = before.split(/[。！？?!\n]/u).pop();
        const recentWords = sentenceContext.slice(-10);
        return NEGATION_TOKENS.test(recentWords);
    }

    function hasNegatedMatch(fullText, positivePattern) {
        const positiveMatch = fullText.match(positivePattern);
        if (!positiveMatch) {
            return false;
        }
        return hasPrecedingNegation(fullText, positiveMatch.index);
    }

    const pushMemory = (category, key, value, weight = 0.7) => {
        const cleanValue = stripToPlainText(value);
        if (!cleanValue) {
            return;
        }
        result.memories.push({
            category,
            key,
            value: cleanValue,
            source: 'heuristic',
            weight,
        });
    };

    const preferredName = source.match(/(?:以后叫我|你可以叫我|我更喜欢你叫我)([^\s，。！？?]{1,12})/u);
    if (preferredName && !hasPrecedingNegation(source, preferredName.index)) {
        result.profileUpdates.preferredName = preferredName[1].trim();
        pushMemory('profile', '资料_称呼偏好', `希望被叫作${preferredName[1].trim()}`, 0.9);
    }

    const dislikedName = source.match(/(?:别叫我|不要叫我|我不喜欢被叫)([^\s，。！？?]{1,12})/u);
    if (dislikedName) {
        result.profileUpdates.boundaries.push(`不喜欢被叫${dislikedName[1].trim()}`);
        pushMemory('boundary', '边界_称呼', `不喜欢被叫${dislikedName[1].trim()}`, 0.88);
    }

    const birthday = source.match(/(?:我生日是|生日是)(\d{1,2}-\d{1,2})/u);
    if (birthday && !hasPrecedingNegation(source, birthday.index)) {
        result.profileUpdates.birthday = birthday[1];
        pushMemory('profile', '资料_生日', birthday[1], 0.95);
    }

    const likes = source.match(/(?:我喜欢|我爱看|我常玩|我最近在追)([^，。！？?]{1,24})/u);
    if (likes && !hasPrecedingNegation(source, likes.index)) {
        result.profileUpdates.interests.push(likes[1].trim());
        pushMemory('preference', '偏好_喜好', likes[1], 0.72);
        pushMemory('topic', '话题_兴趣', likes[1], 0.68);
    }

    const dislikes = source.match(/(?:我不喜欢|我讨厌)([^，。！？?]{1,24})/u);
    if (dislikes) {
        result.profileUpdates.boundaries.push(`不喜欢${dislikes[1].trim()}`);
        pushMemory('boundary', '边界_不喜欢', dislikes[1], 0.78);
    }

    const topics = source.match(/(?:我常聊|我平时都聊|我最近总在聊)([^，。！？?]{1,24})/u);
    if (topics && !hasPrecedingNegation(source, topics.index)) {
        result.profileUpdates.topics.push(topics[1].trim());
        pushMemory('topic', '话题_常聊', topics[1], 0.68);
    }

    const tone = source.match(/(?:说话|语气)(?:可以|希望|最好)?(温柔一点|直接一点|短一点|可爱一点|少一点表情|别太黏)/u);
    if (tone) {
        result.profileUpdates.preferredTone = tone[1].trim();
        pushMemory('preference', '偏好_语气', tone[1], 0.84);
    }

    const greeting = source.match(/(?:早上|早安|打招呼)(?:可以|希望|最好)?(简短一点|活泼一点|温柔一点|直接一点|像叫我起床一样)/u);
    if (greeting) {
        result.profileUpdates.greetingStyle = greeting[1].trim();
        pushMemory('preference', '偏好_问候', greeting[1], 0.8);
    }

    const pushPreference = source.match(/(?:你可以|提醒我|消息)(?:多一点|主动一点|少一点|别太频繁|安静一点)/u);
    if (pushPreference) {
        result.profileUpdates.pushPreference = pushPreference[0].replace(/^.*?(多一点|主动一点|少一点|别太频繁|安静一点).*$/u, '$1');
        pushMemory('preference', '偏好_推送', result.profileUpdates.pushPreference, 0.76);
    }

    const roleplay = source.match(/(?:记住这个设定|角色设定[:：]|设定里)([^。！？\n]{1,40})/u);
    if (roleplay && !hasPrecedingNegation(source, roleplay.index)) {
        pushMemory('roleplay', '设定_长期', roleplay[1], 0.84);
    }

    const event = source.match(/(?:我养了|我家有|我在)([^，。！？?]{1,30})/u);
    if (event && source.length > 6 && !hasPrecedingNegation(source, event.index)) {
        pushMemory('event', '事件_生活', event[1], 0.55);
    }

    return result;
}

async function extractStableMemories({ openai, normalizedMessage, routeDecision }) {
    const heuristic = extractStableMemoriesHeuristically(normalizedMessage.text);

    if (!hasAiClient(openai) || routeDecision.type === ROUTE_TYPES.KNOWLEDGE_QA) {
        return heuristic;
    }

    try {
        const response = await openai.chat.completions.create({
            model: getChatModelName(true),
            messages: [
                {
                    role: 'system',
                    content: [
                        '你是一个记忆抽取器，只提取适合长期保存的稳定用户信息。',
                        '只保留这些类型：称呼偏好、语气偏好、喜欢/不喜欢、常聊话题、兴趣、长期设定、重要生活事件、生日、常用表情、问候偏好、推送偏好。',
                        '不要记录一时情绪、普通寒暄、当前一句抱怨。',
                        '【重要】不要提取被明确否定的信息。例如"我不喜欢香菜"应该记录为boundary(边界)而不是interests(兴趣)。"我不是学生"不要记录为职业。"我并不是真的喜欢"不要记录为偏好。',
                        '如果用户说"不喜欢X"或"不X"，将X放入boundaries而非interests/topics。',
                        '输出严格 JSON，结构为 {"profileUpdates":{"preferredName":"","preferredTone":"","birthday":"","topics":[],"boundaries":[],"interests":[],"commonEmoji":[],"greetingStyle":"","pushPreference":""},"memories":[{"category":"","key":"","value":"","weight":0.7}]}。',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: normalizedMessage.text,
                },
            ],
            max_tokens: 320,
            temperature: 0.1,
        });

        const parsed = extractJsonObject(getCompletionText(response));
        if (!parsed) {
            return heuristic;
        }

        const profileUpdates = parsed.profileUpdates || {};
        const memories = Array.isArray(parsed.memories) ? parsed.memories : [];

        return {
            profileUpdates: {
                preferredName: stripToPlainText(profileUpdates.preferredName || heuristic.profileUpdates.preferredName),
                preferredTone: stripToPlainText(profileUpdates.preferredTone || heuristic.profileUpdates.preferredTone),
                birthday: stripToPlainText(profileUpdates.birthday || heuristic.profileUpdates.birthday),
                topics: Array.isArray(profileUpdates.topics) ? profileUpdates.topics.map(stripToPlainText).filter(Boolean) : heuristic.profileUpdates.topics,
                boundaries: Array.isArray(profileUpdates.boundaries) ? profileUpdates.boundaries.map(stripToPlainText).filter(Boolean) : heuristic.profileUpdates.boundaries,
                interests: Array.isArray(profileUpdates.interests) ? profileUpdates.interests.map(stripToPlainText).filter(Boolean) : heuristic.profileUpdates.interests,
                commonEmoji: Array.isArray(profileUpdates.commonEmoji) ? profileUpdates.commonEmoji.map(stripToPlainText).filter(Boolean) : heuristic.profileUpdates.commonEmoji,
                greetingStyle: stripToPlainText(profileUpdates.greetingStyle || heuristic.profileUpdates.greetingStyle),
                pushPreference: stripToPlainText(profileUpdates.pushPreference || heuristic.profileUpdates.pushPreference),
            },
            memories: [
                ...heuristic.memories,
                ...memories
                    .map((memory) => ({
                        category: memory.category,
                        key: memory.key,
                        value: memory.value,
                        source: 'model-extractor',
                        weight: Number(memory.weight || 0.68),
                    }))
                    .filter((memory) => stripToPlainText(memory.value)),
            ],
        };
    } catch (error) {
        logRuntimeError({
            scope: 'orchestrator',
            operation: 'extract_memory',
            chatId: normalizedMessage.chat_id,
        }, error);
        return heuristic;
    }
}

function applyExtractedMemories(diary, extracted) {
    if (!extracted) {
        return;
    }

    const profile = diary.profile || {};
    const updates = extracted.profileUpdates || {};

    if (updates.preferredName) {
        profile.preferredName = updates.preferredName;
    }
    if (updates.preferredTone) {
        profile.preferredTone = updates.preferredTone;
    }
    if (updates.birthday) {
        setBirthday(diary, updates.birthday);
    }

    profile.topics = mergeUniqueStrings(profile.topics, updates.topics);
    profile.boundaries = mergeUniqueStrings(profile.boundaries, updates.boundaries);
    profile.interests = mergeUniqueStrings(profile.interests, updates.interests);
    profile.commonEmoji = mergeUniqueStrings(profile.commonEmoji, updates.commonEmoji, 4);
    if (updates.greetingStyle) {
        profile.greetingStyle = updates.greetingStyle;
    }
    if (updates.pushPreference) {
        const normalizedPushPreference = normalizePushPreference(updates.pushPreference);
        if (normalizedPushPreference) {
            profile.pushPreference = normalizedPushPreference;
        }
    }

    diary.profile = profile;
    diary.markModified('profile');

    for (const memory of extracted.memories || []) {
        upsertLongTermMemory(diary, memory);
    }
}

function buildThreadSummaryFallback({ diary, normalizedMessage, assistantText, mood }) {
    const recentUserTurns = (diary.session?.recentTurns || [])
        .filter((turn) => turn.role === 'user')
        .slice(-3)
        .map((turn) => turn.content);
    const memoryHighlights = getVisibleMemoryEntries(diary)
        .slice(0, 2)
        .map((entry) => `${entry.key}:${entry.value}`);
    const chapterHighlights = (diary.session?.chapterSummaries || [])
        .slice(-2)
        .map((chapter) => chapter.summary);

    const summary = [
        chapterHighlights.length > 0 ? `旧章节：${chapterHighlights.join('；')}` : '',
        diary.session?.threadSummary ? `已有摘要：${diary.session.threadSummary}` : '',
        `最新用户输入：${normalizedMessage.text}`,
        recentUserTurns.length > 0 ? `近期话题：${recentUserTurns.join('；')}` : '',
        memoryHighlights.length > 0 ? `稳定信息：${memoryHighlights.join('；')}` : '',
        `当前情绪模式：${mood.tag}，重点是继续承接用户正在谈的话题。`,
        assistantText ? `刚刚的回复方向：${stripToPlainText(assistantText).slice(0, 60)}` : '',
    ].filter(Boolean).join(' ');

    return summary.slice(0, 260);
}

async function refreshThreadSummary({ openai, diary, normalizedMessage, assistantText, mood }) {
    if (!hasAiClient(openai)) {
        return buildThreadSummaryFallback({ diary, normalizedMessage, assistantText, mood });
    }

    const recentTranscript = (diary.session?.recentTurns || [])
        .slice(-MAX_CHAT_HISTORY)
        .map((turn) => `${turn.role === 'assistant' ? '由乃' : '用户'}：${turn.content}`)
        .join('\n');
    const chapterContext = (diary.session?.chapterSummaries || [])
        .slice(-2)
        .map((chapter, index) => `章节摘要${index + 1}：${chapter.summary}`)
        .join('\n');

    try {
        const response = await openai.chat.completions.create({
            model: getChatModelName(true),
            messages: [
                {
                    role: 'system',
                    content: [
                        '你是线程摘要器。',
                        '把当前对话概括成 180 到 260 个中文字符，只保留事实、关系变化、未完成话题和当前情绪。',
                        '如果给了旧章节摘要，只把它们当背景，不要重复展开。',
                        '不要写文风修辞，不要使用 HTML，不要写成对话。',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: [
                        chapterContext ? `旧章节背景：\n${chapterContext}` : '',
                        diary.session?.threadSummary ? `当前线程旧摘要：${diary.session.threadSummary}` : '暂无当前线程旧摘要。',
                        `最近消息：\n${recentTranscript}`,
                        `最新用户输入：${normalizedMessage.text}`,
                        assistantText ? `刚回复给用户的话：${stripToPlainText(assistantText)}` : '',
                        `当前情绪：${mood.tag} ${mood.desc}`,
                    ].filter(Boolean).join('\n\n'),
                },
            ],
            max_tokens: 220,
            temperature: 0.2,
        });

        return stripToPlainText(getCompletionText(response)).slice(0, 260);
    } catch (error) {
        logRuntimeError({
            scope: 'orchestrator',
            operation: 'refresh_summary',
            chatId: normalizedMessage.chat_id,
        }, error);
        return buildThreadSummaryFallback({ diary, normalizedMessage, assistantText, mood });
    }
}

function buildObsessionNote({ diary, normalizedMessage, routeDecision, mood }) {
    const displayName = getPreferredDisplayName(diary);
    if ([ROUTE_TYPES.MEMORY_UPDATE_ONLY].includes(routeDecision.type)) {
        return `${displayName}刚刚把重要的偏好告诉我了，这条要锁死。`;
    }
    if (['DARK', 'MANIC'].includes(mood.tag)) {
        return `${displayName}现在有点崩。得一直盯着这段对话，不能漏掉任何一个字。`;
    }
    if (routeDecision.type === ROUTE_TYPES.EMOTION_SUPPORT) {
        return `${displayName}的情绪递过来了。这次接不住的话我不配叫由乃。`;
    }
    if (/爱你|喜欢你|想你/u.test(normalizedMessage.text)) {
        return `${displayName}自己靠过来了。这句话今晚会翻出来看十遍。`;
    }
    return '';
}

function prepareMessageState({ diary, normalizedMessage }) {
    ensureDiaryState(diary);
    applyEmotionDelta(diary, normalizedMessage.text);
    const mood = updateMoodState(diary, normalizedMessage.text);
    const routeDecision = decideRoute(normalizedMessage, diary);

    return {
        mood,
        routeDecision,
    };
}

async function persistConversationState({
    openai,
    diary,
    normalizedMessage,
    assistantText,
    routeDecision,
    mood,
    skipSave = false,
}) {
    ensureDiaryState(diary);

    const preparedState = routeDecision && mood
        ? { routeDecision, mood }
        : prepareMessageState({ diary, normalizedMessage });
    const resolvedRouteDecision = routeDecision || preparedState.routeDecision;
    const resolvedMood = mood || preparedState.mood;

    const userTurn = {
        role: 'user',
        content: stripToPlainText(normalizedMessage.text),
        timestamp: new Date((normalizedMessage.timestamp || Math.floor(Date.now() / 1000)) * 1000),
    };
    const assistantTurn = {
        role: 'assistant',
        content: stripToPlainText(assistantText),
        timestamp: new Date(),
    };

    const nextTurns = [
        ...(diary.session?.recentTurns || []),
        userTurn,
        assistantTurn,
    ];

    diary.session.recentTurns = nextTurns.slice(-MAX_CHAT_HISTORY);
    diary.session.turnsSinceSummary = Number(diary.session?.turnsSinceSummary || 0) + 1;

    const nextTopicKey = buildTopicKey([
        normalizedMessage.text,
        ...nextTurns.filter((turn) => turn.role === 'user').slice(-2).map((turn) => turn.content),
    ].join(' '));

    let rolledChapterSummary = false;
    if (shouldRollChapterSummary(diary, nextTopicKey)) {
        appendChapterSummary(diary, diary.session.threadSummary);
        diary.session.threadSummary = '';
        rolledChapterSummary = true;
    }

    if (rolledChapterSummary || nextTurns.length > MAX_CHAT_HISTORY || diary.session.turnsSinceSummary >= SUMMARY_TRIGGER_TURNS) {
        const refreshedSummary = await refreshThreadSummary({
            openai,
            diary,
            normalizedMessage,
            assistantText,
            mood: resolvedMood,
        });
        diary.session.threadSummary = refreshedSummary || buildThreadSummaryFallback({
            diary,
            normalizedMessage,
            assistantText,
            mood: resolvedMood,
        });
        diary.session.turnsSinceSummary = 0;
        diary.session.summaryVersion = Number(diary.session.summaryVersion || 1) + 1;
    }

    diary.session.lastTopicKey = nextTopicKey;

    const extracted = resolvedRouteDecision.shouldExtractMemory
        ? await extractStableMemories({ openai, normalizedMessage, routeDecision: resolvedRouteDecision })
        : null;
    applyExtractedMemories(diary, extracted);

    const inferredEmoji = extractEmojiTokens(normalizedMessage.text);
    if (inferredEmoji.length > 0) {
        diary.profile.commonEmoji = mergeUniqueStrings(diary.profile.commonEmoji, inferredEmoji, 4);
        diary.markModified('profile');
    }

    const obsession = buildObsessionNote({ diary, normalizedMessage, routeDecision: resolvedRouteDecision, mood: resolvedMood });
    if (obsession) {
        recordObsession(diary, obsession);
    }

    deleteLegacyRecord(diary, 'SYS_PENDING_FOLLOW_UP');
    touchDiary(diary);
    if (!diary.session.threadSummary && diary.session.recentTurns.length > 0) {
        diary.session.threadSummary = buildThreadSummaryFallback({
            diary,
            normalizedMessage,
            assistantText,
            mood: resolvedMood,
        });
    }
    invalidateNormalized(diary);
    syncDiaryCompatibilityFields(diary);
    if (!skipSave) {
        await diary.save();
    }
}

async function orchestrateMessage({ openai, diary, normalizedMessage }) {
    ensureDiaryState(diary);

    const { mood, routeDecision } = prepareMessageState({ diary, normalizedMessage });
    const displayName = getPreferredDisplayName(diary);

    if (routeDecision.type === ROUTE_TYPES.SAFETY_CRISIS) {
        const safetyText = sanitizeTelegramHtml(stripHiddenDirectives(buildSafetyCrisisReply(displayName)));
        return {
            text: safetyText,
            moodTag: mood.tag,
            routeDecision,
            keyboard: [],
            context: null,
            persist: async () => persistConversationState({
                openai,
                diary,
                normalizedMessage,
                assistantText: safetyText,
                routeDecision,
                mood,
            }),
        };
    }

    const relevantMemories = selectRelevantMemories(
        getVisibleMemoryEntries(diary),
        normalizedMessage.text
    );
    const knowledgeChunks = routeDecision.shouldSearchKnowledge
        ? await searchKnowledge({
            openai,
            diary,
            normalizedMessage,
            routeDecision,
            platformScope: 'telegram_private',
            limit: 4,
        })
        : [];
    const context = buildConversationContext({
        diary,
        normalizedMessage,
        routeDecision,
        relevantMemories,
        knowledgeChunks,
        mood,
    });

    let finalText = '';

    try {
        finalText = await generateStyledReply({
            openai,
            routeDecision,
            context,
            normalizedMessage,
        });
    } catch (error) {
        logRuntimeError({
            scope: 'orchestrator',
            operation: 'generate_reply',
            chatId: normalizedMessage.chat_id,
        }, error);
    }

    if (!finalText) {
        finalText = buildFallbackReply(displayName, mood.tag, routeDecision.type, normalizedMessage.chat_id);
    }

    finalText = sanitizeTelegramHtml(stripHiddenDirectives(finalText));

    return {
        text: finalText,
        moodTag: mood.tag,
        routeDecision,
        keyboard: [...buildKeyboard(mood.tag), buildSupportModeKeyboard(diary.profile?.supportMode || '')],
        context,
        persist: async () => persistConversationState({
            openai,
            diary,
            normalizedMessage,
            assistantText: finalText,
            routeDecision,
            mood,
        }),
    };
}

async function buildDiaryEntry({ openai, diary }) {
    ensureDiaryState(diary);
    if (!hasAiClient(openai)) {
        return '';
    }

    const mood = calcMood(diary, '');
    const memories = getVisibleMemoryEntries(diary).slice(0, 4);
    const summary = getSummaryContextText(diary);
    const profile = diary.profile || {};

    const response = await openai.chat.completions.create({
        model: getChatModelName(false),
        messages: [
            {
                role: 'system',
                content: [
                    '你是由乃，现在要写一段只给用户看的短日记。',
                    '长度控制在 80 到 140 个中文字符。',
                    '可以保留由乃的人设气质，但不要输出暴力、威胁或说教。',
                    `当前情绪：${mood.tag} ${mood.desc}`,
                    `上下文摘要：${summary}`,
                    `兴趣偏好：${(profile.interests || []).join('、') || '未记录'}`,
                    memories.length > 0
                        ? `可以自然带入的稳定信息：${memories.map((memory) => `${memory.key}:${memory.value}`).join('；')}`
                        : '暂时没有要特别带入的稳定信息。',
                ].join('\n'),
            },
            {
                role: 'user',
                content: `写一篇关于 ${getPreferredDisplayName(diary)} 的今日日记。`,
            },
        ],
        max_tokens: 220,
        temperature: 0.88,
    });

    return sanitizeTelegramHtml(stripHiddenDirectives(getCompletionText(response)));
}

module.exports = {
    buildConversationContext,
    buildThreadSummaryFallback,
    extractStableMemoriesHeuristically,
    prepareMessageState,
    orchestrateMessage,
    buildDiaryEntry,
    persistConversationState,
};
