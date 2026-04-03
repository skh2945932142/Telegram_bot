// @ts-check

/**
 * @param {Record<string, any>} fields
 */
function compactFields(fields) {
    return Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );
}

/**
 * @param {{ scope: string, operation: string, chatId?: string, extra?: Record<string, any> }} context
 * @param {string} message
 */
function logRuntimeInfo(context, message) {
    console.log('[runtime:info]', compactFields({
        scope: context.scope,
        operation: context.operation,
        chatId: context.chatId,
        message,
        ...(context.extra || {}),
    }));
}

/**
 * @param {{ scope: string, operation: string, chatId?: string, extra?: Record<string, any> }} context
 * @param {unknown} error
 */
function logRuntimeError(context, error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    console.error('[runtime:error]', compactFields({
        scope: context.scope,
        operation: context.operation,
        chatId: context.chatId,
        message: normalized.message,
        stack: normalized.stack,
        ...(context.extra || {}),
    }));
}

module.exports = {
    logRuntimeInfo,
    logRuntimeError,
};
