const assert = require('node:assert/strict');

require('./test/utils.test.js');

const { normalizeTelegramMessage } = require('./src/adapter');
const { decideRoute } = require('./src/routing');
const {
    buildConversationContext,
    buildThreadSummaryFallback,
    extractStableMemoriesHeuristically,
    persistConversationState,
} = require('./src/orchestrator');
const {
    buildRetrievalQuery,
    loadKnowledgeCorpus,
    rerankKnowledgeChunks,
    searchKnowledge,
} = require('./src/rag');
const { ensureDiaryState } = require('./src/utils');
const {
    buildPersonalizedScheduledMessage,
    shouldSendScheduledMessage,
} = require('./src/personalization');

let failures = 0;

async function runTest(name, fn) {
    try {
        await fn();
        console.log(`PASS ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL ${name}`);
        console.error(error);
    }
}

function createDiary(overrides = {}) {
    const diary = {
        chatId: 'chat-1',
        affection: 50,
        darkness: 10,
        records: new Map(),
        chatHistory: [],
        lastActiveAt: new Date('2026-03-20T10:00:00.000Z'),
        nickname: '你',
        profile: null,
        emotionState: null,
        session: null,
        longTermMemories: [],
        legacyRecords: new Map(),
        markModified() {},
        async save() {},
        ...overrides,
    };

    ensureDiaryState(diary);
    return diary;
}

