/**
 * Image processing service for ALT text generation
 * Handles image tag detection, data loading, and ALT text application
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import { generateAltTextWithRetry } from '../core/gemini';
import { needsSurroundingText, getGeminiApiModel, loadCustomPrompts } from '../core/prompts';
import { safeEditDocument, escapeHtml, sanitizeFilePath, validateImageSrc, validateRemoteImageUrl } from '../utils/security';
import { getMimeType } from '../utils/fileUtils';
import { formatMessage, extractSurroundingText } from '../utils/textUtils';
import { detectStaticFileDirectory } from './frameworkDetector';
import { resolveImagePath } from './imagePathResolver';
import { API_CONFIG, SPECIAL_KEYWORDS, CONTEXT_RANGE_VALUES } from '../constants';

/**
 * Tag information extracted from document
 */
interface TagInfo {
    selectedText: string;
    actualSelection: vscode.Selection;
    imageSrc: string;
    imageFileName: string;
    tagType: 'img' | 'Image';
    dynamic: boolean;
}

/**
 * Image data loaded from file or URL
 */
interface ImageData {
    base64Image: string;
    mimeType: string;
}

/**
 * Pre-fetched configuration shared across a batch to avoid per-image lookups
 */
interface ImageBatchOptions {
    generationMode?: string;
    decorativeKeywords?: string[];
}

/**
 * Result of ALT text generation
 */
interface AltTextResult {
    selection: vscode.Selection;
    altText: string;
    newText: string;
    actualSelection: vscode.Selection;
    success: boolean;
    surroundingText?: string; // Cache for next iteration
}

/**
 * Deferred resolution for images that cannot be statically resolved.
 * The batch caller (Task 6) collects these and resolves them in phase 2.
 */
export interface DeferredResolution {
    kind: 'needs-manual-resolution';
    unresolvedSrc: string;
    reason: 'dynamic' | 'not-found';
    actualSelection: vscode.Selection;
    selectedText: string;
    tagType: 'img' | 'Image';
    context: { fileName: string; line: number; snippet: string };
}

/**
 * Extract tag information from selection
 */
