const fs = require('node:fs');
const path = require('node:path');

const { buildSearchTokens } = require('./utils');

const DEFAULT_KNOWLEDGE_CHUNKS = [
    {
        id: 'persona-yuno-core',
        text: '由乃是私聊陪伴型角色，表达会贴近《未来日记》里我妻由乃的在意感、依赖感和专注度，但默认保持温柔、克制，不输出直白暴力、伤害第三者或违法威胁。',
        sourceType: 'persona',
        topic: '核心人设',
        tone: 'intimate',
        priority: 10,
        platformScope: 'telegram_private',
        tags: ['由乃', '人设', '陪伴'],
        sourceRef: 'builtin/persona',
    },
    {
        id: 'rules-private-chat',
        text: 'Telegram 私聊回复优先 3 到 4 句，允许动作描写和轻微黏人语气，重点是接话、追问、延续情绪，不做大段说教。知识回答优先简洁准确，其次才是人设风格。',
        sourceType: 'rules',
        topic: '私聊策略',
        tone: 'supportive',
        priority: 9,
        platformScope: 'telegram_private',
        tags: ['私聊', '策略', '回复长度'],
        sourceRef: 'builtin/rules',
    },
    {
        id: 'faq-memory',
        text: '这个 bot 会保留短期摘要和长期记忆。长期记忆只记录稳定信息，例如称呼偏好、喜欢和不喜欢的话题、长期设定、生日、重要生活事件，不会把普通闲聊都长期保存。',
        sourceType: 'faq',
        topic: '记忆机制',
        tone: 'neutral',
        priority: 8,
        platformScope: 'telegram_private',
        tags: ['记忆', '偏好', '生日'],
        sourceRef: 'builtin/faq',
    },
    {
        id: 'dialogue-cold-start',
        text: '当用户说“无聊”“在吗”“不知道聊什么”时，可以从日常、小互动、兴趣选择题、轻度测试题切入，并在结尾抛一个容易回答的小问题，把对话接下去。',
        sourceType: 'dialogue',
        topic: '冷启动',
        tone: 'playful',
        priority: 7,
        platformScope: 'telegram_private',
        tags: ['冷启动', '追问', '话题树'],
        sourceRef: 'builtin/dialogue',
    },
];

function getKnowledgeFilePath() {
    const fromEnv = process.env.KNOWLEDGE_FILE;
    if (fromEnv) {
        return path.resolve(fromEnv);
    }
    return path.join(process.cwd(), 'knowledge', 'seed.json');
}

function loadKnowledgeCorpus() {
    const chunks = [...DEFAULT_KNOWLEDGE_CHUNKS];
    const knowledgeFile = getKnowledgeFilePath();

    if (!fs.existsSync(knowledgeFile)) {
        return dedupeKnowledgeChunks(chunks);
    }

    try {
        const raw = fs.readFileSync(knowledgeFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            chunks.push(...parsed);
        }
    } catch (error) {
        console.warn(`knowledge corpus load failed: ${error.message}`);
    }

    return dedupeKnowledgeChunks(chunks);
}

function dedupeKnowledgeChunks(chunks) {
    const seen = new Set();
    const result = [];

    for (const chunk of chunks || []) {
        const normalized = normalizeKnowledgeChunk(chunk);
        if (!normalized || seen.has(normalized.id)) {
            continue;
        }
        seen.add(normalized.id);
        result.push(normalized);
    }

    return result;
}

function normalizeKnowledgeChunk(chunk) {
    if (!chunk || typeof chunk !== 'object') {
        return null;
    }

    const text = String(chunk.text || '').trim();
    if (!text) {
        return null;
    }

    return {
        id: String(chunk.id || `chunk_${Buffer.from(text).toString('base64url').slice(0, 16)}`),
        text,
        sourceType: ['persona', 'rules', 'faq', 'dialogue'].includes(chunk.sourceType) ? chunk.sourceType : 'faq',
        topic: String(chunk.topic || ''),
        tone: String(chunk.tone || ''),
        priority: Number(chunk.priority || 0),
        platformScope: String(chunk.platformScope || 'global'),
        tags: Array.isArray(chunk.tags) ? chunk.tags.map((tag) => String(tag)) : [],
        sourceRef: String(chunk.sourceRef || ''),
    };
}

function scoreChunkLexically(chunk, query, platformScope) {
    const tokens = buildSearchTokens(query);
    if (tokens.length === 0) {
        return null;
    }

    const scope = String(chunk.platformScope || 'global');
    if (![platformScope, 'global', 'telegram_private'].includes(scope)) {
        return null;
    }

    const haystack = [
        chunk.text,
        chunk.topic,
        chunk.tone,
        ...(chunk.tags || []),
        chunk.sourceType,
    ].join(' ').toLowerCase();

    let score = Number(chunk.priority || 0);
    for (const token of tokens) {
        if (haystack.includes(token)) {
            score += 3;
        }
        if (chunk.topic && chunk.topic.toLowerCase().includes(token)) {
            score += 2;
        }
        if ((chunk.tags || []).some((tag) => String(tag).toLowerCase().includes(token))) {
            score += 2;
        }
    }

    if (score <= Number(chunk.priority || 0)) {
        return null;
    }

    return {
        ...chunk,
        score,
    };
}

