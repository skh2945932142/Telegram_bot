// @ts-check

const { escapeHtml } = require('./state/text');
const {
    ensureDiaryState,
    getLegacyRecordsMap,
    getPreferredDisplayName,
    normalizeTimeZone,
    normalizePushPreference,
} = require('./state/diary-store');

const DEFAULT_DIARY_TIME_ZONE = 'Asia/Shanghai';

function getAllowedPushWindows(diary) {
    ensureDiaryState(diary);
    if (!Array.isArray(diary.profile?.pushWindows)) {
        return ['morning', 'afternoon', 'night'];
    }

    const windows = new Set(
        diary.profile.pushWindows.filter((value) => ['morning', 'afternoon', 'night'].includes(value))
    );

    const normalized = ['morning', 'afternoon', 'night'].filter((value) => windows.has(value));
    if (normalized.length === 0 && !diary.profile?.pushWindowsConfigured) {
        return ['morning', 'afternoon', 'night'];
    }
    return normalized;
}

function getLatestFollowUpContext(diary) {
    ensureDiaryState(diary);
    const legacyRecords = getLegacyRecordsMap(diary);
    const pendingFollowUp = String(legacyRecords.get('SYS_PENDING_FOLLOW_UP') || '').trim();
    if (pendingFollowUp) {
        return pendingFollowUp;
    }

    const lastMiniAppContext = String(legacyRecords.get('SYS_WEB_APP_LAST_CONTEXT') || '').trim();
    if (lastMiniAppContext) {
        return lastMiniAppContext;
    }

    const lastMiniAppRecord = String(legacyRecords.get('SYS_WEB_APP_LAST_RECORD') || '').trim();
    if (lastMiniAppRecord) {
        return lastMiniAppRecord;
    }

    const obsessionEntries = [...legacyRecords.entries()]
        .filter(([key, value]) => key.startsWith('OBSESS_') && value)
        .sort(([leftKey], [rightKey]) => rightKey.localeCompare(leftKey));

    if (obsessionEntries.length > 0) {
        return String(obsessionEntries[0][1] || '').trim();
    }

    const latestUserTurn = (diary.session?.recentTurns || [])
        .filter((turn) => turn.role === 'user' && turn.content)
        .slice(-1)[0];
    return latestUserTurn ? String(latestUserTurn.content).trim() : '';
}

function resolveDiaryTimeZone(diary, fallbackTimeZone = DEFAULT_DIARY_TIME_ZONE) {
    ensureDiaryState(diary);
    return normalizeTimeZone(diary.profile?.timeZone) || fallbackTimeZone;
}

function getMinutesInTimezone(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
    return (hour * 60) + minute;
}

function isWithinQuietHours(diary, options = {}) {
    ensureDiaryState(diary);
    const enabled = Boolean(diary.profile?.quietHoursEnabled);
    if (!enabled) {
        return false;
    }

    const start = Number(diary.profile?.quietHoursStart);
    const end = Number(diary.profile?.quietHoursEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return false;
    }

    const now = options.now instanceof Date ? options.now : new Date();
    const fallbackTimeZone = options.fallbackTimeZone || DEFAULT_DIARY_TIME_ZONE;
    const timeZone = resolveDiaryTimeZone(diary, fallbackTimeZone);
    const nowMinutes = getMinutesInTimezone(now, timeZone);

    if (start === end) {
        return true;
    }

    if (start < end) {
        return nowMinutes >= start && nowMinutes < end;
    }
    return nowMinutes >= start || nowMinutes < end;
}

function shouldSendScheduledMessage(diary, slotKey, options = {}) {
    ensureDiaryState(diary);

    const preference = normalizePushPreference(diary.profile?.pushPreference || '');
    const allowedWindows = getAllowedPushWindows(diary);
    if (!allowedWindows.includes(slotKey)) {
        return false;
    }

    if (isWithinQuietHours(diary, options)) {
        return false;
    }

    if (slotKey === 'afternoon' && !getLatestFollowUpContext(diary)) {
        return false;
    }

    if (slotKey === 'afternoon' && preference === 'quiet') {
        return false;
    }

    return true;
}

function trimFollowUpContext(contextText) {
    return escapeHtml(String(contextText || '').replace(/\s+/g, ' ').trim().slice(0, 42));
}

function buildPersonalizedScheduledMessage(diary, slotKey, baseMessage) {
    ensureDiaryState(diary);

    const displayName = escapeHtml(getPreferredDisplayName(diary));
    const interests = Array.isArray(diary.profile?.interests) ? diary.profile.interests.filter(Boolean) : [];
    const emojis = Array.isArray(diary.profile?.commonEmoji) ? diary.profile.commonEmoji.filter(Boolean) : [];
    const greetingStyle = String(diary.profile?.greetingStyle || '').trim();
    const pushPreference = normalizePushPreference(diary.profile?.pushPreference || '');
    const followUpContext = trimFollowUpContext(getLatestFollowUpContext(diary));

    const tails = [];

    if (slotKey === 'morning' && greetingStyle) {
        tails.push(`<i>我会按你偏好的问候方式来找 ${displayName}，也会顺手提醒你别赖床太久。</i>`);
    }

    if (slotKey === 'night' && greetingStyle) {
        tails.push('<i>今晚我会把语气放轻一点，不让提醒显得太硬。</i>');
    }

    if (interests.length > 0) {
        const leadInterest = escapeHtml(interests[0]);
        if (slotKey === 'afternoon') {
            tails.push(`刚才又想到你最近常提的 <b>${leadInterest}</b>。`);
        } else if (slotKey === 'night') {
            tails.push(`如果你今晚还想聊 <b>${leadInterest}</b>，我也会继续听。`);
        }
    }

    if (followUpContext) {
        tails.push(`<i>我还记得这条线索：${followUpContext}</i>`);
    }

    if (pushPreference === 'quiet') {
        tails.push('<i>如果你今天想安静一点，也不用急着立刻回我。</i>');
    } else if (pushPreference === 'proactive' && slotKey !== 'afternoon') {
        tails.push('<i>你如果没开口，我也会更主动一点回来找你。</i>');
    }

    if (emojis.length > 0) {
        tails.push(escapeHtml(emojis.slice(0, 2).join(' ')));
    }

    return [baseMessage, ...tails].filter(Boolean).join('\n');
}

module.exports = {
    getAllowedPushWindows,
    getLatestFollowUpContext,
    resolveDiaryTimeZone,
    isWithinQuietHours,
    shouldSendScheduledMessage,
    buildPersonalizedScheduledMessage,
};
