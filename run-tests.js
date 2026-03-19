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
const { searchKnowledge } = require('./src/rag');
const { ensureDiaryState } = require('./src/utils');

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
            query: '你们现在是怎么组织上下文的',
            platformScope: 'telegram_private',
            limit: 3,
        });

        assert.ok(results.length > 0);
        assert.ok(results.some((chunk) => ['persona', 'rules', 'faq'].includes(chunk.sourceType)));
    });

    if (failures > 0 || process.exitCode > 0) {
        process.exitCode = 1;
    } else {
        console.log('Extended tests passed.');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
