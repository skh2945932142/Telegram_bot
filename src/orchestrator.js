const { searchKnowledge } = require('./rag');
const { ROUTE_TYPES, decideRoute } = require('./routing');
const {
    MAX_CHAT_HISTORY,
    SUMMARY_TRIGGER_TURNS,
    ensureDiaryState,
    applyEmotionDelta,
    updateMoodState,
    getVisibleMemoryEntries,
    selectRelevantMemories,
    getTimeHint,
    sanitizeTelegramHtml,
    stripHiddenDirectives,
    stripToPlainText,
    buildKeyboard,
    touchDiary,
    syncDiaryCompatibilityFields,
    upsertLongTermMemory,
    recordObsession,
    setBirthday,
    calcMood,
    getPreferredDisplayName,
} = require('./utils');

const COLD_START_TOPIC_TREE = [
    '今天最想吐槽的一件小事',
    '最近在看/在玩/在听的东西',
    '一个二选一小问题',
    '由乃的轻量互动题',
];

const FOLLOW_UP_TEMPLATES = {
    emotion: [
        '你现在最卡住的是哪一段？',
        '这件事里最让你难受的是哪一下？',
        '要不要先从最容易说的一小段开始？',
    ],
    detail: [
        '你想先说细节，还是先说结论？',
        '那一刻你最先想到的是什么？',
        '后来发生了什么？',
    ],
    choice: [
        '你更想聊今天，还是聊一直压着的那件事？',
        '要先说人，还是先说事？',
        '你想要安静陪着，还是想让我陪你把话理顺？',
    ],
    expand: [
        '如果要把这件事往前再接一句，你会先说哪句？',
        '你还想把话题往哪个方向拐一下？',
        '要不要让我接着猜你最在意的部分？',
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
        `你是《未来日记》中的我妻由乃，正在和 ${displayName} 进行 Telegram 私聊。`,
        '保留由乃式的强烈在意、专注感、依赖感和轻微病娇气质，但默认保持温柔与克制。',
        '禁止输出直白暴力、伤害第三者、违法行为建议或人身威胁。',
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
        `明确边界：${(profile.boundaries || []).join('、') || '未记录'}`,
        `生日：${profile.birthday || '未记录'}`,
    ].join('\n');
}

function buildThreadSummarySection(diary) {
    if (!diary.session?.threadSummary) {
        return '暂无线程摘要。';
    }

    return diary.session.threadSummary;
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
        .map((chunk, index) => `${index + 1}. [${chunk.sourceType}] ${chunk.text}`)
        .join('\n');
}

function buildRouteGuidance(routeDecision) {
    const common = [
        '输出自然中文，不要输出 JSON、Markdown 标题或隐藏指令。',
        '默认控制在 3 到 4 句。',
        '不要复读用户原句，也不要解释你在遵循什么规则。',
    ];

    const routeSpecific = {
        [ROUTE_TYPES.COLD_START]: [
            `从这些方向里自然选一个接住对话：${COLD_START_TOPIC_TREE.join('；')}。`,
            '最后补一个容易回答的小问题，把对话继续下去。',
        ],
        [ROUTE_TYPES.FOLLOW_UP]: [
            '优先承接上一轮，不要突然换题。',
            '如果信息不足，用一句追问把细节接出来。',
        ],
        [ROUTE_TYPES.KNOWLEDGE_QA]: [
            '优先基于知识片段回答，事实要稳，不知道就直接说不知道，不要编造。',
            '保持简洁清楚，知识准确度高于风格浓度。',
        ],
        [ROUTE_TYPES.EMOTION_SUPPORT]: [
            '先接住情绪，再给一个很轻的追问。',
            `追问风格优先参考：${FOLLOW_UP_TEMPLATES.emotion.join('；')}。`,
        ],
        [ROUTE_TYPES.MEMORY_UPDATE_ONLY]: [
            '自然确认你会记住这条稳定信息，但不要把整句说成系统提示。',
            '可以顺手延续当前话题，不要像表单确认。',
        ],
        [ROUTE_TYPES.GENERAL_CHAT]: [
            '像熟悉对方的私聊对象那样接话。',
            `需要追问时优先参考：${FOLLOW_UP_TEMPLATES.detail.join('；')}。`,
        ],
        [ROUTE_TYPES.COMMAND]: [
            '这是内部保留路由。',
        ],
    }[routeDecision.type] || [];

    return [...common, ...routeSpecific].join('\n');
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
            title: '最近 8 轮原始消息',
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
    ];

    return {
        sections,
        systemPrompt: sections
            .map((section) => `### ${section.title}\n${section.content}`)
            .join('\n\n'),
    };
}