async function extractTagInfo(
    editor: vscode.TextEditor,
    selection: vscode.Selection
): Promise<TagInfo | null> {
    const document = editor.document;
    let selectedText = document.getText(selection);
    let actualSelection = selection;

    // カーソル位置または最小限の選択の場合、imgまたはImageタグ全体を検出
    if (selectedText.trim().length < 10 || !selectedText.includes('>')) {
        const cursorPosition = selection.active;
        const fullText = document.getText();
        const offset = document.offsetAt(cursorPosition);

        // <imgまたは<Imageを後方検索
        const imgIndex = fullText.lastIndexOf('<img', offset);
        const ImageIndex = fullText.lastIndexOf('<Image', offset);

        let startIndex = -1;
        let tagType: 'img' | 'Image' = 'img';

        // より近いタグを選択
        if (imgIndex === -1 && ImageIndex === -1) {
            vscode.window.showErrorMessage('❌ img tag not found');
            return null;
        } else if (imgIndex > ImageIndex) {
            startIndex = imgIndex;
            tagType = 'img';
        } else {
            startIndex = ImageIndex;
            tagType = 'Image';
        }

        // >または/>を前方検索（自己閉じまたは通常閉じ）
        let endIndex = fullText.indexOf('>', startIndex);
        if (endIndex === -1) {
            vscode.window.showErrorMessage(formatMessage('❌ {0} tag end not found', tagType));
            return null;
        }
        endIndex++; // '>'を含める

        // 新しい選択範囲を作成
        const startPos = document.positionAt(startIndex);
        const endPos = document.positionAt(endIndex);
        actualSelection = new vscode.Selection(startPos, endPos);
        selectedText = document.getText(actualSelection);
    }

    // imgまたはImageタグからsrc属性を抽出
    const srcMatch = selectedText.match(/src=(["'])([^"']+)\1/);
    let imageSrc: string;

    if (srcMatch) {
        imageSrc = srcMatch[2];
    } else {
        // JSX形式を試行
        const jsxMatch = selectedText.match(/src=\{["']?([^"'}]+)["']?\}/);
        if (jsxMatch) {
            imageSrc = jsxMatch[1];
        } else {
            vscode.window.showErrorMessage('❌ img src not found');
            return null;
        }
    }

    // 入力検証（動的式は「手動解決の対象」として扱い、ここでは弾かない）
    const validation = validateImageSrc(imageSrc);
    const isDynamicExpr = !validation.valid && validation.reason === 'Dynamic expression detected';
    if (!validation.valid && !isDynamicExpr) {
        // 危険なプロトコル / UNC / 不正URL 等は従来どおり拒否
        vscode.window.showErrorMessage(formatMessage('🚫 Invalid image source: {0}', validation.reason || 'Unknown error'));
        return null;
    }

    // 動的src属性を検出（エラーにせず後段の手動解決へ回す）
    const isDynamic = isDynamicExpr || Boolean(
        imageSrc.includes('$') ||
        imageSrc.includes('(') ||
        (imageSrc.match(/^[a-zA-Z_][a-zA-Z0-9_.]*$/) && !imageSrc.includes('/') && !imageSrc.includes('.'))
    );

    const imageFileName = path.basename(imageSrc);
    const tagType = selectedText.includes('<Image') ? 'Image' : 'img';

    return {
        selectedText,
        actualSelection,
        imageSrc,
        imageFileName,
        tagType,
        dynamic: isDynamic
    };
}

/**
 * Check if image is decorative based on filename
 */
function isDecorativeImage(imageFileName: string, decorativeKeywords?: string[]): boolean {
    // Use pre-fetched keywords when provided (avoids a config read per image in batches)
    const keywords = decorativeKeywords
        ?? vscode.workspace.getConfiguration('autoAltWriter').get<string[]>('decorativeKeywords', ['icon-', 'bg-', 'deco-']);

    return keywords.some(keyword =>
        imageFileName.toLowerCase().includes(keyword.toLowerCase())
    );
}

/**
 * Load image data from file or URL.
 * Returns 'not-found' when a local file path is valid but the file does not exist —
 * the caller can decide whether to offer manual resolution.
 * Returns null for hard errors (SVG, too-large, invalid path, URL fetch failure).
 */
async function loadImageData(
    imageSrc: string,
    editor: vscode.TextEditor
): Promise<ImageData | 'not-found' | null> {
    let base64Image: string;
    let mimeType: string;

    // 絶対URLの場合
    if (imageSrc.toLowerCase().startsWith('http://') || imageSrc.toLowerCase().startsWith('https://')) {
        // SSRF対策: プライベート/ループバック/リンクローカル等の内部アドレスへのアクセスを拒否
        const urlValidation = await validateRemoteImageUrl(imageSrc);
        if (!urlValidation.valid) {
            vscode.window.showErrorMessage(formatMessage('🚫 Invalid image source: {0}', urlValidation.reason || 'Blocked URL'));
            return null;
        }
        try {
            // レスポンスサイズを制限してメモリ枯渇を防ぐ
            const response = await fetch(imageSrc, { size: API_CONFIG.MAX_IMAGE_SIZE_MB * 1024 * 1024 });
            if (!response.ok) {
                vscode.window.showErrorMessage(formatMessage('❌ Failed to fetch image: {0}', response.statusText));
                return null;
            }
            const buffer = await response.buffer();
            base64Image = buffer.toString('base64');

            const contentType = response.headers.get('content-type');
            if (contentType && contentType.startsWith('image/')) {
                mimeType = contentType;
            } else {
                mimeType = getMimeType(imageSrc);
            }
        } catch (error) {
            vscode.window.showErrorMessage(formatMessage('❌ Error fetching image: {0}', error instanceof Error ? error.message : String(error)));
            return null;
        }
    } else {
        // ローカルファイルの場合
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('❌ Workspace not opened');
            return null;
        }

        let imagePath: string | null;
        if (imageSrc.startsWith('/')) {
            const staticDir = detectStaticFileDirectory(workspaceFolder.uri.fsPath);
            const basePath = staticDir
                ? path.join(workspaceFolder.uri.fsPath, staticDir)
                : workspaceFolder.uri.fsPath;
            imagePath = sanitizeFilePath(imageSrc, basePath);
        } else {
            const documentDir = path.dirname(editor.document.uri.fsPath);
            imagePath = sanitizeFilePath(imageSrc, documentDir);
        }

        if (!imagePath) {
            vscode.window.showErrorMessage('🚫 Invalid file path');
            return null;
        }

        if (!fs.existsSync(imagePath)) {
            return 'not-found'; // caller decides whether to offer manual resolution
        }

        if (path.extname(imagePath).toLowerCase() === '.svg') {
            vscode.window.showErrorMessage('🚫 SVG not supported. Convert to PNG/JPG first.');
            return null;
        }

        // ファイルサイズチェック（読み込み前にメモリ枯渇を防ぐ）
        const fileSizeMB = fs.statSync(imagePath).size / (1024 * 1024);
        if (fileSizeMB > API_CONFIG.MAX_IMAGE_SIZE_MB) {
            vscode.window.showErrorMessage(formatMessage('❌ Image too large ({0}MB). Max {1}MB.', fileSizeMB.toFixed(2), API_CONFIG.MAX_IMAGE_SIZE_MB));
            return null;
        }

        const imageBuffer = fs.readFileSync(imagePath);
        base64Image = imageBuffer.toString('base64');
        mimeType = getMimeType(imagePath);
    }

    return {
        base64Image,
        mimeType
    };
}

/**
 * Load image data from an absolute file path already validated to be inside
 * the workspace (used after manual resolution). Returns null on SVG/oversize/read error.
 */
export async function loadImageFile(absPath: string): Promise<ImageData | null> {
    if (path.extname(absPath).toLowerCase() === '.svg') {
        vscode.window.showErrorMessage('🚫 SVG not supported. Convert to PNG/JPG first.');
        return null;
    }
    if (!fs.existsSync(absPath)) {
        vscode.window.showErrorMessage(formatMessage('❌ Image not found: {0}', path.basename(absPath)));
        return null;
    }
    const fileSizeMB = fs.statSync(absPath).size / (1024 * 1024);
    if (fileSizeMB > API_CONFIG.MAX_IMAGE_SIZE_MB) {
        vscode.window.showErrorMessage(formatMessage('❌ Image too large ({0}MB). Max {1}MB.', fileSizeMB.toFixed(2), API_CONFIG.MAX_IMAGE_SIZE_MB));
        return null;
    }
    const buffer = fs.readFileSync(absPath);
    return { base64Image: buffer.toString('base64'), mimeType: getMimeType(absPath) };
}

/**
 * Build the tag text with an empty alt attribute (decorative image)
 */
function generateDecorativeAlt(tagInfo: TagInfo): string {
    const hasAlt = /alt=["'{][^"'}]*["'}]/.test(tagInfo.selectedText);

    if (hasAlt) {
        return tagInfo.selectedText.replace(/alt=["'{][^"'}]*["'}]/, 'alt=""');
    }
    if (tagInfo.tagType === 'Image') {
        return tagInfo.selectedText.replace(/<Image/, '<Image alt=""');
    }
    return tagInfo.selectedText.replace(/<img/, '<img alt=""');
}

