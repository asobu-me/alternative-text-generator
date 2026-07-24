/**
 * Video processing service for aria-label generation
 * Handles video tag detection, data loading, and aria-label application
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { generateVideoAriaLabelWithRetry } from '../core/gemini';
import { needsSurroundingText } from '../core/prompts';
import { safeEditDocument, escapeHtml, sanitizeFilePath } from '../utils/security';
import { getVideoMimeType, getCommentFormat } from '../utils/fileUtils';
import { extractSurroundingText } from '../utils/textUtils';
import { showError, showInfo, openFolderAction, formatProgressMessage } from '../utils/notify';
import { detectStaticFileDirectory } from './frameworkDetector';
import { API_CONFIG, SPECIAL_KEYWORDS, CONTEXT_RANGE_VALUES, GEMINI_MODEL } from '../constants';

/**
 * Video tag information
 */
interface VideoTagInfo {
    selectedText: string;
    actualSelection: vscode.Selection;
    videoSrc: string;
    videoFileName: string;
}

/**
 * Video data loaded from file
 */
interface VideoData {
    base64Video: string;
    mimeType: string;
    fileSizeMB: number;
}

/**
 * Pre-fetched configuration shared across a batch to avoid per-video lookups
 */
interface VideoBatchOptions {
    videoDescriptionLength?: 'summary' | 'transcript';
}

/**
 * What kind of outcome an AriaLabelResult carries. 'described' means the video
 * is already covered by nearby copy, so nothing was added — the confirmation
 * dialog must not offer to insert it.
 */
export type VideoOutcome = 'aria-label' | 'transcript' | 'described';

/**
 * Result of aria-label generation
 */
export interface AriaLabelResult {
    newText: string;
    ariaLabel: string;
    actualSelection: vscode.Selection;
    success: boolean;
    /** Basename of the video this result describes — shown in confirmation dialogs. */
    fileName: string;
    outcome: VideoOutcome;
    replacedLength?: number; // Length of the original text that was replaced
}

/**
 * Extract video tag information from selection
 */
async function extractVideoTagInfo(
    editor: vscode.TextEditor,
    selection: vscode.Selection
): Promise<VideoTagInfo | null> {
    const document = editor.document;
    let selectedText = document.getText(selection);
    let actualSelection = selection;

    // カーソル位置または最小限の選択の場合、videoタグ全体を検出
    if (selectedText.trim().length < 10 || !selectedText.includes('>')) {
        const cursorPosition = selection.active;
        const fullText = document.getText();
        const offset = document.offsetAt(cursorPosition);

        // <videoを後方検索
        const videoStartIndex = fullText.lastIndexOf('<video', offset);

        if (videoStartIndex === -1) {
            showError(vscode.l10n.t('No <video> tag found at the cursor. Place the cursor inside a <video> tag, or select the whole tag.'));
            return null;
        }

        // </video>または自己閉じ/>を前方検索
        let endIndex = fullText.indexOf('</video>', videoStartIndex);
        if (endIndex !== -1) {
            endIndex += '</video>'.length;
        } else {
            endIndex = fullText.indexOf('/>', videoStartIndex);
            if (endIndex !== -1) {
                endIndex += 2;
            } else {
                showError(vscode.l10n.t('The <video> tag is not closed. Add </video> (or make it self-closing) and try again.'));
                return null;
            }
        }

        // Get the start and end positions of the video tag
        const startPos = document.positionAt(videoStartIndex);
        const endPos = document.positionAt(endIndex);

        // Create selection for the video tag itself (not including preceding whitespace)
        actualSelection = new vscode.Selection(startPos, endPos);
        selectedText = document.getText(actualSelection);
    }

    // videoタグからsrc属性を抽出
    let videoSrc = selectedText.match(/src=["']([^"']+)["']/)?.[1];

    // src属性がない場合、<source>タグから取得
    if (!videoSrc) {
        videoSrc = selectedText.match(/<source[^>]+src=["']([^"']+)["']/)?.[1];
    }

    if (!videoSrc) {
        showError(vscode.l10n.t('This <video> tag has no src attribute and no <source> child, so there is no video to describe.'));
        return null;
    }

    const videoFileName = path.basename(videoSrc);

    return {
        selectedText,
        actualSelection,
        videoSrc,
        videoFileName
    };
}