async function main() {
    await runTest('normalizeTelegramMessage provides stable defaults', async () => {
        const normalized = normalizeTelegramMessage({
            chat: { id: 123, type: 'private' },
            from: { id: 456, first_name: '阿澈' },
            message: { message_id: 789, text: '你好', date: 1700000000 },
            botInfo: { username: 'demo_bot' },
        });

        assert.equal(normalized.platform, 'telegram');
        assert.equal(normalized.chat_type, 'private');
        assert.equal(normalized.chat_id, '123');
        assert.equal(normalized.user_id, '456');
        assert.equal(normalized.user_name, '阿澈');
        assert.equal(normalized.message_id, '789');
        assert.equal(normalized.reply_to, '');
        assert.equal(normalized.mentions_bot, true);
        assert.deepEqual(normalized.attachments, []);
    });

    await runTest('decideRoute classifies cold start, knowledge, follow-up and emotion support', async () => {
        const diary = createDiary();
        diary.session.threadSummary = '你们刚聊过今天的安排。';
        diary.session.recentTurns = [
            { role: 'user', content: '今天有点乱', timestamp: new Date() },
            { role: 'assistant', content: '我在听。', timestamp: new Date() },
        ];

        assert.equal(decideRoute({ text: '无聊', platform: 'telegram', chat_type: 'private' }, diary).type, 'cold_start');
        assert.equal(decideRoute({ text: '你的设定是什么', platform: 'telegram', chat_type: 'private' }, diary).type, 'knowledge_qa');
        assert.equal(decideRoute({ text: '然后呢', platform: 'telegram', chat_type: 'private' }, diary).type, 'follow_up');
        assert.equal(decideRoute({ text: '我今天真的很难受', platform: 'telegram', chat_type: 'private' }, diary).type, 'emotion_support');
    });

    await runTest('buildConversationContext keeps the section order stable', async () => {
        const diary = createDiary({
            profile: {
                nickname: '阿澈',
                preferredName: '阿澈',
                preferredTone: '更轻一点',
                topics: ['技术', '动画'],
                boundaries: ['不喜欢被叫宝宝'],
                interests: ['抹茶拿铁', '动画'],
                commonEmoji: ['✨', '🤍'],
                greetingStyle: '温柔一点',
                pushPreference: '主动一点',
                birthday: '3-15',
            },
            longTermMemories: [
                { category: 'preference', key: '偏好_饮料', value: '喜欢抹茶拿铁', source: 'test', lastConfirmed: new Date(), weight: 0.8 },
            ],
        });
        ensureDiaryState(diary);
        const context = buildConversationContext({
            diary,
            normalizedMessage: {
                platform: 'telegram',
                chat_type: 'private',
                text: '你还记得我喜欢什么吗',
            },
            routeDecision: { type: 'knowledge_qa' },
            relevantMemories: [{ key: '偏好_饮料', value: '喜欢抹茶拿铁' }],
            knowledgeChunks: [{ sourceType: 'faq', text: '长期记忆只记录稳定信息。' }],
            mood: { tag: 'NORMAL', desc: '状态平稳。' },
        });

        const titles = context.sections.map((section) => section.title);
        assert.deepEqual(titles.slice(0, 8), [
            '系统人格设定',
            '平台上下文',
            '用户画像',
            '线程摘要',
            '最近 8 轮原始消息',
            '命中的长期记忆',
            '命中的知识片段',
            '当前用户输入',
        ]);
        assert.match(context.systemPrompt, /### 系统人格设定[\s\S]*### 平台上下文[\s\S]*### 用户画像/);
        assert.match(context.systemPrompt, /兴趣偏好：抹茶拿铁、动画/);
        assert.match(context.systemPrompt, /常用表情：✨ 🤍/);
        assert.match(context.systemPrompt, /问候风格：温柔一点/);
    });

    await runTest('persistConversationState refreshes summary and keeps only the latest eight turns', async () => {
        const diary = createDiary();
        diary.session.threadSummary = '已有摘要：你们聊过近况。';
        diary.session.turnsSinceSummary = 5;
        diary.session.recentTurns = [
            { role: 'user', content: '1', timestamp: new Date() },
            { role: 'assistant', content: '2', timestamp: new Date() },
            { role: 'user', content: '3', timestamp: new Date() },
            { role: 'assistant', content: '4', timestamp: new Date() },
            { role: 'user', content: '5', timestamp: new Date() },
            { role: 'assistant', content: '6', timestamp: new Date() },
            { role: 'user', content: '7', timestamp: new Date() },
            { role: 'assistant', content: '8', timestamp: new Date() },
        ];

        await persistConversationState({
            openai: null,
            diary,
            normalizedMessage: {
                text: '以后叫我阿澈，我不喜欢被叫宝宝。',
                timestamp: 1710000000,
            },
            assistantText: '好，我会记住这件事，也会更小心地叫你。',
            routeDecision: { type: 'memory_update_only', shouldExtractMemory: true },
            mood: { tag: 'NORMAL', desc: '状态平稳。' },
        });

        assert.equal(diary.session.recentTurns.length, 8);
        assert.equal(diary.session.turnsSinceSummary, 0);
        assert.ok(typeof diary.session.threadSummary === 'string');
        assert.ok(diary.session.threadSummary.length > 0);
    });

    await runTest('extractStableMemoriesHeuristically ignores temporary emotions and keeps stable preferences', async () => {
        const extracted = extractStableMemoriesHeuristically('以后叫我阿澈，我不喜欢被叫宝宝。我喜欢抹茶拿铁。');

        assert.equal(extracted.profileUpdates.preferredName, '阿澈');
        assert.match(extracted.profileUpdates.boundaries.join('；'), /不喜欢被叫宝宝/);
        assert.ok(extracted.memories.some((memory) => memory.category === 'preference' && /抹茶拿铁/.test(memory.value)));

        const temporary = extractStableMemoriesHeuristically('我今天有点累。');
        assert.equal(temporary.memories.length, 0);
    });

    await runTest('buildThreadSummaryFallback strips html noise', async () => {
        const diary = createDiary();
        const summary = buildThreadSummaryFallback({
            diary,
            normalizedMessage: { text: '今天真的有点乱' },
            assistantText: '<i>*轻轻看着你*</i> 我会接住这句话。',
            mood: { tag: 'TENDER', desc: '温柔。' },
        });

        assert.doesNotMatch(summary, /<i>/);
        assert.match(summary, /最新用户输入/);
    });

    await runTest('searchKnowledge falls back to local corpus without qdrant', async () => {
        const results = await searchKnowledge({
            openai: null,
            diary: createDiary({
                session: {
                    recentTurns: [
                        { role: 'user', content: '你会记住什么', timestamp: new Date() },
                    ],
                    threadSummary: '你们刚聊过 bot 的记忆和上下文组织方式。',
                },
            }),
            normalizedMessage: {
                text: '你们现在是怎么组织上下文的',
            },
            routeDecision: {
                type: 'knowledge_qa',
            },
            platformScope: 'telegram_private',
            limit: 3,
        });

        assert.ok(results.length > 0);
        assert.ok(results.some((chunk) => ['persona', 'rules', 'faq'].includes(chunk.sourceType)));
    });

    await runTest('loadKnowledgeCorpus loads expanded seed metadata', async () => {
        const corpus = loadKnowledgeCorpus();

        assert.ok(corpus.length >= 20);
        assert.ok(corpus.some((chunk) => chunk.sourceType === 'feature'));
        assert.ok(corpus.some((chunk) => chunk.sourceType === 'notice'));
        assert.ok(corpus.some((chunk) => Array.isArray(chunk.tags) && chunk.tags.length > 0));
    });

    await runTest('buildRetrievalQuery combines input, summary, recent user turns and route type', async () => {
        const diary = createDiary();
        diary.session.threadSummary = '你们在讨论 bot 的长期记忆和检索。';
        diary.session.recentTurns = [
            { role: 'user', content: '它会联网吗', timestamp: new Date() },
            { role: 'assistant', content: '必要时会补远程网页。', timestamp: new Date() },
            { role: 'user', content: '那长期记忆存在哪里', timestamp: new Date() },
        ];

        const query = buildRetrievalQuery({
            diary,
            normalizedMessage: { text: '所以 Qdrant 是拿来干什么的' },
            routeDecision: { type: 'knowledge_qa' },
        });

        assert.match(query, /Qdrant/);
        assert.match(query, /长期记忆/);
        assert.match(query, /route:knowledge_qa/);
    });

    await runTest('rerankKnowledgeChunks applies mmr-style dedupe and dialogue cap', async () => {
        const ranked = rerankKnowledgeChunks([
            { id: 'a', text: '记忆机制会记录稳定偏好和生日。', sourceType: 'faq', score: 20 },
            { id: 'b', text: '记忆机制会记录稳定偏好和生日。', sourceType: 'faq', score: 19 },
            { id: 'c', text: '冷启动时可以给一个二选一问题。', sourceType: 'dialogue', score: 18 },
            { id: 'd', text: '冷启动时可以给一个轻量互动题。', sourceType: 'dialogue', score: 17.5 },
            { id: 'e', text: 'Qdrant 只负责知识检索，不存长期记忆。', sourceType: 'faq', score: 18.5 },
        ], 'Qdrant 长期记忆 冷启动', 4);

        assert.ok(ranked.length <= 4);
        assert.ok(ranked.filter((chunk) => chunk.sourceType === 'dialogue').length <= 1);
        assert.ok(ranked.some((chunk) => chunk.id === 'a'));
        assert.ok(!ranked.every((chunk) => ['a', 'b'].includes(chunk.id)));
    });

    await runTest('knowledge search supplements with remote documents when local confidence is low', async () => {
        const oldSearchApiUrl = process.env.SEARCH_API_URL;
        const oldLocalThreshold = process.env.LOCAL_LOW_SCORE_THRESHOLD;
        const originalFetch = global.fetch;

        process.env.SEARCH_API_URL = 'https://example.test/search?q={query}';
        process.env.LOCAL_LOW_SCORE_THRESHOLD = '999';

        /** @type {typeof global.fetch} */
        const mockedFetch = async (url) => {
            if (String(url).startsWith('https://example.test/search')) {
                return /** @type {Response} */ ({
                    ok: true,
                    async json() {
                        return {
                            results: [
                                {
                                    url: 'https://docs.example.test/bot-memory',
                                    title: 'Bot Memory',
                                    snippet: 'bot memory and remote search',
                                },
                            ],
                        };
                    },
                });
            }

            return /** @type {Response} */ ({
                ok: true,
                async text() {
                    return '<html><head><title>Memory Doc</title></head><body>Qdrant 只负责知识检索，用户长期记忆仍保存在 Mongo。远程网页内容只参与当前一轮回答。</body></html>';
                },
            });
        };
        global.fetch = mockedFetch;

        try {
            const results = await searchKnowledge({
                openai: null,
                diary: createDiary(),
                normalizedMessage: {
                    text: 'Qdrant 和长期记忆分别负责什么',
                },
                routeDecision: {
                    type: 'knowledge_qa',
                },
                platformScope: 'telegram_private',
                limit: 4,
            });

            assert.ok(results.some((chunk) => chunk.isRemote));
            assert.ok(results.some((chunk) => /长期记忆/.test(chunk.text)));
        } finally {
            global.fetch = originalFetch;
            if (oldSearchApiUrl === undefined) {
                delete process.env.SEARCH_API_URL;
            } else {
                process.env.SEARCH_API_URL = oldSearchApiUrl;
            }
            if (oldLocalThreshold === undefined) {
                delete process.env.LOCAL_LOW_SCORE_THRESHOLD;
            } else {
                process.env.LOCAL_LOW_SCORE_THRESHOLD = oldLocalThreshold;
            }
        }
    });

    await runTest('personalized scheduled messages use profile interests, emoji and push preference', async () => {
        const diary = createDiary({
            profile: {
                nickname: '阿澈',
                preferredName: '阿澈',
                preferredTone: '',
                topics: [],
                boundaries: [],
                interests: ['抹茶拿铁'],
                commonEmoji: ['✨'],
                greetingStyle: '像叫我起床一样',
                pushPreference: '主动一点',
                birthday: '',
            },
        });

        const morning = buildPersonalizedScheduledMessage(diary, 'morning', '早上好。');
        assert.match(morning, /阿澈/);
        assert.match(morning, /别赖床太久/);
        assert.match(morning, /✨/);

        diary.profile.pushPreference = '别太频繁';
        assert.equal(shouldSendScheduledMessage(diary, 'afternoon'), false);
    });

    await runTest('persistConversationState rolls long summaries into chapter summaries on topic shift', async () => {
        const diary = createDiary();
        diary.session.threadSummary = '你们已经围绕抹茶拿铁和动画聊了很久。'.repeat(14);
        diary.session.lastTopicKey = '抹茶|动画';
        diary.session.summaryVersion = 1;
        diary.session.recentTurns = [
            { role: 'user', content: '我最近老在看动画', timestamp: new Date() },
            { role: 'assistant', content: '你前面也提过这个。', timestamp: new Date() },
        ];

        await persistConversationState({
            openai: null,
            diary,
            normalizedMessage: {
                text: '今天想问 Qdrant 和 Mongo 的区别。',
                timestamp: 1710000300,
            },
            assistantText: 'Qdrant 负责检索，Mongo 负责你的结构化记忆。',
            routeDecision: { type: 'knowledge_qa', shouldExtractMemory: true },
            mood: { tag: 'NORMAL', desc: '状态平稳。' },
        });

        assert.ok(diary.session.chapterSummaries.length >= 1);
        assert.ok(Number(diary.session.summaryVersion) >= 2);
        assert.ok(diary.session.threadSummary.length > 0);
    });

    await runTest('ensureDiaryState migrates legacy records and chat history into structured state', async () => {
        const legacyDiary = createDiary({
            profile: null,
            emotionState: null,
            session: null,
            longTermMemories: [],
            nickname: '旧昵称',
            records: new Map([
                ['生日', '3-15'],
                ['偏好_饮料', '抹茶拿铁'],
            ]),
            chatHistory: [
                { role: 'user', content: '旧消息 1' },
                { role: 'assistant', content: '旧消息 2' },
            ],
        });

        ensureDiaryState(legacyDiary);

        assert.equal(legacyDiary.profile.birthday, '3-15');
        assert.ok(legacyDiary.longTermMemories.some((memory) => memory.key === '偏好_饮料'));
        assert.equal(legacyDiary.session.recentTurns.length, 2);
        assert.equal(legacyDiary.profile.nickname, '旧昵称');
    });

    if (failures > 0 || Number(process.exitCode || 0) > 0) {
        process.exitCode = 1;
    } else {
        console.log('Extended tests passed.');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