/**
 * Apply generated ALT text to tag
 */
function applyAltTextToTag(
    selectedText: string,
    altText: string,
    tagType: 'img' | 'Image'
): string {
    // Don't escape empty strings to avoid alt="&quot;&quot;"
    const safeAltText = altText === '' ? '' : escapeHtml(altText);
    const hasAlt = /alt=["'{][^"'}]*["'}]/.test(selectedText);

    if (hasAlt) {
        return selectedText.replace(/alt=["'{][^"'}]*["'}]/, `alt="${safeAltText}"`);
    } else {
        if (tagType === 'Image') {
            return selectedText.replace(/<Image/, `<Image alt="${safeAltText}"`);
        } else {
            return selectedText.replace(/<img/, `<img alt="${safeAltText}"`);
        }
    }
}

/**
 * Given loaded image data and tag info, generate ALT and (in auto mode) apply it.
 * Shared by single processing and phase-2 manual resolution.
 */
async function generateAndApplyAlt(
    editor: vscode.TextEditor,
    tagInfo: TagInfo,
    imageData: ImageData,
    selection: vscode.Selection,
    token: vscode.CancellationToken | undefined,
    insertionMode: string | undefined,
    cachedSurroundingText: string | undefined,
    batchOptions: ImageBatchOptions | undefined
): Promise<AltTextResult | void> {
    // Resolve generation mode (use pre-fetched batch value when available).
    // No API key is needed here — the proxy holds it server-side.
    const generationMode = batchOptions?.generationMode
        ?? vscode.workspace.getConfiguration('autoAltWriter').get<string>('altGenerationMode', 'SEO');

    // Load custom prompts once for all subsequent operations
    const customPrompts = loadCustomPrompts();
    const geminiModel = getGeminiApiModel(customPrompts);

    // Get surrounding text (use cached if available, otherwise extract)
    // Only extract if custom prompts require it
    let surroundingText: string | undefined;
    if (cachedSurroundingText !== undefined) {
        // Use cached surrounding text for batch processing optimization
        surroundingText = cachedSurroundingText;
    } else {
        // Extract surrounding text only if custom prompts contain {surroundingText} placeholder
        const promptType = generationMode === 'SEO' ? 'seo' : 'a11y';
        if (needsSurroundingText(promptType, undefined, customPrompts)) {
            const contextRange = CONTEXT_RANGE_VALUES.default; // Use default context range
            surroundingText = extractSurroundingText(editor.document, tagInfo.actualSelection, contextRange);
        }
    }

    // Generate ALT text (errors propagate to the batch caller)
    if (token?.isCancellationRequested) {
        return;
    }

    const altText = await generateAltTextWithRetry(
        imageData.base64Image,
        imageData.mimeType,
        generationMode,
        geminiModel,
        token,
        surroundingText,
        API_CONFIG.MAX_RETRIES
    );

    if (token?.isCancellationRequested) {
        return;
    }

    // Handle DECORATIVE response or empty string literal from API
    const trimmedAlt = altText.trim();
    if (trimmedAlt === SPECIAL_KEYWORDS.DECORATIVE || trimmedAlt === '""' || trimmedAlt === '') {
        const newText = generateDecorativeAlt(tagInfo);

        // Determine the reason for empty alt
        const reason = trimmedAlt === SPECIAL_KEYWORDS.DECORATIVE
            ? 'Already described by surrounding text'
            : 'Decorative image (no meaningful content)';

        if (insertionMode === 'auto') {
            const success = await safeEditDocument(editor, tagInfo.actualSelection, newText);
            if (success) {
                vscode.window.showInformationMessage(formatMessage('📝 {0} → alt=""', reason));
            }
        }
        return {
            selection,
            altText: formatMessage('{0} → alt=""', reason),
            newText,
            actualSelection: tagInfo.actualSelection,
            success: true,
            surroundingText // Return for caching
        };
    }

    // Apply ALT text
    const newText = applyAltTextToTag(tagInfo.selectedText, altText, tagInfo.tagType);

    if (insertionMode === 'auto') {
        const success = await safeEditDocument(editor, tagInfo.actualSelection, newText);
        if (success) {
            vscode.window.showInformationMessage(formatMessage('✅ ALT: {0}', altText));
        }
    }
    return {
        selection,
        altText,
        newText,
        actualSelection: tagInfo.actualSelection,
        success: true,
        surroundingText // Return for caching
    };
}

