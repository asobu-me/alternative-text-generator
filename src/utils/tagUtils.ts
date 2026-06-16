/**
 * HTML tag detection and extraction utilities
 */

import * as vscode from 'vscode';
import { TAG_DETECTION } from '../constants';

/**
 * Detect tag type at cursor position
 * Only detects if cursor is actually inside a tag (between < and >)
 */
export function detectTagType(editor: vscode.TextEditor, selection: vscode.Selection): 'img' | 'video' | null {
    const document = editor.document;
    const offset = document.offsetAt(selection.active);
    const text = document.getText();

    // カーソル位置から後方検索してタグの開始を見つける
    let startIndex = offset;
    let foundOpenBracket = false;
    while (startIndex > 0) {
        if (text[startIndex] === '<') {
            foundOpenBracket = true;
            break;
        } else if (text[startIndex] === '>') {
            // カーソルの前に閉じタグがある = カーソルはタグの外側
            return null;
        }
        startIndex--;
    }

    if (!foundOpenBracket) {
        return null;
    }

    // 前方検索してタグの終了を見つける
    let endIndex = offset;
    let foundCloseBracket = false;
    while (endIndex < text.length) {
        if (text[endIndex] === '>') {
            foundCloseBracket = true;
            break;
        } else if (text[endIndex] === '<') {
            // カーソルの後に開きタグがある = カーソルはタグの外側
            return null;
        }
        endIndex++;
    }

    if (!foundCloseBracket) {
        return null;
    }

    // カーソルがタグの範囲内にあることを確認
    // startIndex < offset <= endIndex であることが保証されている
    if (offset < startIndex || offset > endIndex) {
        return null;
    }

    // タグテキストを取得
    const tagText = text.substring(startIndex, endIndex + 1);

    // タグタイプを判定
    if (/<img[\s>]/i.test(tagText) || /<Image[\s>]/i.test(tagText)) {
        return 'img';
    } else if (/<video[\s>]/i.test(tagText) || /<source[\s>]/i.test(tagText) || /<\/video>/i.test(tagText)) {
        // videoタグの開始タグ、sourceタグ、またはvideoの閉じタグ
        return 'video';
    }

    return null;
}

/**
 * Detect all tags (img and video) in selection
 */
export function detectAllTags(
    editor: vscode.TextEditor,
    selection: vscode.Selection
): Array<{type: 'img' | 'video', range: vscode.Range, text: string}> {
    const document = editor.document;
    const selectedText = document.getText(selection);
    const startOffset = document.offsetAt(selection.start);
    const tags: Array<{type: 'img' | 'video', range: vscode.Range, text: string}> = [];

    // 最大検索長（ReDoS対策）
    const maxSearchLength = 100000;
    if (selectedText.length > maxSearchLength) {
        vscode.window.showWarningMessage('Selected text is too large for tag detection');
        return tags;
    }

    // imgとImageタグを検出（属性長を制限してReDoS対策）
    const imgRegex = new RegExp(`<(img|Image)\\s[^>]{0,${TAG_DETECTION.MAX_ATTRIBUTE_LENGTH}}>`, 'gi');
    let match;
    const startTime = Date.now();

    while ((match = imgRegex.exec(selectedText)) !== null) {
        if (Date.now() - startTime > TAG_DETECTION.SEARCH_TIMEOUT_MS) {
            vscode.window.showWarningMessage('Tag detection timeout - text may be too complex');
            break;
        }
        const tagStart = startOffset + match.index;
        const tagEnd = tagStart + match[0].length;
        const range = new vscode.Range(
            document.positionAt(tagStart),
            document.positionAt(tagEnd)
        );
        tags.push({ type: 'img', range, text: match[0] });
    }

    // videoタグを検出（より安全な2パスアプローチ）
    // 属性があってもなくても検出できるように[\s>]を使用
    const videoOpenRegex = /<video[\s>][^>]{0,500}?>/gi;
    while ((match = videoOpenRegex.exec(selectedText)) !== null) {
        if (Date.now() - startTime > TAG_DETECTION.SEARCH_TIMEOUT_MS) {
            vscode.window.showWarningMessage('Tag detection timeout - text may be too complex');
            break;
        }
        const openStart = match.index;
        const openEnd = openStart + match[0].length;

        // 閉じタグを探す（最大長制限）
        const closeTag = '</video>';
        const closeIndex = selectedText.indexOf(closeTag, openEnd);

        let tagEnd: number;
        if (closeIndex !== -1 && closeIndex - openStart < 50000) {
            tagEnd = closeIndex + closeTag.length;
        } else {
            // 自己閉じタグの場合
            if (match[0].endsWith('/>')) {
                tagEnd = openEnd;
            } else {
                continue; // 閉じタグが見つからない
            }
        }

        const tagStart = startOffset + openStart;
        const range = new vscode.Range(
            document.positionAt(tagStart),
            document.positionAt(startOffset + tagEnd)
        );
        tags.push({ type: 'video', range, text: selectedText.substring(openStart, tagEnd) });
    }

    // sourceタグを検出した場合、親のvideoタグ全体を検索
    const sourceRegex = /<source[\s>][^>]{0,500}?>/gi;
    const fullText = document.getText();

    while ((match = sourceRegex.exec(selectedText)) !== null) {
        if (Date.now() - startTime > TAG_DETECTION.SEARCH_TIMEOUT_MS) {
            vscode.window.showWarningMessage('Tag detection timeout - text may be too complex');
            break;
        }

        // sourceタグのドキュメント内での絶対位置
        const sourcePosition = startOffset + match.index;

        // 後方検索で<video>タグの開始を見つける
        const videoStartIndex = fullText.lastIndexOf('<video', sourcePosition);
        if (videoStartIndex === -1) {
            continue; // 親のvideoタグが見つからない
        }

        // 前方検索で</video>タグの終了を見つける
        let videoEndIndex = fullText.indexOf('</video>', sourcePosition);
        if (videoEndIndex === -1) {
            // 自己閉じvideoタグの場合
            videoEndIndex = fullText.indexOf('/>', videoStartIndex);
            if (videoEndIndex === -1) {
                continue;
            }
            videoEndIndex += 2;
        } else {
            videoEndIndex += '</video>'.length;
        }

        // videoタグが既に検出されているかチェック
        const videoRange = new vscode.Range(
            document.positionAt(videoStartIndex),
            document.positionAt(videoEndIndex)
        );

        const alreadyDetected = tags.some(tag =>
            tag.type === 'video' &&
            tag.range.start.isEqual(videoRange.start) &&
            tag.range.end.isEqual(videoRange.end)
        );

        if (!alreadyDetected) {
            tags.push({
                type: 'video',
                range: videoRange,
                text: fullText.substring(videoStartIndex, videoEndIndex)
            });
        }
    }

    return tags;
}