function rerankKnowledgeChunks(chunks, query, limit = 3) {
    const tokens = buildSearchTokens(query);
    const sorted = [...(chunks || [])]
        .map((chunk) => {
            let bonus = 0;
            for (const token of tokens) {
                if (chunk.text.toLowerCase().includes(token)) {
                    bonus += 1.5;
                }
            }
            return {
                ...chunk,
                score: Number(chunk.score || 0) + bonus,
            };
        })
        .sort((left, right) => right.score - left.score);

    const selected = [];
    let dialogueCount = 0;

    for (const chunk of sorted) {
        if (chunk.sourceType === 'dialogue' && dialogueCount >= 2) {
            continue;
        }
        selected.push(chunk);
        if (chunk.sourceType === 'dialogue') {
            dialogueCount += 1;
        }
        if (selected.length >= limit) {
            break;
        }
    }

    return selected;
}

async function createEmbedding(openai, text) {
    if (!openai || !process.env.QDRANT_URL) {
        return null;
    }

    const model = process.env.EMBEDDING_MODEL_NAME || process.env.AI_EMBEDDING_MODEL || 'text-embedding-3-small';
    const response = await openai.embeddings.create({
        model,
        input: text,
    });

    return response?.data?.[0]?.embedding || null;
}

async function searchQdrant(openai, query, platformScope, limit = 6) {
    if (!process.env.QDRANT_URL) {
        return [];
    }

    const vector = await createEmbedding(openai, query);
    if (!vector) {
        return [];
    }

    const baseUrl = process.env.QDRANT_URL.replace(/\/+$/, '');
    const collection = process.env.QDRANT_COLLECTION || 'telegram_bot_knowledge';
    const response = await fetch(`${baseUrl}/collections/${collection}/points/search`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {}),
        },
        body: JSON.stringify({
            vector,
            limit,
            with_payload: true,
            filter: {
                should: [
                    { key: 'platformScope', match: { value: platformScope } },
                    { key: 'platformScope', match: { value: 'global' } },
                ],
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`Qdrant search failed with ${response.status}`);
    }

    const payload = await response.json();
    const points = Array.isArray(payload.result) ? payload.result : [];

    return points
        .map((point) => normalizeKnowledgeChunk({
            id: point.id,
            ...point.payload,
            score: point.score,
        }))
        .filter(Boolean)
        .map((chunk, index) => ({
            ...chunk,
            score: Number(points[index]?.score || 0),
        }));
}

function searchKnowledgeLocally(query, platformScope, limit = 6) {
    const corpus = loadKnowledgeCorpus();
    return corpus
        .map((chunk) => scoreChunkLexically(chunk, query, platformScope))
        .filter(Boolean)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
}

async function searchKnowledge({ openai, query, platformScope = 'telegram_private', limit = 3 }) {
    if (!String(query || '').trim()) {
        return [];
    }

    try {
        const qdrantMatches = await searchQdrant(openai, query, platformScope, 6);
        if (qdrantMatches.length > 0) {
            return rerankKnowledgeChunks(qdrantMatches, query, limit);
        }
    } catch (error) {
        console.warn(`Qdrant search unavailable, falling back to local corpus: ${error.message}`);
    }

    return rerankKnowledgeChunks(searchKnowledgeLocally(query, platformScope, 6), query, limit);
}

async function syncKnowledgeCorpus(openai) {
    if (!process.env.QDRANT_URL) {
        throw new Error('QDRANT_URL is not configured');
    }

    const corpus = loadKnowledgeCorpus();
    const points = [];

    for (const chunk of corpus) {
        const vector = await createEmbedding(openai, chunk.text);
        if (!vector) {
            continue;
        }
        points.push({
            id: chunk.id,
            vector,
            payload: {
                text: chunk.text,
                sourceType: chunk.sourceType,
                topic: chunk.topic,
                tone: chunk.tone,
                priority: chunk.priority,
                platformScope: chunk.platformScope,
                tags: chunk.tags,
                sourceRef: chunk.sourceRef,
            },
        });
    }

    const baseUrl = process.env.QDRANT_URL.replace(/\/+$/, '');
    const collection = process.env.QDRANT_COLLECTION || 'telegram_bot_knowledge';
    const response = await fetch(`${baseUrl}/collections/${collection}/points?wait=true`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            ...(process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {}),
        },
        body: JSON.stringify({ points }),
    });

    if (!response.ok) {
        throw new Error(`Qdrant upsert failed with ${response.status}`);
    }

    return {
        synced: points.length,
    };
}

module.exports = {
    DEFAULT_KNOWLEDGE_CHUNKS,
    loadKnowledgeCorpus,
    rerankKnowledgeChunks,
    searchKnowledge,
    searchKnowledgeLocally,
    syncKnowledgeCorpus,
};