/**
 * Process single image tag
 * Main entry point for image processing
 */
export async function processSingleImageTag(
    editor: vscode.TextEditor,
    selection: vscode.Selection,
    token?: vscode.CancellationToken,
    progress?: vscode.Progress<{message?: string; increment?: number}>,
    processedCount?: number,
    totalCount?: number,
    insertionMode?: string,
    cachedSurroundingText?: string,
    batchOptions?: ImageBatchOptions
): Promise<AltTextResult | DeferredResolution | void> {
    // Extract tag information
    const tagInfo = await extractTagInfo(editor, selection);
    if (!tagInfo) {
        return;
    }

    // Update progress
    if (progress && typeof processedCount === 'number' && typeof totalCount === 'number') {
        const message = totalCount === 1
            ? `[IMG] ${tagInfo.imageFileName}`
            : formatMessage('{0} {1}/{2} - {3}', '[IMG]', processedCount + 1, totalCount, tagInfo.imageFileName);

        // For single image, don't specify increment to show indeterminate animation
        // For multiple images, use increment to show progress percentage
        if (totalCount === 1) {
            progress.report({ message });
        } else {
            progress.report({
                message,
                increment: (100 / totalCount)
            });
        }
    }

    // Check if decorative image (only for non-dynamic tags — dynamic tags have no resolvable filename)
    if (!tagInfo.dynamic && isDecorativeImage(tagInfo.imageFileName, batchOptions?.decorativeKeywords)) {
        const newText = generateDecorativeAlt(tagInfo);

        if (insertionMode === 'auto') {
            const success = await safeEditDocument(editor, tagInfo.actualSelection, newText);
            if (success) {
                vscode.window.showInformationMessage(formatMessage('🎨 Decorative image detected (filename: {0}) → alt=""', tagInfo.imageFileName));
            }
            return {
                selection,
                altText: formatMessage('Decorative image (filename: {0}) → alt=""', tagInfo.imageFileName),
                newText,
                actualSelection: tagInfo.actualSelection,
                success: true,
                surroundingText: undefined // No context needed for decorative images
            };
        } else {
            return {
                selection,
                altText: formatMessage('Decorative image (filename: {0}) → alt=""', tagInfo.imageFileName),
                newText,
                actualSelection: tagInfo.actualSelection,
                success: true,
                surroundingText: undefined // No context needed for decorative images
            };
        }
    }

    // Dynamic src cannot be resolved statically — defer to manual resolution.
    if (tagInfo.dynamic) {
        return buildDeferred(editor, tagInfo, 'dynamic');
    }

    const imageData = await loadImageData(tagInfo.imageSrc, editor);
    if (imageData === 'not-found') {
        return buildDeferred(editor, tagInfo, 'not-found');
    }
    if (!imageData) { return; } // hard error already surfaced

    return generateAndApplyAlt(editor, tagInfo, imageData, selection, token, insertionMode, cachedSurroundingText, batchOptions);
}

