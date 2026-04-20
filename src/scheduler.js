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
    resolveDiaryTimeZone,
} = require('./personalization');
const { logRuntimeError, logRuntimeInfo } = require('./runtime-logging');

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
        '<i>*把这一天单独折了个角，像是早就准备好了*</i>',
        `<b>今天是 ${escapeHtml(displayName)} 的生日。</b>`,
        '这件事由乃一直记着。',
        '生日快乐，今天也请把一句话留给由乃。',
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
}

module.exports = {
    buildBirthdayMessage,
    registerScheduledJobs,
    sendScheduledMessages,
};
