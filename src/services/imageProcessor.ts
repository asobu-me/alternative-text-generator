/**
 * Image processing service for ALT text generation
 * Handles image tag detection, data loading, and ALT text application
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import fetch from 'node-fetch';
import { generateAltTextWithRetry } from '../core/gemini';
import { needsSurroundingText } from '../core/prompts';
import { safeEditDocument, escapeHtml, sanitizeFilePath, validateImageSrc, validateRemoteImageUrl } from '../utils/security';
import { getMimeType } from '../utils/fileUtils';
import { extractSurroundingText } from '../utils/textUtils';
import { showError, showInfo, openFolderAction, editDecorativeKeywordsAction, formatProgressMessage } from '../utils/notify';
import { detectStaticFileDirectory } from './frameworkDetector';
import { resolveImagePath } from './imagePathResolver';
import { API_CONFIG, SPECIAL_KEYWORDS, CONTEXT_RANGE_VALUES, GEMINI_MODEL } from '../constants';

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
 * What kind of outcome an AltTextResult carries. Drives how the confirmation
 * dialog renders it: 'alt' is a generated phrase to review, while the other two
 * are already-complete sentences explaining why alt="" was chosen.
 */
export type AltOutcome = 'alt' | 'decorative' | 'described';

/**
 * Result of ALT text generation
 */
