// @ts-check

const fs = require('node:fs');
const path = require('node:path');

const { buildSearchTokens, stripToPlainText } = require('./state/text');
const { getSummaryContextText } = require('./state/diary-store');

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_CACHE_TTL_MS = 20 * 60 * 1000;
const LOCAL_TOP_K = 8;
const INJECT_LIMIT = 4;
const DIALOGUE_LIMIT = 1;
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS || 12000);
const REMOTE_PAGE_MAX_LENGTH = Number(process.env.SEARCH_PAGE_MAX_LENGTH || 6000);
const REMOTE_CHUNK_SIZE = Number(process.env.SEARCH_CHUNK_SIZE || 420);
const REMOTE_CHUNK_OVERLAP = Number(process.env.SEARCH_CHUNK_OVERLAP || 60);
const DEFAULT_REMOTE_SEARCH_TIME_BUDGET_MS = 6000;
const DEFAULT_REMOTE_SEARCH_MAX_PAGES = 2;
const DEFAULT_REMOTE_SEARCH_CONCURRENCY = 2;

/** @type {Map<string, { expiresAt: number, value: any }>} */
const searchCache = new Map();
/** @type {Map<string, { expiresAt: number, value: any }>} */
const pageCache = new Map();

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
        sourceUrl: '',
        syncedAt: '',
        isRemote: false,
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
        sourceUrl: '',
        syncedAt: '',
        isRemote: false,
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
        sourceUrl: '',
        syncedAt: '',
        isRemote: false,
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
        sourceUrl: '',
        syncedAt: '',
        isRemote: false,
    },
];

function getLowConfidenceQdrantScore() {
    return Number(process.env.QDRANT_LOW_SCORE_THRESHOLD || 0.42);
}

function getLowConfidenceLocalScore() {
    return Number(process.env.LOCAL_LOW_SCORE_THRESHOLD || 11);
}

/**
 * @param {string} key
 * @param {Map<string, {expiresAt: number, value: any}>} cache
 */
function readCache(key, cache) {
    const cached = cache.get(key);
    if (!cached) {
        return null;
    }
    if (cached.expiresAt < Date.now()) {
        cache.delete(key);
        return null;
    }
    return cached.value;
}

/**
 * @param {string} key
 * @param {any} value
 * @param {Map<string, {expiresAt: number, value: any}>} cache
 * @param {number} ttlMs
 */
function writeCache(key, value, cache, ttlMs) {
    cache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
    });
}

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

/**
 * @param {Array<Record<string, any>>} chunks
 */
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

/**
 * @param {Record<string, any>} chunk
 */
function normalizeKnowledgeChunk(chunk) {
    if (!chunk || typeof chunk !== 'object') {
        return null;
    }

    const text = stripToPlainText(chunk.text || '');
    if (!text) {
        return null;
    }

    const sourceType = ['persona', 'rules', 'faq', 'dialogue', 'feature', 'notice'].includes(chunk.sourceType)
        ? chunk.sourceType
        : 'faq';

    return {
        id: String(chunk.id || `chunk_${Buffer.from(text).toString('base64url').slice(0, 16)}`),
        text,
        sourceType,
        topic: stripToPlainText(chunk.topic || ''),
        tone: stripToPlainText(chunk.tone || ''),
        priority: Number(chunk.priority || 0),
        platformScope: String(chunk.platformScope || 'global'),
        tags: Array.isArray(chunk.tags) ? chunk.tags.map((tag) => stripToPlainText(String(tag))).filter(Boolean) : [],
        sourceRef: String(chunk.sourceRef || ''),
        sourceUrl: String(chunk.sourceUrl || ''),
        syncedAt: String(chunk.syncedAt || ''),
        isRemote: Boolean(chunk.isRemote),
    };
}

/**
 * @param {{ normalizedMessage?: {text?: string}, diary?: any, routeDecision?: {type?: string} }} input
 */
