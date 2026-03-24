// @ts-check

const { TELEGRAM_HTML_TAGS } = require('./constants');

/**
 * @param {string | null | undefined} input
 */
function escapeHtml(input) {
    if (input === null || input === undefined) {
        return '';
    }
    return String(input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {string} text
 */
function fixHtmlTags(text) {
    const allowed = new Set(TELEGRAM_HTML_TAGS);
    const stack = [];
    let result = '';
    let index = 0;

    while (index < text.length) {
        if (text[index] !== '<') {
            result += text[index];
            index += 1;
            continue;
        }

        const tagMatch = text.slice(index).match(/^<(\/?)(b|i|u|s|code)>/i);
        if (!tagMatch) {
            result += '&lt;';
            index += 1;
            continue;
        }

        const fullTag = tagMatch[0];
        const isClosing = tagMatch[1] === '/';
        const tagName = tagMatch[2].toLowerCase();

        if (!allowed.has(tagName)) {
            result += escapeHtml(fullTag);
            index += fullTag.length;
            continue;
        }

        if (!isClosing) {
            stack.push(tagName);
            result += `<${tagName}>`;
        } else {
            const lastIndex = stack.lastIndexOf(tagName);
            if (lastIndex === -1) {
                index += fullTag.length;
                continue;
            }

            if (lastIndex === stack.length - 1) {
                stack.pop();
                result += `</${tagName}>`;
            } else {
                const tagsAbove = [];
                while (stack.length > 0 && stack[stack.length - 1] !== tagName) {
                    const tag = stack.pop();
                    result += `</${tag}>`;
                    tagsAbove.unshift(tag);
                }
                stack.pop();
                result += `</${tagName}>`;
                for (const tag of tagsAbove) {
                    stack.push(tag);
                    result += `<${tag}>`;
                }
            }
        }

        index += fullTag.length;
    }

    while (stack.length > 0) {
        result += `</${stack.pop()}>`;
    }

    return result;
}

/**
 * @param {string} text
 */
function stripHiddenDirectives(text) {
    if (!text) {
        return '';
    }
    return String(text)
        .replace(/[\[【]\s*SAVE_MEMORY[\s\S]*?[\]】]/giu, '')
        .replace(/[\[【]\s*YUNO_OBSESS[\s\S]*?[\]】]/giu, '')
        .trim();
}

/**
 * @param {string} text
 */
function sanitizeTelegramHtml(text) {
    if (!text) {
        return '';
    }

    const raw = String(text).replace(/\r\n/g, '\n').trim();
    let result = '';
    let index = 0;

    while (index < raw.length) {
        if (raw[index] === '<') {
            const tagMatch = raw.slice(index).match(/^<(\/?)(b|i|u|s|code)>/i);
            if (tagMatch) {
                result += `<${tagMatch[1]}${tagMatch[2].toLowerCase()}>`;
                index += tagMatch[0].length;
                continue;
            }
            result += '&lt;';
            index += 1;
            continue;
        }

        if (raw[index] === '>') {
            result += '&gt;';
            index += 1;
            continue;
        }

        if (raw[index] === '&') {
            result += '&amp;';
            index += 1;
            continue;
        }

        result += raw[index];
        index += 1;
    }

    return fixHtmlTags(result);
}

/**
 * @param {string} text
 */
function parseModelDirectives(text) {
    const source = String(text || '');
    const saves = [];
    const obsessions = [];

    const savePattern = /[\[【]\s*SAVE_MEMORY\s*[:：]\s*([^=】\]]+?)\s*[=＝]\s*([^[\]【】]+?)\s*[\]】]/giu;
    const obsessPattern = /[\[【]\s*YUNO_OBSESS\s*[:：]\s*([^[\]【】]+?)\s*[\]】]/giu;

    for (const match of source.matchAll(savePattern)) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (key && value) {
            saves.push({ key, value });
        }
    }

    for (const match of source.matchAll(obsessPattern)) {
        const value = match[1].trim();
        if (value) {
            obsessions.push(value);
        }
    }

    return { saves, obsessions };
}

/**
 * @param {string} text
 */
function stripToPlainText(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[\[【]\s*(?:SAVE_MEMORY|YUNO_OBSESS)[\s\S]*?[\]】]/giu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {string} text
 */
function buildSearchTokens(text) {
    const source = String(text || '').toLowerCase();
    const tokens = new Set();
    const matches = source.match(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/gu) || [];

    for (const match of matches) {
        tokens.add(match);

        if (/^[\p{Script=Han}]+$/u.test(match) && match.length > 2) {
            const maxLength = Math.min(match.length, 6);
            for (let length = 2; length <= maxLength; length += 1) {
                for (let index = 0; index <= match.length - length; index += 1) {
                    tokens.add(match.slice(index, index + length));
                }
            }
        }
    }

    if (tokens.size > 0) {
        return [...tokens];
    }

    const fallback = source.trim();
    return fallback.length >= 2 ? [fallback] : [];
}

module.exports = {
    escapeHtml,
    fixHtmlTags,
    stripHiddenDirectives,
    sanitizeTelegramHtml,
    parseModelDirectives,
    stripToPlainText,
    buildSearchTokens,
};
