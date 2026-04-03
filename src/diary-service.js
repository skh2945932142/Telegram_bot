// @ts-check

const {
    Diary,
    DEFAULT_NICKNAME,
    ensureDiaryState,
    getOrCreateDiary,
    syncDiaryCompatibilityFields,
} = require('./utils');

/**
 * @param {Date} since
 */
async function defaultListActiveChatIds(since) {
    const rows = await Diary.find({ lastActiveAt: { $gte: since } })
        .select({ chatId: 1, _id: 0 })
        .lean();

    return rows
        .map((row) => String(row.chatId || ''))
        .filter(Boolean);
}

/**
 * @param {{
 *   loadDiary?: (chatId: string) => Promise<any | null>,
 *   resolveDiary?: (chatId: string, seed?: Record<string, any>) => Promise<any>,
 *   saveDiary?: (diary: any) => Promise<any>,
 *   listActiveChatIds?: (since: Date) => Promise<string[]>,
 * }} [options]
 */
function createDiaryService(options = {}) {
    /** @type {Map<string, Promise<any>>} */
    const writeQueues = new Map();

    const loadDiary = options.loadDiary || (async (chatId) => {
        const diary = await Diary.findOne({ chatId });
        if (!diary) {
            return null;
        }
        ensureDiaryState(diary);
        return diary;
    });

    const resolveDiary = options.resolveDiary || getOrCreateDiary;
    const saveDiary = options.saveDiary || (async (diary) => diary.save());
    const listActiveChatIds = options.listActiveChatIds || defaultListActiveChatIds;

    /**
     * @param {string} chatId
     * @param {() => Promise<any>} task
     */
    function enqueueWrite(chatId, task) {
        const previous = writeQueues.get(chatId) || Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(task);

        writeQueues.set(chatId, next);
        void next.finally(() => {
            if (writeQueues.get(chatId) === next) {
                writeQueues.delete(chatId);
            }
        });

        return next;
    }

    return {
        /**
         * @param {string} chatId
         */
        async findDiary(chatId) {
            if (!chatId) {
                return null;
            }
            return loadDiary(chatId);
        },

        /**
         * @param {string} chatId
         * @param {Record<string, any>} [seed]
         */
        async getOrCreateDiary(chatId, seed = {}) {
            const diary = await resolveDiary(chatId, {
                nickname: seed.nickname || DEFAULT_NICKNAME,
            });
            ensureDiaryState(diary);
            return diary;
        },

        /**
         * @param {string} chatId
         * @param {Record<string, any> | ((diary: any) => Promise<any> | any)} seedOrMutator
         * @param {string | ((diary: any) => Promise<any> | any)} [operationNameOrMutator]
         * @param {(diary: any) => Promise<any> | any} [mutator]
         */
        async updateDiary(chatId, seedOrMutator, operationNameOrMutator, mutator) {
            /** @type {Record<string, any>} */
            let resolvedSeed = {};
            /** @type {(diary: any) => Promise<any> | any} */
            let resolvedMutator = mutator || (async () => undefined);

            if (typeof seedOrMutator === 'function') {
                resolvedMutator = /** @type {(diary: any) => Promise<any> | any} */ (seedOrMutator);
            } else {
                resolvedSeed = seedOrMutator || {};
            }

            if (typeof operationNameOrMutator === 'function') {
                resolvedMutator = /** @type {(diary: any) => Promise<any> | any} */ (operationNameOrMutator);
            }

            return enqueueWrite(chatId, async () => {
                const diary = await resolveDiary(chatId, resolvedSeed);
                ensureDiaryState(diary);

                const result = await resolvedMutator(diary);
                syncDiaryCompatibilityFields(diary);
                await saveDiary(diary);

                return { diary, result };
            });
        },

        listActiveChatIds,
    };
}

module.exports = {
    createDiaryService,
};