export interface AltTextResult {
    selection: vscode.Selection;
    altText: string;
    newText: string;
    actualSelection: vscode.Selection;
    success: boolean;
    /** Basename of the image this result describes — shown in confirmation dialogs. */
    fileName: string;
    outcome: AltOutcome;
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
            showError(vscode.l10n.t('No <img> tag found at the cursor. Place the cursor inside an <img> or <Image> tag, or select the whole tag.'));
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
            showError(vscode.l10n.t('The <{0}> tag is not closed. Add the closing ">" and try again.', tagType));
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
            showError(vscode.l10n.t('This tag has no src attribute, so there is no image to describe.'));
            return null;
        }
    }

    // 入力検証（動的式は「手動解決の対象」として扱い、ここでは弾かない）
    const validation = validateImageSrc(imageSrc);
    const isDynamicExpr = !validation.valid && validation.reason === 'Dynamic expression detected';
    if (!validation.valid && !isDynamicExpr) {
        // 危険なプロトコル / UNC / 不正URL 等は従来どおり拒否
        showError(vscode.l10n.t('This image source cannot be loaded: {0}', validation.reason || vscode.l10n.t('unsupported source')));
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
 * Return the decorative keyword that matched the filename, or null.
 * The keyword itself is surfaced in the notification so the user can see *why*
 * an image was treated as decorative — and correct the list if it was wrong.
 */
function matchDecorativeKeyword(imageFileName: string, decorativeKeywords?: string[]): string | null {
    // Use pre-fetched keywords when provided (avoids a config read per image in batches)
    const keywords = decorativeKeywords
        ?? vscode.workspace.getConfiguration('autoAltWriter').get<string[]>('decorativeKeywords', ['icon-', 'bg-', 'deco-']);

    const lowerName = imageFileName.toLowerCase();
    return keywords.find(keyword => lowerName.includes(keyword.toLowerCase())) ?? null;
}

/** Max redirect hops to follow when fetching a remote image (each one re-validated). */
const MAX_IMAGE_REDIRECTS = 5;

/**
 * Build an HTTP/HTTPS agent whose DNS lookup is pinned to an already-validated IP, so the
 * connection cannot be rebound to a different (internal) address between validation and
 * fetch. SNI/Host stay derived from the URL, so TLS cert validation is unaffected.
 */
function createPinnedAgent(protocol: string, address: string, family: number): http.Agent | https.Agent {
    const lookup = (
        _hostname: string,
        options: unknown,
        callback: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void
    ): void => {
        // net.lookup may be called with (hostname, callback) or (hostname, options, callback),
        // and with options.all requesting an array of results.
        const cb = (typeof options === 'function' ? options : callback) as typeof callback;
        const opts = (typeof options === 'function' ? {} : options) as { all?: boolean };
        if (opts && opts.all) {
            cb(null, [{ address, family }]);
        } else {
            cb(null, address, family);
        }
    };
    const agentOptions = { lookup } as unknown as http.AgentOptions;
    return protocol === 'https:' ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
}

/**
 * Fetch a remote image with full SSRF protection:
 * - validates every URL (initial + each redirect target) against the private/internal blocklist,
 * - disables automatic redirect-following (redirect: 'manual') and re-validates each hop, so a
 *   public host cannot 302 to an internal address,
 * - pins the connection to the validated IP to close the DNS-rebinding window.
 * Throws an Error (message already user-facing) on any blocked/failed fetch.
 */
async function fetchRemoteImageSafely(initialUrl: string): Promise<ImageData> {
    let currentUrl = initialUrl;
    for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
        const validation = await validateRemoteImageUrl(currentUrl);
        if (!validation.valid) {
            throw new Error(vscode.l10n.t('This image URL cannot be loaded: {0}', validation.reason || vscode.l10n.t('blocked address')));
        }

        const agent = validation.address
            ? createPinnedAgent(new URL(currentUrl).protocol, validation.address, validation.family ?? net.isIP(validation.address))
            : undefined;

        // レスポンスサイズを制限してメモリ枯渇を防ぐ。リダイレクトは手動で再検証する。
        const response = await fetch(currentUrl, {
            size: API_CONFIG.MAX_IMAGE_SIZE_MB * 1024 * 1024,
            redirect: 'manual',
            follow: 0,
            agent
        });

        // 3xx: re-validate the redirect target on the next iteration instead of blindly following it
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
                throw new Error(vscode.l10n.t('The image server sent a redirect without a destination. Use a direct image URL.'));
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
        }

        if (!response.ok) {
            throw new Error(vscode.l10n.t('Could not download the image ({0}). Check that the URL is publicly reachable.', response.statusText));
        }

        const buffer = await response.buffer();
        const contentType = response.headers.get('content-type');
        const mimeType = contentType && contentType.startsWith('image/') ? contentType : getMimeType(currentUrl);
        return { base64Image: buffer.toString('base64'), mimeType };
    }
    throw new Error(vscode.l10n.t('The image URL redirected too many times. Use a direct image URL.'));
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
        // SSRF対策: 検証 → 手動リダイレクト再検証 → 検証済みIPへのピン留めで内部アドレスへの到達を防ぐ
        try {
            return await fetchRemoteImageSafely(imageSrc);
        } catch (error) {
            showError(error instanceof Error ? error.message : String(error));
            return null;
        }
    } else {
        // ローカルファイルの場合
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!workspaceFolder) {
            showError(
                vscode.l10n.t('No folder is open, so the image path cannot be resolved. Open the project folder and try again.'),
                openFolderAction()
            );
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
            showError(vscode.l10n.t('Files outside the workspace cannot be read: {0}', imageSrc));
            return null;
        }

        if (!fs.existsSync(imagePath)) {
            return 'not-found'; // caller decides whether to offer manual resolution
        }

        if (path.extname(imagePath).toLowerCase() === '.svg') {
            showError(vscode.l10n.t('SVG images are not supported. Convert {0} to PNG or JPG first.', path.basename(imagePath)));
            return null;
        }

        // ファイルサイズチェック（読み込み前にメモリ枯渇を防ぐ）
        const fileSizeMB = fs.statSync(imagePath).size / (1024 * 1024);
        if (fileSizeMB > API_CONFIG.MAX_IMAGE_SIZE_MB) {
            showError(vscode.l10n.t('The image is too large ({0}MB, limit {1}MB). Compress or resize it first.', fileSizeMB.toFixed(2), API_CONFIG.MAX_IMAGE_SIZE_MB));
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
async function loadImageFile(absPath: string): Promise<ImageData | null> {
    if (path.extname(absPath).toLowerCase() === '.svg') {
        showError(vscode.l10n.t('SVG images are not supported. Convert {0} to PNG or JPG first.', path.basename(absPath)));
        return null;
    }
    if (!fs.existsSync(absPath)) {
        showError(vscode.l10n.t('The selected file no longer exists: {0}', path.basename(absPath)));
        return null;
    }
    const fileSizeMB = fs.statSync(absPath).size / (1024 * 1024);
    if (fileSizeMB > API_CONFIG.MAX_IMAGE_SIZE_MB) {
        showError(vscode.l10n.t('The image is too large ({0}MB, limit {1}MB). Compress or resize it first.', fileSizeMB.toFixed(2), API_CONFIG.MAX_IMAGE_SIZE_MB));
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

        // Two distinct reasons produce an empty alt, and the user should be able
        // to tell them apart: redundant with nearby copy vs. nothing to describe.
        const describedByContext = trimmedAlt === SPECIAL_KEYWORDS.DECORATIVE;
        const summary = describedByContext
            ? vscode.l10n.t('{0} → alt="" (already described by the surrounding text)', tagInfo.imageFileName)
            : vscode.l10n.t('{0} → alt="" (nothing meaningful to describe)', tagInfo.imageFileName);

        if (insertionMode === 'auto') {
            const success = await safeEditDocument(editor, tagInfo.actualSelection, newText);
            if (success) {
                showInfo(summary);
            }
        }
        return {
            selection,
            altText: summary,
            newText,
            actualSelection: tagInfo.actualSelection,
            success: true,
            fileName: tagInfo.imageFileName,
            outcome: 'described',
            surroundingText // Return for caching
        };
    }

    // Apply ALT text
    const newText = applyAltTextToTag(tagInfo.selectedText, altText, tagInfo.tagType);

    if (insertionMode === 'auto') {
        const success = await safeEditDocument(editor, tagInfo.actualSelection, newText);
        if (success) {
            showInfo(vscode.l10n.t('Inserted alt text into {0}: {1}', tagInfo.imageFileName, altText));
        }
    }
    return {
        selection,
        altText,
        newText,
        actualSelection: tagInfo.actualSelection,
        success: true,
        fileName: tagInfo.imageFileName,
        outcome: 'alt',
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

    // Update progress. The title (owned by the caller) already says what is being
    // generated, so the message carries only position + subject. The file
    // extension identifies the media type, so no [IMG] prefix is needed.
    if (progress && typeof processedCount === 'number' && typeof totalCount === 'number') {
        progress.report({
            message: formatProgressMessage(tagInfo.imageFileName, processedCount + 1, totalCount),
            // For a single image, omit increment so the bar stays indeterminate
            // rather than implying a known remaining duration.
            ...(totalCount === 1 ? {} : { increment: 100 / totalCount })
        });
    }

    // Check if decorative image (only for non-dynamic tags — dynamic tags have no resolvable filename)
    const decorativeKeyword = tagInfo.dynamic
        ? null
        : matchDecorativeKeyword(tagInfo.imageFileName, batchOptions?.decorativeKeywords);

    if (decorativeKeyword !== null) {
        const newText = generateDecorativeAlt(tagInfo);
        // Naming the matched keyword makes the rule discoverable — and the button
        // lets the user correct it when the match was a false positive.
        const summary = vscode.l10n.t('{0} → alt="" (decorative: matched "{1}")', tagInfo.imageFileName, decorativeKeyword);

        if (insertionMode === 'auto') {
            const success = await safeEditDocument(editor, tagInfo.actualSelection, newText);
            if (success) {
                showInfo(summary, editDecorativeKeywordsAction());
            }
        }
        return {
            selection,
            altText: summary,
            newText,
            actualSelection: tagInfo.actualSelection,
            success: true,
            fileName: tagInfo.imageFileName,
            outcome: 'decorative',
            surroundingText: undefined // No context needed for decorative images
        };
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
    batchOptions: ImageBatchOptions | undefined,
    position?: { index: number; total: number }
): Promise<AltTextResult | 'skip' | 'skip-all' | void> {
    const choice = await resolveImagePath(deferred.unresolvedSrc, deferred.reason, deferred.context, wsRoot, position);
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
