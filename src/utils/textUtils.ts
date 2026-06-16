/**
 * Text processing and HTML parsing utilities
 */

import * as vscode from 'vscode';
import { TEXT_PROCESSING } from '../constants';

// Pre-compiled regex patterns for performance optimization
const SCRIPT_TAG_REGEX = /<script[\s\S]*?<\/script>/gi;
const STYLE_TAG_REGEX = /<style[\s\S]*?<\/style>/gi;
const HTML_TAG_REGEX = /<[^>]{1,500}>/g;
const WHITESPACE_REGEX = /\s+/g;

// Block tag patterns for parent/sibling element detection
const BLOCK_TAGS = ['div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'figure', 'li', 'td', 'th', 'p', 'blockquote'];
const BLOCK_TAG_PATTERN = new RegExp(`<(${BLOCK_TAGS.join('|')})[\\s>]`, 'gi');

// Sibling tags include block + inline + heading elements (hoisted to module scope
// so the pattern is compiled once instead of on every findSiblingElements call)
const SIBLING_TAGS = ['div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'figure', 'li', 'td', 'th', 'p', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'caption', 'span', 'a'];
const SIBLING_TAG_PATTERN = new RegExp(`<(${SIBLING_TAGS.join('|')})[\\s>]`, 'gi');

// Cache for close tag patterns (created on demand)
const closeTagPatternCache = new Map<string, RegExp>();

function getCloseTagPattern(tagName: string): RegExp {
    let pattern = closeTagPatternCache.get(tagName);
    if (!pattern) {
        pattern = new RegExp(`</${tagName}>`, 'i');
        closeTagPatternCache.set(tagName, pattern);
    }
    return pattern;
}

/**
 * Document cache interface for storing parsed document data
 */
interface CachedDocument {
    fullText: string;
    version: number; // Document version for cache invalidation
}

/**
 * Document cache using WeakMap for automatic garbage collection
 * Caches document.getText() results to avoid redundant DOM parsing
 */
const documentCache = new WeakMap<vscode.TextDocument, CachedDocument>();

/**
 * Get cached document text or parse and cache it
 */
function getCachedDocumentText(document: vscode.TextDocument): string {
    let cache = documentCache.get(document);

    // Cache miss or document version changed (invalidate cache)
    if (!cache || cache.version !== document.version) {
        cache = {
            fullText: document.getText(),
            version: document.version
        };
        documentCache.set(document, cache);
    }

    return cache.fullText;
}

/**
 * Format a message with placeholders {0}, {1}, etc.
 */
export function formatMessage(message: string, ...args: unknown[]): string {
    args.forEach((arg, index) => {
        message = message.replace(`{${index}}`, String(arg));
    });
    return message;
}

/**
 * Strip HTML tags from text and return clean text content
 * Uses safer regex patterns to prevent ReDoS attacks
 * Uses pre-compiled regex for performance
 */
function stripHtmlTags(text: string): string {
    // Limit text length to prevent ReDoS attacks
    if (text.length > TEXT_PROCESSING.MAX_TEXT_LENGTH) {
        text = text.substring(0, TEXT_PROCESSING.MAX_TEXT_LENGTH);
    }

    return text
        // Remove script tags and content (non-greedy, simpler pattern)
        .replace(SCRIPT_TAG_REGEX, ' ')
        // Remove style tags and content (non-greedy, simpler pattern)
        .replace(STYLE_TAG_REGEX, ' ')
        // Remove other HTML tags with length limit to prevent catastrophic backtracking
        .replace(HTML_TAG_REGEX, ' ')
        // Collapse multiple whitespace into single space
        .replace(WHITESPACE_REGEX, ' ')
        .trim();
}

/**
 * Find parent element containing the image
 */
function findParentElement(
    fullText: string,
    imageStart: number,
    imageEnd: number,
    maxSearch: number = TEXT_PROCESSING.MAX_SEARCH_RANGE
): { start: number; end: number; tagName: string } | null {
    // 画像位置から前後に検索（最大maxSearch文字まで）
    const searchStart = Math.max(0, imageStart - maxSearch);
    const searchEnd = Math.min(fullText.length, imageEnd + maxSearch);
    const searchText = fullText.substring(searchStart, searchEnd);
    const relativeImageStart = imageStart - searchStart;
    const relativeImageEnd = imageEnd - searchStart;

    let closestParent: { start: number; end: number; tagName: string } | null = null;
    let closestDistance = Infinity;

    // 開始タグを探す (use pre-compiled pattern)
    // Reset lastIndex to ensure proper matching in global regex
    BLOCK_TAG_PATTERN.lastIndex = 0;
    let match;
    while ((match = BLOCK_TAG_PATTERN.exec(searchText)) !== null) {
        const openTagStart = match.index;
        const tagName = match[1].toLowerCase();

        // 画像より後ろの開始タグ、または画像の直後の開始タグは無視
        // （画像を含む親要素を探すため）
        if (openTagStart >= relativeImageEnd) {
            continue;
        }

        // 対応する終了タグを探す (use cached pattern)
        const closeTagPattern = getCloseTagPattern(tagName);
        const remainingText = searchText.substring(openTagStart);
        const closeMatch = closeTagPattern.exec(remainingText);

        if (closeMatch) {
            const relativeCloseTagEnd = openTagStart + closeMatch.index + closeMatch[0].length;
            const absoluteOpenTagStart = searchStart + openTagStart;
            const absoluteCloseTagEnd = searchStart + relativeCloseTagEnd;

            // 画像がこの要素内に含まれているか確認
            if (absoluteOpenTagStart <= imageStart && absoluteCloseTagEnd >= imageEnd) {
                const distance = relativeImageStart - openTagStart;
                if (distance >= 0 && distance < closestDistance) {
                    closestDistance = distance;
                    closestParent = {
                        start: absoluteOpenTagStart,
                        end: absoluteCloseTagEnd,
                        tagName: tagName
                    };
                }
            }
        }
    }

    return closestParent;
}

/**
 * Find sibling elements before and after the image
 */
function findSiblingElements(
    fullText: string,
    imageStart: number,
    imageEnd: number,
    maxSearch: number = TEXT_PROCESSING.MAX_SEARCH_RANGE
): Array<{ position: 'before' | 'after'; tagName: string; text: string }> {
    const siblings: Array<{ position: 'before' | 'after'; tagName: string; text: string }> = [];

    // 画像位置から前後に検索（最大maxSearch文字まで）
    const searchStart = Math.max(0, imageStart - maxSearch);
    const searchEnd = Math.min(fullText.length, imageEnd + maxSearch);

    // Use the module-level pre-compiled pattern (lastIndex is reset before each scan)
    const siblingTagPattern = SIBLING_TAG_PATTERN;

    // 画像の前にある兄弟要素を検索（最大3つまで）
    const beforeText = fullText.substring(searchStart, imageStart);
    const beforeMatches: Array<{ tagName: string; start: number; end: number }> = [];

    let match;
    // Reset lastIndex for global regex
    siblingTagPattern.lastIndex = 0;
    while ((match = siblingTagPattern.exec(beforeText)) !== null) {
        const tagName = match[1].toLowerCase();
        const openTagStart = searchStart + match.index;

        // 対応する終了タグを探す (use cached pattern)
        const closeTagPattern = getCloseTagPattern(tagName);
        const remainingText = fullText.substring(openTagStart);
        const closeMatch = closeTagPattern.exec(remainingText);

        if (closeMatch) {
            const closeTagEnd = openTagStart + closeMatch.index + closeMatch[0].length;
            // 画像の前で終了している要素のみ（兄弟要素）
            if (closeTagEnd <= imageStart) {
                beforeMatches.push({ tagName, start: openTagStart, end: closeTagEnd });
            }
        }
    }

    // 画像に最も近い前の兄弟要素を最大3つ取得
    beforeMatches.sort((a, b) => b.end - a.end);
    for (let i = 0; i < Math.min(TEXT_PROCESSING.MAX_SIBLINGS, beforeMatches.length); i++) {
        const element = beforeMatches[i];
        const elementText = fullText.substring(element.start, element.end);
        const cleanedText = stripHtmlTags(elementText).trim();
        if (cleanedText.length > 0) {
            siblings.push({
                position: 'before',
                tagName: element.tagName,
                text: cleanedText
            });
        }
    }

    // 画像の後にある兄弟要素を検索（最大3つまで）
    const afterText = fullText.substring(imageEnd, searchEnd);
    const afterMatches: Array<{ tagName: string; start: number; end: number }> = [];

    // Reset lastIndex for next search
    siblingTagPattern.lastIndex = 0;
    while ((match = siblingTagPattern.exec(afterText)) !== null) {
        const tagName = match[1].toLowerCase();
        const openTagStart = imageEnd + match.index;

        // 対応する終了タグを探す (use cached pattern)
        const closeTagPattern = getCloseTagPattern(tagName);
        const remainingText = fullText.substring(openTagStart);
        const closeMatch = closeTagPattern.exec(remainingText);

        if (closeMatch) {
            const closeTagEnd = openTagStart + closeMatch.index + closeMatch[0].length;
            // 画像の後に開始している要素のみ（兄弟要素）
            afterMatches.push({ tagName, start: openTagStart, end: closeTagEnd });
        }
    }

    // 画像に最も近い後の兄弟要素を最大3つ取得
    afterMatches.sort((a, b) => a.start - b.start);
    for (let i = 0; i < Math.min(TEXT_PROCESSING.MAX_SIBLINGS, afterMatches.length); i++) {
        const element = afterMatches[i];
        const elementText = fullText.substring(element.start, element.end);
        const cleanedText = stripHtmlTags(elementText).trim();
        if (cleanedText.length > 0) {
            siblings.push({
                position: 'after',
                tagName: element.tagName,
                text: cleanedText
            });
        }
    }

    return siblings;
}

/**
 * Extract surrounding text context for the image using structural approach
 * Uses document cache to avoid redundant DOM parsing
 */
export function extractSurroundingText(
    document: vscode.TextDocument,
    tagRange: vscode.Range,
    contextRange: number
): string {
    // Use cached document text for performance
    const fullText = getCachedDocumentText(document);
    const imageStart = document.offsetAt(tagRange.start);
    const imageEnd = document.offsetAt(tagRange.end);

    const collectedTextSet = new Set<string>(); // 重複チェック用
    // Track all text lengths for O(1) substring check optimization
    const collectedTexts: string[] = [];
    let currentImageStart = imageStart;
    let currentImageEnd = imageEnd;
    let level = 0;

    // まず兄弟要素からテキストを収集
    const beforeTexts: string[] = [];
    const afterTexts: string[] = [];

    /**
     * Check if text is a duplicate of, or overlaps (substring either direction
     * with) any already-collected text. Single pass over the central cache.
     */
    function isDuplicateOrSubstring(newText: string): boolean {
        // Exact match check (O(1))
        if (collectedTextSet.has(newText)) {
            return true;
        }

        for (const existing of collectedTexts) {
            if (existing.includes(newText) || newText.includes(existing)) {
                return true;
            }
        }

        return false;
    }

    const siblings = findSiblingElements(fullText, imageStart, imageEnd, contextRange);
    for (const sibling of siblings) {
        const text = sibling.text.trim();
        if (text.length === 0) {
            continue;
        }

        const targetArray = sibling.position === 'before' ? beforeTexts : afterTexts;

        // 重複または部分一致していないテキストのみ追加
        if (!isDuplicateOrSubstring(text)) {
            targetArray.push(text);
            collectedTextSet.add(text);
            collectedTexts.push(text); // Add to central cache
        }
    }

    // 最大階層まで親要素をさかのぼる
    while (level < TEXT_PROCESSING.MAX_PARENT_LEVELS) {
        const parent = findParentElement(fullText, currentImageStart, currentImageEnd, contextRange);

        if (!parent) {
            break; // これ以上親要素が見つからない
        }

        // 親要素内のテキストを抽出（画像タグ自体は除外）
        const beforeImage = fullText.substring(parent.start, imageStart);
        const afterImage = fullText.substring(imageEnd, parent.end);

        // HTMLタグを除去
        const cleanedBefore = stripHtmlTags(beforeImage).trim();
        const cleanedAfter = stripHtmlTags(afterImage).trim();

        // 重複または部分一致していないテキストのみ収集
        if (cleanedBefore.length > 0 && !isDuplicateOrSubstring(cleanedBefore)) {
            beforeTexts.push(cleanedBefore);
            collectedTextSet.add(cleanedBefore);
            collectedTexts.push(cleanedBefore); // Add to central cache
        }
        if (cleanedAfter.length > 0 && !isDuplicateOrSubstring(cleanedAfter)) {
            afterTexts.push(cleanedAfter);
            collectedTextSet.add(cleanedAfter);
            collectedTexts.push(cleanedAfter); // Add to central cache
        }

        // 十分なテキストが集まったら終了
        const totalLength = cleanedBefore.length + cleanedAfter.length;
        if (totalLength >= TEXT_PROCESSING.MIN_CONTEXT_LENGTH) {
            break;
        }

        // 次の階層へ（親の親を探す）
        currentImageStart = parent.start;
        currentImageEnd = parent.end;
        level++;
    }

    // テキストが見つからなかった場合
    if (beforeTexts.length === 0 && afterTexts.length === 0) {
        return '[No surrounding text found]';
    }

    // フォーマット済みのテキストを構築
    const formattedTexts: string[] = [];

    // BEFORE テキストを追加
    for (const text of beforeTexts) {
        formattedTexts.push(`- BEFORE_MEDIA: ${text}`);
    }

    // AFTER テキストを追加
    for (const text of afterTexts) {
        formattedTexts.push(`- AFTER_MEDIA: ${text}`);
    }

    return formattedTexts.join('\n');
}
