const ROUTE_TYPES = {
    COMMAND: 'command',
    COLD_START: 'cold_start',
    FOLLOW_UP: 'follow_up',
    KNOWLEDGE_QA: 'knowledge_qa',
    EMOTION_SUPPORT: 'emotion_support',
    GENERAL_CHAT: 'general_chat',
    MEMORY_UPDATE_ONLY: 'memory_update_only',
};

const COLD_START_PATTERNS = [
    /^(无聊+|在吗|你在吗|你会什么|不知道聊啥|不知道聊什么|聊点什么|说点什么|不知道说啥)$/u,
    /(好无聊|陪我聊|来点话题)/u,
];

const KNOWLEDGE_PATTERNS = [
    /(设定|世界观|规则|口癖|人设|你是谁|介绍一下你自己|你会什么|你记得什么|还记得我|还记不记得我)/u,
    /(为什么这么说|根据什么|你是怎么想的)/u,
];

const EMOTION_PATTERNS = [
    /(难过|委屈|烦|累|崩溃|想哭|孤单|焦虑|害怕|难受|心情不好|压力好大|失眠|不舒服)/u,
    /(我好烦|我不想活|我撑不住|我受不了)/u,
];

const FOLLOW_UP_PATTERNS = [
    /^(然后呢|后来呢|那你呢|你呢|为什么|真的|继续|还有|所以呢|再然后|嗯|好吧|是吗)$/u,
    /^(那|然后|所以|再说说)/u,
];

const MEMORY_PATTERNS = [
    /(以后叫我|你可以叫我|别叫我|不要叫我|我更喜欢你叫我|我不喜欢被叫)/u,
    /(我喜欢|我不喜欢|我讨厌|我常聊|我平时都|我是.+?党|我更偏向)/u,
    /(我来自|我住在|我生日是|我养了|我是.+?(?:学生|老师|程序员|设计师))/u,
    /(角色扮演|设定里|长期设定|记住这个设定)/u,
];

function decideRoute(normalizedMessage, diary) {
    const text = String(normalizedMessage?.text || '').trim();
    const recentTurns = diary?.session?.recentTurns || [];
    const hasHistory = recentTurns.length > 0 || Boolean(diary?.session?.threadSummary);

    let type = ROUTE_TYPES.GENERAL_CHAT;

    if (COLD_START_PATTERNS.some((pattern) => pattern.test(text))) {
        type = ROUTE_TYPES.COLD_START;
    } else if (KNOWLEDGE_PATTERNS.some((pattern) => pattern.test(text))) {
        type = ROUTE_TYPES.KNOWLEDGE_QA;
    } else if (EMOTION_PATTERNS.some((pattern) => pattern.test(text))) {
        type = ROUTE_TYPES.EMOTION_SUPPORT;
    } else if (MEMORY_PATTERNS.some((pattern) => pattern.test(text)) && !/[？?]/u.test(text)) {
        type = ROUTE_TYPES.MEMORY_UPDATE_ONLY;
    } else if (hasHistory && (FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(text)) || text.length <= 10)) {
        type = ROUTE_TYPES.FOLLOW_UP;
    }

    return {
        type,
        shouldSearchKnowledge: type === ROUTE_TYPES.KNOWLEDGE_QA,
        shouldUseStyleRewrite: ![ROUTE_TYPES.KNOWLEDGE_QA, ROUTE_TYPES.COMMAND].includes(type),
        shouldExtractMemory: type !== ROUTE_TYPES.COMMAND,
        shouldPromptQuestion: [ROUTE_TYPES.COLD_START, ROUTE_TYPES.EMOTION_SUPPORT].includes(type),
    };
}

module.exports = {
    ROUTE_TYPES,
    decideRoute,
};
