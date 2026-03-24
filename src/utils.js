// @ts-check

const constants = require('./state/constants');
const text = require('./state/text');
const emotion = require('./state/emotion');
const diaryStore = require('./state/diary-store');

const cooldownMap = new Map();
const cooldownNoticeMap = new Map();

module.exports = {
    ...constants,
    ...text,
    ...emotion,
    ...diaryStore,
    cooldownMap,
    cooldownNoticeMap,
};