function buildRetrievalQuery(input) {
    const currentInput = stripToPlainText(input?.normalizedMessage?.text || '');
    const routeType = String(input?.routeDecision?.type || '');
    const summary = input?.diary ? getSummaryContextText(input.diary) : '';
    const recentUserTurns = (input?.diary?.session?.recentTurns || [])
        .filter((turn) => turn.role === 'user')
        .slice(-2)
        .map((turn) => stripToPlainText(turn.content))
        .filter(Boolean);

    return [
        currentInput,
        summary,
        recentUserTurns.join('；'),
        routeType ? `route:${routeType}` : '',
    ].filter(Boolean).join('\n');
}

/**
 * @param {Record<string, any>} chunk
 * @param {string} query
 * @param {string} platformScope
 */
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

/**
 * @param {string} text
 */
function chunkTokens(text) {
    return buildSearchTokens(text).slice(0, 20);
}

/**
 * @param {string} left
 * @param {string} right
 */
function textSimilarity(left, right) {
    const leftTokens = new Set(chunkTokens(left));
    const rightTokens = new Set(chunkTokens(right));
    if (leftTokens.size === 0 || rightTokens.size === 0) {
        return 0;
    }

    let intersection = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) {
            intersection += 1;
        }
    }

    return intersection / Math.max(leftTokens.size, rightTokens.size);
}

/**
 * @param {Array<Record<string, any>>} chunks
 * @param {string} query
 * @param {number} [limit]
 */
function rerankKnowledgeChunks(chunks, query, limit = INJECT_LIMIT) {
    const candidates = [...(chunks || [])].sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
    const selected = [];
    let dialogueCount = 0;

    while (candidates.length > 0 && selected.length < limit) {
        let bestIndex = 0;
        let bestMmrScore = Number.NEGATIVE_INFINITY;

        for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            if (candidate.sourceType === 'dialogue' && dialogueCount >= DIALOGUE_LIMIT) {
                continue;
            }

            const relevance = Number(candidate.score || 0);
            const maxSimilarity = selected.length === 0
                ? 0
                : Math.max(...selected.map((item) => textSimilarity(candidate.text, item.text)));
            const querySimilarity = textSimilarity(candidate.text, query);
            const mmrScore = (0.65 * relevance) + (0.2 * querySimilarity) - (0.35 * maxSimilarity);

            if (mmrScore > bestMmrScore) {
                bestMmrScore = mmrScore;
                bestIndex = index;
            }
        }

        const nextChunk = candidates.splice(bestIndex, 1)[0];
        if (!nextChunk) {
            break;
        }
        if (nextChunk.sourceType === 'dialogue' && dialogueCount >= DIALOGUE_LIMIT) {
            continue;
        }
        if (nextChunk.sourceType === 'dialogue') {
            dialogueCount += 1;
        }
        selected.push(nextChunk);
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

/**
 * @param {any} openai
 * @param {string} query
 * @param {string} platformScope
 * @param {number} limit
 */
async function searchQdrant(openai, query, platformScope, limit = LOCAL_TOP_K) {
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

    /** @type {{ result?: Array<{ id: string, score?: number, payload?: Record<string, any> }> }} */
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

function searchKnowledgeLocally(query, platformScope, limit = LOCAL_TOP_K) {
    const corpus = loadKnowledgeCorpus();
    return corpus
        .map((chunk) => scoreChunkLexically(chunk, query, platformScope))
        .filter(Boolean)
        .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
        .slice(0, limit);
}

function getRemoteSearchUrl(query) {
    const searchApiUrl = process.env.SEARCH_API_URL;
    if (!searchApiUrl) {
        return '';
    }
    if (searchApiUrl.includes('{query}')) {
        return searchApiUrl.replace('{query}', encodeURIComponent(query));
    }

    const separator = searchApiUrl.includes('?') ? '&' : '?';
    return `${searchApiUrl}${separator}q=${encodeURIComponent(query)}`;
}

function buildAbortSignal(timeoutMs) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs);
    }
    return undefined;
}

function toPositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getRemoteSearchTimeBudgetMs() {
    return toPositiveInteger(process.env.REMOTE_SEARCH_TIME_BUDGET_MS, DEFAULT_REMOTE_SEARCH_TIME_BUDGET_MS);
}

function getRemoteSearchMaxPages() {
    return toPositiveInteger(process.env.REMOTE_SEARCH_MAX_PAGES, DEFAULT_REMOTE_SEARCH_MAX_PAGES);
}