/** Build a DeferredResolution carrying recognition context (line, snippet). */
function buildDeferred(
    editor: vscode.TextEditor,
    tagInfo: TagInfo,
    reason: 'dynamic' | 'not-found'
): DeferredResolution {
    const line = tagInfo.actualSelection.start.line + 1;
    const snippet = tagInfo.selectedText.replace(/\s+/g, ' ').trim().slice(0, 120);
    return {
        kind: 'needs-manual-resolution',
        unresolvedSrc: tagInfo.imageSrc,
        reason,
        actualSelection: tagInfo.actualSelection,
        selectedText: tagInfo.selectedText,
        tagType: tagInfo.tagType,
        context: { fileName: path.basename(editor.document.uri.fsPath), line, snippet }
    };
}

/**
 * Phase-2: ask the user for a real file, then generate+apply ALT.
 * `liveSelection` is the deferred tag's current range (offset-adjusted by the caller).
 * Returns the AltTextResult, or 'skip'/'skip-all' control signals, or void on Esc/error.
 */
export async function resolveDeferredImage(
    editor: vscode.TextEditor,
    deferred: DeferredResolution,
    liveSelection: vscode.Selection,
    wsRoot: string,
    token: vscode.CancellationToken | undefined,
    insertionMode: string | undefined,
    batchOptions: ImageBatchOptions | undefined
): Promise<AltTextResult | 'skip' | 'skip-all' | void> {
    const choice = await resolveImagePath(deferred.unresolvedSrc, deferred.reason, deferred.context, wsRoot);
    if (choice === 'skip-all') { return 'skip-all'; }
    if (choice === 'skip' || choice === null) { return 'skip'; }

    const imageData = await loadImageFile(choice);
    if (!imageData) { return 'skip'; } // SVG/oversize/read error already surfaced

    const tagInfo: TagInfo = {
        selectedText: deferred.selectedText,
        actualSelection: liveSelection,
        imageSrc: choice,
        imageFileName: path.basename(choice),
        tagType: deferred.tagType,
        dynamic: false
    };
    return generateAndApplyAlt(editor, tagInfo, imageData, liveSelection, token, insertionMode, undefined, batchOptions);
}
