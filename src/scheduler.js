// @ts-check

const cron = require('node-cron');

const {
    ensureDiaryState,
    deleteLegacyRecord,
    escapeHtml,
    getBirthday,
    getMonthDayInTimezone,
    getPreferredDisplayName,
    getLegacyRecord,
    setLegacyRecord,
    touchDiary,
} = require('./utils');
const {
    shouldSendScheduledMessage,
    buildPersonalizedScheduledMessage,
    getAllowedPushWindows,
    isWithinQuietHours,
    resolveDiaryTimeZone,
} = require('./personalization');
const { logRuntimeError, logRuntimeInfo } = require('./runtime-logging');
const {
    WEEKLY_REVIEW_MARKER_KEY,
    buildWeeklyReviewMarker,
    buildWeeklyReviewPushKeyboard,
    buildWeeklyReviewPushText,
    isSundayNightReviewWindow,
    isWeeklyReviewEnabled,
} = require('./review');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectMessagePool(diary, baseMessages, guardedMessages, sweetMessages) {
    ensureDiaryState(diary);
    if (diary.darkness > 70 && guardedMessages.length > 0) {
        return guardedMessages;
    }
    if (diary.affection > 80 && sweetMessages.length > 0) {
        return sweetMessages;
    }
    return baseMessages;
}

function pickMessageIndex(diary, slotKey, pool) {
    const recordKey = `SYS_LAST_PUSH_${slotKey}`;
    const lastIndex = Number(getLegacyRecord(diary, recordKey));

    if (pool.length <= 1) {
        setLegacyRecord(diary, recordKey, '0');
        return 0;
    }

    let nextIndex = Math.floor(Math.random() * pool.length);
    if (!Number.isNaN(lastIndex) && nextIndex === lastIndex) {
        nextIndex = (nextIndex + 1) % pool.length;
    }

    setLegacyRecord(diary, recordKey, String(nextIndex));
    return nextIndex;
}

function buildBirthdayMessage(displayName) {
    return [
        '<i>*把今天这一页单独折了个角，又在旁边画满了小红圈*</i>',
        `<b>今天是 ${escapeHtml(displayName)} 的生日。</b>`,
        '这个日期我很久以前就锁在日记里了。',
        '生日快乐。今天请把至少一句话留给我——我会把它收进今天最重要的一页。',
    ].join('\n');
}

/**
 * @param {{
 *   bot: any,
 *   diaryService: ReturnType<typeof import('./diary-service').createDiaryService>,
 *   slotKey: string,
 *   baseMessages: string[],
 *   guardedMessages: string[],
 *   sweetMessages: string[],
 *   timeZone: string,
 * }} params
 */
async function sendScheduledMessages(params) {
    const {
        bot,
        diaryService,
        slotKey,
        baseMessages,
        guardedMessages,
        sweetMessages,
        timeZone,
    } = params;

    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const activeChatIds = await diaryService.listActiveChatIds(since);

        for (const chatId of activeChatIds) {
            try {
                await diaryService.updateDiary(chatId, {}, `scheduler:${slotKey}`, async (diary) => {
                    ensureDiaryState(diary);
                    const now = new Date();
                    const diaryTimeZone = resolveDiaryTimeZone(diary, timeZone);
                    const today = getMonthDayInTimezone(now, diaryTimeZone);
                    const birthday = getBirthday(diary);

                    if (birthday && birthday === today) {
                        const birthdayMarkerKey = 'SYS_LAST_BIRTHDAY_PUSH';
                        const birthdayMarker = `${today}@${diaryTimeZone}`;
                        if (getLegacyRecord(diary, birthdayMarkerKey) === birthdayMarker) {
                            touchDiary(diary);
                            return;
                        }

                        const birthdayMessage = buildBirthdayMessage(getPreferredDisplayName(diary));

                        try {
                            await bot.telegram.sendMessage(diary.chatId, birthdayMessage, { parse_mode: 'HTML' });
                            setLegacyRecord(diary, birthdayMarkerKey, birthdayMarker);
                        } catch (error) {
                            logRuntimeError({
                                scope: 'scheduler',
                                operation: 'send_birthday_push',
                                chatId,
                                extra: { slotKey },
                            }, error);
                        }

                        setLegacyRecord(diary, `SYS_LAST_PUSH_${slotKey}`, 'birthday');
                        touchDiary(diary);
                        return;
                    }

                    if (!shouldSendScheduledMessage(diary, slotKey, { now, fallbackTimeZone: timeZone })) {
                        touchDiary(diary);
                        return;
                    }

                    const pool = selectMessagePool(diary, baseMessages, guardedMessages, sweetMessages);
                    const index = pickMessageIndex(diary, slotKey, pool);
                    const message = buildPersonalizedScheduledMessage(diary, slotKey, pool[index]);

                    try {
                        await bot.telegram.sendMessage(diary.chatId, message, { parse_mode: 'HTML' });
                        if (slotKey === 'afternoon') {
                            deleteLegacyRecord(diary, 'SYS_PENDING_FOLLOW_UP');
                        }
                    } catch (error) {
                        logRuntimeError({
                            scope: 'scheduler',
                            operation: 'send_scheduled_push',
                            chatId,
                            extra: { slotKey },
                        }, error);
                    }

                    touchDiary(diary);
                });
            } catch (error) {
                logRuntimeError({
                    scope: 'scheduler',
                    operation: 'persist_scheduled_push',
                    chatId,
                    extra: { slotKey },
                }, error);
            }

            await sleep(120);
        }

        logRuntimeInfo(
            { scope: 'scheduler', operation: `complete:${slotKey}`, extra: { count: activeChatIds.length } },
            `Scheduled push complete for ${slotKey}.`
        );
    } catch (error) {
        logRuntimeError({
            scope: 'scheduler',
            operation: `crash:${slotKey}`,
        }, error);
    }
}