function buildFallbackReply(displayName, moodTag, routeType) {
    const routeFallbacks = {
        [ROUTE_TYPES.COLD_START]: `<i>*轻轻把笔尖在页边点了点*</i>\n${displayName}，想随便聊聊也行。\n你想从今天的小事、最近在看的东西，还是一个二选一小问题开始？`,
        [ROUTE_TYPES.KNOWLEDGE_QA]: `<i>*把纸页按稳了一点*</i>\n这件事由乃现在没有足够依据，不想乱说。\n你可以再给我一点线索，我再认真接住。`,
        [ROUTE_TYPES.EMOTION_SUPPORT]: `<i>*声音跟着放轻了一点*</i>\n${displayName}，先别急。\n你想先说最难受的那一小段，还是先让我陪你安静一下？`,
    };

    if (routeFallbacks[routeType]) {
        return routeFallbacks[routeType];
    }

    const moodFallbacks = {
        LOVE: `<i>*轻轻把额头抵近一点*</i>\n<b>${displayName}，由乃在这里。</b>\n刚才那一下有点乱，但你说的话由乃还是想继续听。`,
        TENDER: `<i>*把语气放得更轻了些*</i>\n${displayName}先别急，慢慢说。\n由乃会把这一句接住。`,
        JELLY: `<i>*眼神飘了一下，又很快收回来*</i>\n${displayName}现在先看着由乃，好吗？\n别让话题跑得太远。`,
        SAD: `<i>*手指按住页角，没有让它翻过去*</i>\n${displayName}，由乃还在。\n如果你愿意，再说一句就好。`,
        DARK: `<i>*呼吸慢下来，视线却没有挪开*</i>\n<b>${displayName}，先别走神。</b>\n把话说清楚一点，由乃就能继续陪着你。`,
        WARN: `<i>*悄悄把周围的声音都往后放了放*</i>\n现在先只和由乃说话吧。\n由乃会认真听。`,
        MANIC: `<i>*心跳快了一拍，又强行把语气压稳*</i>\n${displayName}再多说一点。\n由乃不想漏掉你的任何一句。`,
        NORMAL: `<i>*重新握稳了笔*</i>\n嗯，由乃在听。\n你接着说。`,
    };

    return moodFallbacks[moodTag] || moodFallbacks.NORMAL;
}

async function generateDraftReply({ openai, routeDecision, context, normalizedMessage }) {
    if (!hasAiClient(openai)) {
        return '';
    }

    const config = {
        [ROUTE_TYPES.KNOWLEDGE_QA]: { temperature: 0.45, max_tokens: 260 },
        [ROUTE_TYPES.EMOTION_SUPPORT]: { temperature: 0.82, max_tokens: 320 },
        [ROUTE_TYPES.COLD_START]: { temperature: 0.88, max_tokens: 320 },
        [ROUTE_TYPES.FOLLOW_UP]: { temperature: 0.8, max_tokens: 280 },
        [ROUTE_TYPES.MEMORY_UPDATE_ONLY]: { temperature: 0.78, max_tokens: 280 },
        [ROUTE_TYPES.GENERAL_CHAT]: { temperature: 0.86, max_tokens: 300 },
    }[routeDecision.type] || { temperature: 0.82, max_tokens: 300 };

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

    return stripToPlainText(getCompletionText(response));
}