/**
 * Load video data from file
 */
async function loadVideoData(
    videoSrc: string,
    editor: vscode.TextEditor
): Promise<VideoData | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) {
        showError(
            vscode.l10n.t('No folder is open, so the video path cannot be resolved. Open the project folder and try again.'),
            openFolderAction()
        );
        return null;
    }

    // 動画の絶対パスを取得
    let videoPath: string | null;
    if (videoSrc.startsWith('/')) {
        const staticDir = detectStaticFileDirectory(workspaceFolder.uri.fsPath);
        const basePath = staticDir
            ? path.join(workspaceFolder.uri.fsPath, staticDir)
            : workspaceFolder.uri.fsPath;
        videoPath = sanitizeFilePath(videoSrc, basePath);
    } else {
        const documentDir = path.dirname(editor.document.uri.fsPath);
        videoPath = sanitizeFilePath(videoSrc, documentDir);
    }

    if (!videoPath) {
        showError(vscode.l10n.t('Files outside the workspace cannot be read: {0}', videoSrc));
        return null;
    }

    if (!fs.existsSync(videoPath)) {
        showError(vscode.l10n.t('Video not found: {0}. Check the src path in the tag.', videoSrc));
        return null;
    }

    // ファイルサイズチェック
    const stats = fs.statSync(videoPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    if (fileSizeMB > API_CONFIG.MAX_VIDEO_SIZE_MB) {
        showError(vscode.l10n.t('The video is too large ({0}MB, limit {1}MB). Compress it or use a shorter clip.', fileSizeMB.toFixed(2), API_CONFIG.MAX_VIDEO_SIZE_MB));
        return null;
    }

    const videoBuffer = fs.readFileSync(videoPath);
    const base64Video = videoBuffer.toString('base64');
    const mimeType = getVideoMimeType(videoPath);

    return {
        base64Video,
        mimeType,
        fileSizeMB
    };
}

/**
 * Apply aria-label to video tag
 */
function applyAriaLabelToTag(
    selectedText: string,
    ariaLabel: string
): string {
    const safeAriaLabel = escapeHtml(ariaLabel);
    const hasAriaLabel = /aria-label=["'][^"']*["']/.test(selectedText);

    if (hasAriaLabel) {
        return selectedText.replace(/aria-label=["'][^"']*["']/, `aria-label="${safeAriaLabel}"`);
    } else {
        return selectedText.replace(/<video/, `<video aria-label="${safeAriaLabel}"`);
    }
}

/**
 * Process single video tag
 * Main entry point for video processing
 */
