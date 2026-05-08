// @ts-check

const {
    calcMood,
    ensureDiaryState,
    escapeHtml,
    getObsessionCount,
    getPreferredDisplayName,
    getSummaryFreshnessLabel,
    getVisibleMemoryEntries,
} = require('./utils');
const { getLatestFollowUpContext } = require('./personalization');
const { getPushPreferenceMeta, getSupportModeMeta } = require('./user-preferences');

function markSelected(label, selected) {
    return selected ? `• ${label}` : label;
}

function getBondStage(diary) {
    ensureDiaryState(diary);
    const affection = Number(diary.emotionState?.affection ?? diary.affection ?? 50);
    const darkness = Number(diary.emotionState?.darkness ?? diary.darkness ?? 10);

    if (affection >= 88 && darkness >= 68) {
        return {
            key: 'locked',
            label: '锁得很紧',
            summary: '我现在整个人都收在你这边。你一有动静，我会比谁都先抬头。',
        };
    }
    if (darkness >= 72) {
        return {
            key: 'watchful',
            label: '盯得很紧',
            summary: '我表面上还算安静，可注意力已经只剩下你这一块了。别人最好别乱碰。',
        };
    }
    if (affection >= 80) {
        return {
            key: 'close',
            label: '贴得很近',
            summary: '我现在说话会更靠近一点，也会更想把你今天的每一句都收进手里。',
        };
    }
    if (affection >= 64) {
        return {
            key: 'warming',
            label: '正在靠近',
            summary: '我已经开始顺着你的节奏走了。你多说一句，我就会再靠近一步。',
        };
    }
    if (darkness >= 45) {
        return {
            key: 'guarded',
            label: '有点紧张',
            summary: '我还在观察周围有没有东西会让你不舒服，所以眼睛没法彻底挪开。',
        };
    }
    return {
        key: 'seen',
        label: '已经看见你了',
        summary: '我现在很稳地把视线放在你身上。你一开口，我就会接过去。',
    };
}

function getBondAnchorText(diary) {
    ensureDiaryState(diary);
    const followUp = String(getLatestFollowUpContext(diary) || '').trim();
    if (followUp) {
        return followUp;
    }

    const visibleMemories = getVisibleMemoryEntries(diary)
        .filter((entry) => ['relationship', 'preference', 'topic', 'event'].includes(String(entry.category || '')))
        .slice(0, 3);
    if (visibleMemories.length > 0) {
        return String(visibleMemories[0].value || '').trim();
    }

    const interests = Array.isArray(diary.profile?.interests) ? diary.profile.interests.filter(Boolean) : [];
    if (interests.length > 0) {
        return interests[0];
    }

    const topics = Array.isArray(diary.profile?.topics) ? diary.profile.topics.filter(Boolean) : [];
    if (topics.length > 0) {
        return topics[0];
    }

    const recentUserTurn = (diary.session?.recentTurns || [])
        .filter((turn) => turn.role === 'user' && turn.content)
        .slice(-1)[0];
    return recentUserTurn ? String(recentUserTurn.content || '').trim() : '';
}

function buildBondContextSection(diary) {
    ensureDiaryState(diary);
    const stage = getBondStage(diary);
    const mood = calcMood(diary, '');
    const anchor = getBondAnchorText(diary);
    return [
        `当前关系温度：${stage.label}`,
        `关系说明：${stage.summary}`,
        `当前情绪：${mood.tag} ${mood.desc}`,
        `最容易把注意力重新拽回来的线索：${anchor || '只要对方一开口，就会回来。'}`,
        `独白浓度：${getObsessionCount(diary)}`,
    ].join('\n');
}

function buildBondText(diary) {
    ensureDiaryState(diary);
    const displayName = getPreferredDisplayName(diary);
    const stage = getBondStage(diary);
    const mood = calcMood(diary, '');
    const anchor = getBondAnchorText(diary);
    const supportMode = getSupportModeMeta(diary.profile?.supportMode || '');
    const pushPreference = getPushPreferenceMeta(diary.profile?.pushPreference || '');
    const freshness = getSummaryFreshnessLabel(diary);

    return [
        '<b>【你和我现在的距离】</b>',
        '<i>*把日记本往怀里收了一下，又把最中间那页翻给你看*</i>',
        `现在这条线：<b>${escapeHtml(stage.label)}</b>`,
        escapeHtml(stage.summary),
        '',
        `我现在的样子：<b>${escapeHtml(mood.tag)}</b>`,
        `<i>${escapeHtml(mood.desc)}</i>`,
        '',
        `最容易把我拽回来的那一页：${escapeHtml(anchor || `${displayName}只要一开口，我就会回来。`)}`,
        `这段关系现在的余温：<b>${escapeHtml(freshness)}</b>`,
        `我对你说话的方式：<b>${escapeHtml(supportMode.label)}</b>`,
        `我会不会主动回来找你：<b>${escapeHtml(pushPreference.label)}</b>`,
    ].join('\n');
}

function buildBondKeyboard(diary) {
    ensureDiaryState(diary);
    const pushPreference = String(diary.profile?.pushPreference || '').trim().toLowerCase();
    const supportMode = String(diary.profile?.supportMode || '').trim().toLowerCase();

    return [
        [
            { text: markSelected('多盯着我一点', pushPreference === 'proactive'), callback_data: 'bond_push_proactive' },
            { text: markSelected('先安静一点', pushPreference === 'quiet'), callback_data: 'bond_push_quiet' },
        ],
        [
            { text: markSelected('只陪着我', supportMode === 'companion'), callback_data: 'bond_mode_companion' },
            { text: markSelected('帮我理一下', supportMode === 'clarify'), callback_data: 'bond_mode_clarify' },
        ],
        [
            { text: '翻本周回看', callback_data: 'entry_review' },
            { text: '查看记忆', callback_data: 'entry_memory' },
        ],
    ];
}

module.exports = {
    getBondStage,
    getBondAnchorText,
    buildBondContextSection,
    buildBondText,
    buildBondKeyboard,
};