function getRemoteSearchConcurrency(maxPages) {
    const configured = toPositiveInteger(process.env.REMOTE_SEARCH_CONCURRENCY, DEFAULT_REMOTE_SEARCH_CONCURRENCY);
    return Math.max(1, Math.min(maxPages, configured));
}

/**
 * @param {any} payload
 */
function extractSearchItems(payload) {
    if (Array.isArray(payload)) {
        return payload;
    }
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    return payload.results || payload.items || payload.data || payload.organic_results || [];
}

/**
 * @param {string} query
 */
async function fetchRemoteSearchResults(query, timeoutMs = SEARCH_TIMEOUT_MS) {
    const cacheKey = `search:${query}`;
    const cached = readCache(cacheKey, searchCache);
    if (cached) {
        return cached;
    }

    const searchUrl = getRemoteSearchUrl(query);
    if (!searchUrl) {
        return [];
    }

    const response = await fetch(searchUrl, {
        headers: {
            Accept: 'application/json,text/plain;q=0.8,*/*;q=0.5',
            ...(process.env.SEARCH_API_KEY ? { Authorization: `Bearer ${process.env.SEARCH_API_KEY}` } : {}),
        },
        signal: buildAbortSignal(timeoutMs),
    });

    if (!response.ok) {
        throw new Error(`remote search failed with ${response.status}`);
    }

    const payload = await response.json();
    const results = extractSearchItems(payload)
        .map((item) => ({
            url: String(item.url || item.link || item.href || ''),
            title: stripToPlainText(item.title || item.name || ''),
            snippet: stripToPlainText(item.snippet || item.description || item.body || ''),
        }))
        .filter((item) => item.url);

    writeCache(cacheKey, results, searchCache, SEARCH_CACHE_TTL_MS);
    return results;
}

/**
 * @param {string} html
 */
function extractHtmlText(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {string} url
 */
async function fetchSearchDocument(url, timeoutMs = SEARCH_TIMEOUT_MS) {
    const cacheKey = `page:${url}`;
    const cached = readCache(cacheKey, pageCache);
    if (cached) {
        return cached;
    }

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'my-telegram-bot/knowledge-fetcher',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: buildAbortSignal(timeoutMs),
    });

    if (!response.ok) {
        throw new Error(`page fetch failed with ${response.status}`);
    }

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = stripToPlainText(titleMatch?.[1] || '');
    const content = extractHtmlText(html).slice(0, REMOTE_PAGE_MAX_LENGTH);
    const document = {
        url,
        title,
        content,
    };

    writeCache(cacheKey, document, pageCache, PAGE_CACHE_TTL_MS);
    return document;
}

/**
 * @param {{ url: string, title: string, content: string }} document
 * @param {string} platformScope
 */
function chunkRemoteDocument(document, platformScope) {
    const chunks = [];
    const content = stripToPlainText(document.content || '');
    if (!content) {
        return [];
    }

    let offset = 0;
    let chunkIndex = 0;
    while (offset < content.length) {
        const text = content.slice(offset, offset + REMOTE_CHUNK_SIZE).trim();
        if (!text) {
            break;
        }
        chunks.push(normalizeKnowledgeChunk({
            id: `remote_${Buffer.from(document.url).toString('base64url').slice(0, 12)}_${chunkIndex}`,
            text,
            sourceType: 'notice',
            topic: document.title || '远程网页',
            tone: 'informative',
            priority: 5,
            platformScope,
            tags: ['remote', 'web'],
            sourceRef: 'remote-search',
            sourceUrl: document.url,
            syncedAt: new Date().toISOString(),
            isRemote: true,
        }));
        offset += Math.max(1, REMOTE_CHUNK_SIZE - REMOTE_CHUNK_OVERLAP);
        chunkIndex += 1;
    }

    return chunks.filter(Boolean);
}

/**
 * @param {string} query
 * @param {string} platformScope
 */
