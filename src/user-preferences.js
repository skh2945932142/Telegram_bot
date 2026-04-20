// @ts-check

const SUPPORT_MODE_META = {
    companion: {
        label: '只陪我',
        summary: '先接住情绪，不急着分析。',
        prompt: '当前回应偏好是“只陪我”。优先共情和陪伴，不要把对话迅速变成分析或建议；除非用户明确要求，否则不要连续追问。',
    },
    clarify: {
        label: '帮我理一下',
        summary: '温和梳理重点，给我一点结构。',
        prompt: '当前回应偏好是“帮我理一下”。在保持陪伴感的前提下，可以帮用户总结、拆重点、整理顺序，并给出一个轻量下一步。',
    },
    quiet: {
        label: '别追问了',
        summary: '少追问，低压力，先陪着。',
        prompt: '当前回应偏好是“别追问了”。避免追问细节，减少问题句，更多使用确认、陪伴和低压力表达；除非安全必须，否则不要推动用户展开。',
    },
};

const PUSH_PREFERENCE_META = {
    quiet: {
        label: '安静一点',
        summary: '减少主动打扰，下午默认不提醒。',
    },
    balanced: {
        label: '正常频率',
        summary: '保留常规提醒，按上下文挑时机。',
    },
    proactive: {
        label: '多一点主动',
        summary: '更愿意主动追问和提醒。',
    },
};

const PUSH_WINDOW_META = {
    morning: { label: '早上' },
    afternoon: { label: '下午' },
    night: { label: '晚上' },
};

const DEFAULT_SUPPORT_MODE = 'companion';
const DEFAULT_PUSH_PREFERENCE = 'balanced';
const DEFAULT_PUSH_WINDOWS = ['morning', 'afternoon', 'night'];

function markSelected(label, selected) {
    return selected ? `• ${label}` : label;
}

function getSupportModeMeta(mode) {
    const key = String(mode || '').trim().toLowerCase();
    return SUPPORT_MODE_META[key] || SUPPORT_MODE_META[DEFAULT_SUPPORT_MODE];
}

function getEffectiveSupportMode(mode) {
    const key = String(mode || '').trim().toLowerCase();
    return SUPPORT_MODE_META[key] ? key : DEFAULT_SUPPORT_MODE;
}

function getSupportModePrompt(mode) {
    return getSupportModeMeta(mode).prompt;
}

function buildSupportModeKeyboard(mode) {
    const selected = getEffectiveSupportMode(mode);
    return [
        {
            text: markSelected(SUPPORT_MODE_META.companion.label, selected === 'companion'),
            callback_data: 'support_mode_companion',
        },
        {
            text: markSelected(SUPPORT_MODE_META.clarify.label, selected === 'clarify'),
            callback_data: 'support_mode_clarify',
        },
        {
            text: markSelected(SUPPORT_MODE_META.quiet.label, selected === 'quiet'),
            callback_data: 'support_mode_quiet',
        },
    ];
}

function getPushPreferenceMeta(value) {
    const key = String(value || '').trim().toLowerCase();
    return PUSH_PREFERENCE_META[key] || PUSH_PREFERENCE_META[DEFAULT_PUSH_PREFERENCE];
}

function getEffectivePushPreference(value) {
    const key = String(value || '').trim().toLowerCase();
    return PUSH_PREFERENCE_META[key] ? key : DEFAULT_PUSH_PREFERENCE;
}

function getEnabledPushWindows(pushWindows, pushWindowsConfigured = false) {
    if (!Array.isArray(pushWindows)) {
        return [...DEFAULT_PUSH_WINDOWS];
    }

    const unique = new Set();
    for (const value of pushWindows) {
        if (PUSH_WINDOW_META[value]) {
            unique.add(value);
        }
    }

    const normalized = DEFAULT_PUSH_WINDOWS.filter((value) => unique.has(value));
    if (normalized.length === 0 && !pushWindowsConfigured) {
        return [...DEFAULT_PUSH_WINDOWS];
    }
    return normalized;
}

function buildPushPreferenceKeyboard(value) {
    const selected = getEffectivePushPreference(value);
    return [
        {
            text: markSelected(PUSH_PREFERENCE_META.quiet.label, selected === 'quiet'),
            callback_data: 'push_pref_quiet',
        },
        {
            text: markSelected(PUSH_PREFERENCE_META.balanced.label, selected === 'balanced'),
            callback_data: 'push_pref_balanced',
        },
        {
            text: markSelected(PUSH_PREFERENCE_META.proactive.label, selected === 'proactive'),
            callback_data: 'push_pref_proactive',
        },
    ];
}

function buildPushWindowKeyboard(pushWindows) {
    const enabled = new Set(getEnabledPushWindows(pushWindows, true));
    return [
        {
            text: markSelected(PUSH_WINDOW_META.morning.label, enabled.has('morning')),
            callback_data: 'push_window_morning',
        },
        {
            text: markSelected(PUSH_WINDOW_META.afternoon.label, enabled.has('afternoon')),
            callback_data: 'push_window_afternoon',
        },
        {
            text: markSelected(PUSH_WINDOW_META.night.label, enabled.has('night')),
            callback_data: 'push_window_night',
        },
    ];
}

module.exports = {
    SUPPORT_MODE_META,
    PUSH_PREFERENCE_META,
    PUSH_WINDOW_META,
    DEFAULT_SUPPORT_MODE,
    DEFAULT_PUSH_PREFERENCE,
    DEFAULT_PUSH_WINDOWS,
    getSupportModeMeta,
    getEffectiveSupportMode,
    getSupportModePrompt,
    buildSupportModeKeyboard,
    getPushPreferenceMeta,
    getEffectivePushPreference,
    getEnabledPushWindows,
    buildPushPreferenceKeyboard,
    buildPushWindowKeyboard,
};