export async function processSingleVideoTag(
    editor: vscode.TextEditor,
    selection: vscode.Selection,
    token?: vscode.CancellationToken,
    insertionMode?: string,
    cachedSurroundingText?: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    batchOptions?: VideoBatchOptions,
    position?: { index: number; total: number }
): Promise<AriaLabelResult | void> {
    // Extract video tag information
    const videoTagInfo = await extractVideoTagInfo(editor, selection);
    if (!videoTagInfo) {
        return;
    }

    // Update progress. Matches the image path: position + subject only, with the
    // verb supplied by the caller's progress title.
    if (progress) {
        const total = position?.total ?? 1;
        progress.report({
            message: formatProgressMessage(videoTagInfo.videoFileName, position?.index ?? 1, total),
            ...(total === 1 ? {} : { increment: 100 / total })
        });
    }

    // Load video data
    const videoData = await loadVideoData(videoTagInfo.videoSrc, editor);
    if (!videoData) {
        return;
    }

    // Resolve description mode (use pre-fetched batch value when available).
    // No API key is needed here — the proxy holds it server-side.
    const videoDescriptionLength = batchOptions?.videoDescriptionLength
        ?? vscode.workspace.getConfiguration('autoAltWriter').get<string>('videoDescriptionMode', 'summary') as 'summary' | 'transcript';

    const geminiModel = GEMINI_MODEL;

    // Get surrounding text (use cached if available, otherwise extract)
    // Only extract if custom prompts require it
    let surroundingText: string | undefined;
    if (cachedSurroundingText !== undefined) {
        // Use cached surrounding text for batch processing optimization
        surroundingText = cachedSurroundingText;
    } else {
        // Extract surrounding text only when context analysis is turned on.
        if (needsSurroundingText()) {
            const contextRange = CONTEXT_RANGE_VALUES.default; // Use default context range
            surroundingText = extractSurroundingText(editor.document, videoTagInfo.actualSelection, contextRange);
        }
    }

    if (token?.isCancellationRequested) {
        return;
    }

    // Generate aria-label or description
    const description = await generateVideoAriaLabelWithRetry(
        videoData.base64Video,
        videoData.mimeType,
        geminiModel,
        token,
        surroundingText,
        API_CONFIG.MAX_RETRIES,
        videoDescriptionLength
    );

    if (token?.isCancellationRequested) {
        return;
    }

    // Handle DECORATIVE response (don't add aria-label)
    if (description.trim() === SPECIAL_KEYWORDS.DECORATIVE) {
        // Deliberate no-op, not a failure: adding a label here would duplicate
        // what a screen reader already announces from the surrounding text.
        const summary = vscode.l10n.t('{0}: no aria-label added (already described by the surrounding text)', videoTagInfo.videoFileName);
        if (insertionMode === 'auto') {
            showInfo(summary);
        }
        return {
            newText: videoTagInfo.selectedText,
            ariaLabel: summary,
            actualSelection: videoTagInfo.actualSelection,
            success: true,
            fileName: videoTagInfo.videoFileName,
            outcome: 'described'
        };
    }

    // Handle transcript mode - output as comment (format based on file type)
    if (videoDescriptionLength === 'transcript') {
        const comment = getCommentFormat(editor.document.fileName, `Video description: ${description}`);

        // Get indentation from the line where the video tag starts
        const videoTagLine = editor.document.lineAt(videoTagInfo.actualSelection.start.line);
        const videoTagStartColumn = videoTagInfo.actualSelection.start.character;

        // Extract indentation (whitespace before <video tag)
        const indentation = videoTagLine.text.substring(0, videoTagStartColumn);

        // Create expanded selection that includes preceding indentation on the same line
        const expandedStart = new vscode.Position(videoTagInfo.actualSelection.start.line, 0);
        const expandedSelection = new vscode.Selection(expandedStart, videoTagInfo.actualSelection.end);

        // Get the full text being replaced (including indentation)
        const replacedText = editor.document.getText(expandedSelection);

        // Add comment with same indentation, then the full replaced text (which includes the video tag)
        const newText = `${indentation}${comment}\n${replacedText}`;

        // Calculate the length of text being replaced
        const replacedLength = replacedText.length;

        if (insertionMode === 'auto') {
            const success = await safeEditDocument(editor, expandedSelection, newText);
            if (success) {
                showInfo(vscode.l10n.t('Inserted a transcript comment above {0}.', videoTagInfo.videoFileName));
            }
        }

        return {
            newText,
            ariaLabel: description,
            actualSelection: expandedSelection,
            success: true,
            fileName: videoTagInfo.videoFileName,
            outcome: 'transcript',
            replacedLength
        };
    }

    // Standard mode - Apply aria-label
    const newText = applyAriaLabelToTag(videoTagInfo.selectedText, description);

    if (insertionMode === 'auto') {
        const success = await safeEditDocument(editor, videoTagInfo.actualSelection, newText);
        if (success) {
            showInfo(vscode.l10n.t('Inserted aria-label into {0}: {1}', videoTagInfo.videoFileName, description));
        }
    }
    return {
        newText,
        ariaLabel: description,
        actualSelection: videoTagInfo.actualSelection,
        success: true,
        fileName: videoTagInfo.videoFileName,
        outcome: 'aria-label'
    };
}