async function searchKnowledgeRemotely(query, platformScope) {
    const budgetMs = getRemoteSearchTimeBudgetMs();
    const maxPages = getRemoteSearchMaxPages();
    const concurrency = getRemoteSearchConcurrency(maxPages);
    const deadline = Date.now() + budgetMs;
    const remainingForSearch = deadline - Date.now();
    if (remainingForSearch <= 0) {
        return [];
    }

    const results = await fetchRemoteSearchResults(query, remainingForSearch);
    const targets = results.slice(0, maxPages);
    /** @type {Array<{ url: string, title: string, content: string }>} */
    const documents = [];
    let cursor = 0;

    const workers = Array.from({ length: concurrency }, async () => {
        while (cursor < targets.length) {
            const index = cursor;
            cursor += 1;
            const result = targets[index];
            if (!result?.url) {
                continue;
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                return;
            }

            try {
                const document = await fetchSearchDocument(result.url, remaining);
                documents.push(document);
            } catch (error) {
                console.warn(`remote page fetch skipped [${result.url}]: ${error.message}`);
            }
        }
    });

    await Promise.all(workers);
    return documents.flatMap((document) => chunkRemoteDocument(document, platformScope));
}

/**
 * @param {Array<Record<string, any>>} matches
 * @param {'qdrant' | 'local'} source
 */
function isLowConfidenceSelection(matches, source) {
    if (!matches || matches.length === 0) {
        return true;
    }

    const topScore = Number(matches[0]?.score || 0);
    if (source === 'qdrant') {
        return topScore < getLowConfidenceQdrantScore();
    }
    return topScore < getLowConfidenceLocalScore();
}

/**
 * @param {{ openai?: any, diary?: any, normalizedMessage?: any, routeDecision?: any, platformScope?: string, limit?: number }} params
 */
async function searchKnowledge(params) {
    const query = buildRetrievalQuery(params);
    const currentInput = stripToPlainText(params?.normalizedMessage?.text || '');
    if (!currentInput) {
        return [];
    }

    const platformScope = params?.platformScope || 'telegram_private';
    let candidates = [];
    let source = 'local';
    let remoteCandidates = [];

    try {
        const qdrantMatches = await searchQdrant(params?.openai, query, platformScope, LOCAL_TOP_K);
        if (qdrantMatches.length > 0) {
            candidates = qdrantMatches;
            source = 'qdrant';
        }
    } catch (error) {
        console.warn(`Qdrant search unavailable, falling back to local corpus: ${error.message}`);
    }

    if (candidates.length === 0) {
        candidates = searchKnowledgeLocally(query, platformScope, LOCAL_TOP_K);
        source = 'local';
    }

    if (
        params?.routeDecision?.type === 'knowledge_qa' &&
        process.env.SEARCH_API_URL &&
        isLowConfidenceSelection(candidates, /** @type {'qdrant'|'local'} */ (source))
    ) {
        try {
            remoteCandidates = (await searchKnowledgeRemotely(query, platformScope))
                .map((chunk) => scoreChunkLexically(chunk, query, platformScope))
                .filter(Boolean);
            candidates = [...candidates, ...remoteCandidates.map((chunk) => ({
                ...chunk,
                score: Number(chunk.score || 0) + 1.5,
            }))];
        } catch (error) {
            console.warn(`remote search unavailable, continuing with local candidates: ${error.message}`);
        }
    }

    const selected = rerankKnowledgeChunks(
        candidates.sort((left, right) => Number(right.score || 0) - Number(left.score || 0)).slice(0, LOCAL_TOP_K + 4),
        query,
        params?.limit || INJECT_LIMIT
    );

    if (remoteCandidates.length > 0 && !selected.some((chunk) => chunk.isRemote)) {
        const bestRemote = remoteCandidates
            .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))[0];
        if (bestRemote) {
            if (selected.length >= (params?.limit || INJECT_LIMIT)) {
                selected[selected.length - 1] = bestRemote;
            } else {
                selected.push(bestRemote);
            }
        }
    }

    return selected;
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
                sourceUrl: chunk.sourceUrl,
                syncedAt: new Date().toISOString(),
                isRemote: false,
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
    buildRetrievalQuery,
    loadKnowledgeCorpus,
    normalizeKnowledgeChunk,
    rerankKnowledgeChunks,
    searchKnowledge,
    searchKnowledgeLocally,
    searchKnowledgeRemotely,
    scoreChunkLexically,
    syncKnowledgeCorpus,
};
