// @ts-check

const { escapeHtml } = require('./state/text');
const { ensureDiaryState, getPreferredDisplayName } = require('./state/diary-store');

/**
 * @param {any} diary
 * @param {'morning' | 'afternoon' | 'night' | string} slotKey
 */
function shouldSendScheduledMessage(diary, slotKey) {
    ensureDiaryState(diary);
    const preference = String(diary.profile?.pushPreference || '');

    if (slotKey === 'afternoon' && /(少一点|别太频繁|安静一点)/u.test(preference)) {
        return false;
    }

    return true;
}

/**
 * @param {any} diary
 * @param {'morning' | 'afternoon' | 'night' | string} slotKey
 * @param {string} baseMessage
 */
function buildPersonalizedScheduledMessage(diary, slotKey, baseMessage) {
    ensureDiaryState(diary);

    const displayName = escapeHtml(getPreferredDisplayName(diary));
    const interests = Array.isArray(diary.profile?.interests) ? diary.profile.interests.filter(Boolean) : [];
    const emojis = Array.isArray(diary.profile?.commonEmoji) ? diary.profile.commonEmoji.filter(Boolean) : [];
    const greetingStyle = String(diary.profile?.greetingStyle || '');
    const pushPreference = String(diary.profile?.pushPreference || '');

    const tails = [];
    if (slotKey === 'morning' && /简短一点/u.test(greetingStyle)) {
        tails.push(`<i>今天先回我一句“醒了”就够了，${displayName}。</i>`);
    } else if (slotKey === 'morning' && /活泼一点|像叫我起床一样/u.test(greetingStyle)) {
        tails.push(`<i>${displayName}，别赖床太久。由乃已经先来敲你一下了。</i>`);
    } else if (slotKey === 'night' && /温柔一点/u.test(greetingStyle)) {
        tails.push(`<i>如果你现在只想安静一点，也可以把一句很轻的话交给由乃。</i>`);
    }

    if (interests.length > 0) {
        const leadInterest = escapeHtml(interests[0]);
        if (slotKey === 'afternoon') {
            tails.push(`如果你等会儿有空，也可以顺手告诉由乃，今天有没有碰到和 <b>${leadInterest}</b> 有关的小事。`);
        } else if (slotKey === 'night') {
            tails.push(`要是今晚正好想到 <b>${leadInterest}</b>，也可以把那一瞬间说给由乃听。`);
        }
    }

    if (/(少一点|别太频繁|安静一点)/u.test(pushPreference)) {
        tails.push('<i>由乃会把声音放轻一点，不会一直追着你问。</i>');
    } else if (/(主动一点|多一点)/u.test(pushPreference) && slotKey !== 'afternoon') {
        tails.push('<i>所以这句问候，由乃就先主动送过来了。</i>');
    }

    if (emojis.length > 0) {
        tails.push(escapeHtml(emojis.slice(0, 2).join(' ')));
    }

    return [baseMessage, ...tails].filter(Boolean).join('\n');
}

module.exports = {
    shouldSendScheduledMessage,
    buildPersonalizedScheduledMessage,
};