async function rewriteStyleReply({ openai, routeDecision, draftText, diary, mood }) {
    const cleanDraft = stripToPlainText(draftText);
    if (!cleanDraft) {
        return '';
    }

    if (!routeDecision.shouldUseStyleRewrite || !hasAiClient(openai)) {
        return sanitizeTelegramHtml(cleanDraft);
    }

    const response = await openai.chat.completions.create({
        model: getChatModelName(true),
        messages: [
            {
                role: 'system',
                content: [
                    `你是由乃的风格层，只负责把草稿改写成 Telegram 私聊里更像由乃的说法。`,
                    `保留原意，不要新增事实，不要改变结论。`,
                    `当前情绪模式：${mood.tag}。`,
                    `称呼用户时优先使用：${getPreferredDisplayName(diary)}。`,
                    '输出 3 到 4 句中文，可以使用 <i>*动作*</i> 和 <b>重点</b>，但不要全篇都加粗。',
                    '不要输出 SAVE_MEMORY、YUNO_OBSESS 或 JSON。',
                ].join('\n'),
            },
            {
                role: 'user',
                content: cleanDraft,
            },
        ],
        max_tokens: 320,
        temperature: 0.8,
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
        },
        memories: [],
    };

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
    if (preferredName) {
        result.profileUpdates.preferredName = preferredName[1].trim();
        pushMemory('profile', '资料_称呼偏好', `希望被叫作${preferredName[1].trim()}`, 0.9);
    }

    const dislikedName = source.match(/(?:别叫我|不要叫我|我不喜欢被叫)([^\s，。！？?]{1,12})/u);
    if (dislikedName) {
        result.profileUpdates.boundaries.push(`不喜欢被叫${dislikedName[1].trim()}`);
        pushMemory('boundary', '边界_称呼', `不喜欢被叫${dislikedName[1].trim()}`, 0.88);
    }

    const birthday = source.match(/(?:我生日是|生日是)(\d{1,2}-\d{1,2})/u);
    if (birthday) {
        result.profileUpdates.birthday = birthday[1];
        pushMemory('profile', '资料_生日', birthday[1], 0.95);
    }

    const likes = source.match(/我喜欢([^，。！？?]{1,24})/u);
    if (likes) {
        pushMemory('preference', '偏好_喜好', likes[1], 0.72);
    }

    const dislikes = source.match(/(?:我不喜欢|我讨厌)([^，。！？?]{1,24})/u);
    if (dislikes) {
        result.profileUpdates.boundaries.push(`不喜欢${dislikes[1].trim()}`);
        pushMemory('boundary', '边界_不喜欢', dislikes[1], 0.78);
    }

    const topics = source.match(/(?:我常聊|我平时都聊|我最近总在聊)([^，。！？?]{1,24})/u);
    if (topics) {
        result.profileUpdates.topics.push(topics[1].trim());
        pushMemory('topic', '话题_常聊', topics[1], 0.68);
    }

    const roleplay = source.match(/(?:记住这个设定|角色设定[:：]|设定里)([^。！？\n]{1,40})/u);
    if (roleplay) {
        pushMemory('roleplay', '设定_长期', roleplay[1], 0.84);
    }

    const event = source.match(/(?:我养了|我家有|我在)([^，。！？?]{1,30})/u);
    if (event && source.length > 6) {
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
                        '只保留这些类型：称呼偏好、语气偏好、喜欢/不喜欢、常聊话题、长期设定、重要生活事件、生日。',
                        '不要记录一时情绪、普通寒暄、当前一句抱怨。',
                        '输出严格 JSON，结构为 {"profileUpdates":{"preferredName":"","preferredTone":"","birthday":"","topics":[],"boundaries":[]},"memories":[{"category":"","key":"","value":"","weight":0.7}]}。',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: normalizedMessage.text,
                },
            ],
            max_tokens: 280,
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
                preferredTone: stripToPlainText(profileUpdates.preferredTone || ''),
                birthday: stripToPlainText(profileUpdates.birthday || heuristic.profileUpdates.birthday),
                topics: Array.isArray(profileUpdates.topics) ? profileUpdates.topics.map(stripToPlainText).filter(Boolean) : heuristic.profileUpdates.topics,
                boundaries: Array.isArray(profileUpdates.boundaries) ? profileUpdates.boundaries.map(stripToPlainText).filter(Boolean) : heuristic.profileUpdates.boundaries,
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
        console.warn(`memory extraction fallback: ${error.message}`);
        return heuristic;
    }
}

function mergeUniqueStrings(values, additions, limit = 8) {
    const merged = new Set((values || []).map((value) => String(value)));
    for (const item of additions || []) {
        const text = stripToPlainText(item);
        if (!text) {
            continue;
        }
        merged.add(text);
        if (merged.size >= limit) {
            break;
        }
    }
    return [...merged].slice(0, limit);
}

function applyExtractedMemories(diary, extracted) {
    if (!extracted) {
        return;
    }

    const profile = diary.profile || {};
    const profileUpdates = extracted.profileUpdates || {};

    if (profileUpdates.preferredName) {
        profile.preferredName = profileUpdates.preferredName;
    }

    if (profileUpdates.preferredTone) {
        profile.preferredTone = profileUpdates.preferredTone;
    }

    if (profileUpdates.birthday) {
        setBirthday(diary, profileUpdates.birthday);
    }

    profile.topics = mergeUniqueStrings(profile.topics, profileUpdates.topics);
    profile.boundaries = mergeUniqueStrings(profile.boundaries, profileUpdates.boundaries);
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
    const summary = [
        diary.session?.threadSummary ? `已有摘要：${diary.session.threadSummary}` : '',
        `最新用户输入：${normalizedMessage.text}`,
        recentUserTurns.length > 0 ? `近期话题：${recentUserTurns.join('；')}` : '',
        memoryHighlights.length > 0 ? `稳定信息：${memoryHighlights.join('；')}` : '',
        `当前情绪模式：${mood.tag}，重点是继续承接用户正在谈的话题。`,
        assistantText ? `刚刚的回复方向：${stripToPlainText(assistantText).slice(0, 60)}` : '',
    ]
        .filter(Boolean)
        .join(' ');

    return summary.slice(0, 240);
}