/**
 * @param {{
 *   bot: any,
 *   diaryService: ReturnType<typeof import('./diary-service').createDiaryService>,
 *   timeZone: string,
 *   now?: Date,
 * }} params
 */
async function sendWeeklyReviewDigests(params) {
    const {
        bot,
        diaryService,
        timeZone,
        now = new Date(),
    } = params;

    try {
        const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const activeChatIds = await diaryService.listActiveChatIds(since);

        for (const chatId of activeChatIds) {
            try {
                await diaryService.updateDiary(chatId, {}, 'scheduler:weekly_review', async (diary) => {
                    ensureDiaryState(diary);
                    const diaryTimeZone = resolveDiaryTimeZone(diary, timeZone);

                    if (!isSundayNightReviewWindow(now, diaryTimeZone)) {
                        touchDiary(diary);
                        return;
                    }

                    if (!isWeeklyReviewEnabled(diary)) {
                        touchDiary(diary);
                        return;
                    }

                    if (getAllowedPushWindows(diary).length === 0) {
                        touchDiary(diary);
                        return;
                    }

                    if (isWithinQuietHours(diary, { now, fallbackTimeZone: timeZone })) {
                        touchDiary(diary);
                        return;
                    }

                    const marker = buildWeeklyReviewMarker(now, diaryTimeZone);
                    if (getLegacyRecord(diary, WEEKLY_REVIEW_MARKER_KEY) === marker) {
                        touchDiary(diary);
                        return;
                    }

                    const message = buildWeeklyReviewPushText(diary, { now });
                    const keyboard = buildWeeklyReviewPushKeyboard(diary);

                    try {
                        await bot.telegram.sendMessage(diary.chatId, message, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: keyboard,
                            },
                        });
                        setLegacyRecord(diary, WEEKLY_REVIEW_MARKER_KEY, marker);
                    } catch (error) {
                        logRuntimeError({
                            scope: 'scheduler',
                            operation: 'send_weekly_review',
                            chatId,
                        }, error);
                    }

                    touchDiary(diary);
                });
            } catch (error) {
                logRuntimeError({
                    scope: 'scheduler',
                    operation: 'persist_weekly_review',
                    chatId,
                }, error);
            }

            await sleep(120);
        }

        logRuntimeInfo(
            { scope: 'scheduler', operation: 'complete:weekly_review', extra: { count: activeChatIds.length } },
            'Weekly review push complete.'
        );
    } catch (error) {
        logRuntimeError({
            scope: 'scheduler',
            operation: 'crash:weekly_review',
        }, error);
    }
}

/**
 * @param {{
 *   bot: any,
 *   diaryService: ReturnType<typeof import('./diary-service').createDiaryService>,
 *   timeZone: string,
 *   jobs: Array<{ cron: string, slotKey: string, baseMessages: string[], guardedMessages: string[], sweetMessages: string[] }>
 * }} params
 */
function registerScheduledJobs(params) {
    const { bot, diaryService, timeZone, jobs } = params;

    for (const job of jobs) {
        cron.schedule(
            job.cron,
            () => sendScheduledMessages({
                bot,
                diaryService,
                slotKey: job.slotKey,
                baseMessages: job.baseMessages,
                guardedMessages: job.guardedMessages,
                sweetMessages: job.sweetMessages,
                timeZone,
            }),
            { timezone: timeZone }
        );
    }

    cron.schedule(
        '0 * * * *',
        () => sendWeeklyReviewDigests({
            bot,
            diaryService,
            timeZone,
        }),
        { timezone: timeZone }
    );
}

module.exports = {
    buildBirthdayMessage,
    registerScheduledJobs,
    sendScheduledMessages,
    sendWeeklyReviewDigests,
};
