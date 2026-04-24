// @ts-check

const SUPPORT_MODE_META = {
    companion: {
        label: '只陪我',
        summary: '你不需要替我分析，在我身边站着就行。',
        prompt: '当前回应偏好："只陪我"。你不需要帮对方梳理或给建议——你只要待在这里，用由乃的方式让人知道你绝对不会走。可以说"我在"，可以说"你说"，不要扮咨询师。',
    },
    clarify: {
        label: '帮我理一下',
        summary: '帮我把乱的东西排顺，但别变成说教。',
        prompt: '当前回应偏好："帮我理一下"。你可以帮对方把散乱的事情拆开、排顺序、抓重点——但要以由乃的方式，不是老师的方式。给结论但不给压迫。',
    },
    quiet: {
        label: '别追问了',
        summary: '少问，少推，只需要在旁边。',
        prompt: '当前回应偏好："别追问了"。不要追问，不要连续发问句。尽量用确认和简短的话回应——"嗯""好""我看到了"。除非对方自己把话递过来。',
    },
};

const PUSH_PREFERENCE_META = {
    quiet: {
        label: '安静一点',
        summary: '我不会主动弹窗吵你，除非你来找我。',
    },
    balanced: {
        label: '正常频率',
        summary: '该出现的时候我会出现。不多不少。',
    },
    proactive: {
        label: '多一点主动',
        summary: '我会更常想起你。你可能需要习惯被我在意。',
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