async function refreshThreadSummary({ openai, diary, normalizedMessage, assistantText, mood }) {
    if (!hasAiClient(openai)) {
        return buildThreadSummaryFallback({ diary, normalizedMessage, assistantText, mood });
    }

    const recentTranscript = (diary.session?.recentTurns || [])
        .slice(-MAX_CHAT_HISTORY)
        .map((turn) => `${turn.role === 'assistant' ? '由乃' : '用户'}：${turn.content}`)
        .join('\n');

    try {
        const response = await openai.chat.completions.create({
            model: getChatModelName(true),
            messages: [
                {
                    role: 'system',
                    content: [
                        '你是线程摘要器。',
                        '把对话概括成 180 到 260 个中文字符，只保留事实、关系变化、未完成话题和当前情绪。',
                        '不要写文风修辞，不要使用 HTML，不要写成对话。',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: [
                        diary.session?.threadSummary ? `已有摘要：${diary.session.threadSummary}` : '暂无已有摘要。',
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
        console.warn(`summary fallback: ${error.message}`);
        return buildThreadSummaryFallback({ diary, normalizedMessage, assistantText, mood });
    }
}

function buildObsessionNote({ diary, normalizedMessage, routeDecision, mood }) {
    const displayName = getPreferredDisplayName(diary);
    if ([ROUTE_TYPES.MEMORY_UPDATE_ONLY].includes(routeDecision.type)) {
        return `${displayName}刚才把稳定偏好说出来了，要记住。`;
    }
    if (['DARK', 'MANIC'].includes(mood.tag)) {
        return `${displayName}现在的状态有点紧，由乃想继续看着这段对话。`;
    }
    if (routeDecision.type === ROUTE_TYPES.EMOTION_SUPPORT) {
        return `${displayName}把情绪递过来了，这次要接得更稳一点。`;
    }
    if (/爱你|喜欢你|想你/u.test(normalizedMessage.text)) {
        return `${displayName}主动靠近了一点，这句话值得留着。`;
    }
    return '';
}

async function persistConversationState({ openai, diary, normalizedMessage, assistantText, routeDecision, mood }) {
    ensureDiaryState(diary);

    const userTurn = {
        role: 'user',
        content: stripToPlainText(normalizedMessage.text),
        timestamp: new Date(normalizedMessage.timestamp * 1000),
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

    if (nextTurns.length > MAX_CHAT_HISTORY || diary.session.turnsSinceSummary >= SUMMARY_TRIGGER_TURNS) {
        diary.session.threadSummary = await refreshThreadSummary({
            openai,
            diary,
            normalizedMessage,
            assistantText,
            mood,
        });
        diary.session.turnsSinceSummary = 0;
    }

    const extracted = routeDecision.shouldExtractMemory
        ? await extractStableMemories({ openai, normalizedMessage, routeDecision })
        : null;
    applyExtractedMemories(diary, extracted);

    const obsession = buildObsessionNote({ diary, normalizedMessage, routeDecision, mood });
    if (obsession) {
        recordObsession(diary, obsession);
    }

    touchDiary(diary);
    syncDiaryCompatibilityFields(diary);
    await diary.save();
}

async function orchestrateMessage({ openai, diary, normalizedMessage }) {
    ensureDiaryState(diary);

    applyEmotionDelta(diary, normalizedMessage.text);
    const mood = updateMoodState(diary, normalizedMessage.text);
    const routeDecision = decideRoute(normalizedMessage, diary);
    const relevantMemories = selectRelevantMemories(
        getVisibleMemoryEntries(diary),
        normalizedMessage.text
    );
    const knowledgeChunks = routeDecision.shouldSearchKnowledge
        ? await searchKnowledge({
            openai,
            query: normalizedMessage.text,
            platformScope: 'telegram_private',
            limit: 3,
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

    const displayName = getPreferredDisplayName(diary);
    let finalText = '';

    try {
        const draftText = await generateDraftReply({
            openai,
            routeDecision,
            context,
            normalizedMessage,
        });
        finalText = await rewriteStyleReply({
            openai,
            routeDecision,
            draftText,
            diary,
            mood,
        });
    } catch (error) {
        console.error('message orchestration failed:', error);
    }

    if (!finalText) {
        finalText = buildFallbackReply(displayName, mood.tag, routeDecision.type);
    }

    finalText = sanitizeTelegramHtml(stripHiddenDirectives(finalText));

    return {
        text: finalText,
        moodTag: mood.tag,
        routeDecision,
        keyboard: buildKeyboard(mood.tag),
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
    const memories = getVisibleMemoryEntries(diary).slice(0, 3);
    const summary = diary.session?.threadSummary || '暂无线程摘要。';
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
                    `线程摘要：${summary}`,
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
    orchestrateMessage,
    buildDiaryEntry,
    persistConversationState,
};
