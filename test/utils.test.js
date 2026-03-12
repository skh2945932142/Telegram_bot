const assert = require('node:assert/strict');

const {
    parseBirthdayInput,
    stripHiddenDirectives,
    sanitizeTelegramHtml,
    parseModelDirectives,
    selectRelevantMemories,
    getMonthDayInTimezone,
} = require('../src/utils');

let failures = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL ${name}`);
        console.error(error);
    }
}

runTest('parseBirthdayInput accepts valid month-day', () => {
    assert.equal(parseBirthdayInput('3-15'), '3-15');
    assert.equal(parseBirthdayInput('02-29'), '2-29');
});

runTest('parseBirthdayInput rejects invalid values', () => {
    assert.equal(parseBirthdayInput('13-1'), null);
    assert.equal(parseBirthdayInput('2-30'), null);
    assert.equal(parseBirthdayInput('abc'), null);
});

runTest('stripHiddenDirectives removes save and obsess payloads', () => {
    const source = '你好 [SAVE_MEMORY: 偏好_饮料=喜欢抹茶拿铁] [YUNO_OBSESS: 不能忘]';
    assert.equal(stripHiddenDirectives(source), '你好');
});

runTest('sanitizeTelegramHtml keeps allowed tags and escapes unsafe tags', () => {
    const source = '<b>好</b><script>alert(1)</script><i>呀</b>';
    const sanitized = sanitizeTelegramHtml(source);

    assert.match(sanitized, /<b>好<\/b>/);
    assert.match(sanitized, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(sanitized, /<i>呀<\/i>/);
});

runTest('parseModelDirectives extracts memory saves and obsessions', () => {
    const source = [
        '回复内容',
        '[SAVE_MEMORY: 偏好_饮料=喜欢抹茶拿铁]',
        '[SAVE_MEMORY: 事件_散步=昨晚去江边散步]',
        '[YUNO_OBSESS: 她说今晚会回来]',
    ].join('\n');

    const directives = parseModelDirectives(source);

    assert.deepEqual(directives.saves, [
        { key: '偏好_饮料', value: '喜欢抹茶拿铁' },
        { key: '事件_散步', value: '昨晚去江边散步' },
    ]);
    assert.deepEqual(directives.obsessions, ['她说今晚会回来']);
});

runTest('selectRelevantMemories prefers token matches over unrelated items', () => {
    const entries = [
        { key: '事件_考试', value: '上周考完试了' },
        { key: '偏好_饮料', value: '喜欢抹茶拿铁' },
        { key: '关系_猫', value: '家里有一只橘猫' },
    ];

    const selected = selectRelevantMemories(entries, '今天又喝了抹茶拿铁');

    assert.equal(selected.length, 1);
    assert.equal(selected[0].key, '偏好_饮料');
});

runTest('getMonthDayInTimezone follows Asia/Shanghai date boundary', () => {
    const utcDate = new Date('2026-03-12T16:30:00.000Z');
    assert.equal(getMonthDayInTimezone(utcDate, 'Asia/Shanghai'), '3-13');
});

if (failures > 0) {
    process.exitCode = 1;
} else {
    console.log('All tests passed.');
}
