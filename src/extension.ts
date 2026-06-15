import * as vscode from 'vscode';

// Utils
import { safeEditDocument } from './utils/security';
import { formatMessage } from './utils/textUtils';
import { detectTagType, detectAllTags } from './utils/tagUtils';
import { getInsertionMode, clearOutputLanguageCache } from './utils/config';
import { getUserFriendlyErrorMessage } from './utils/errorHandler';
import { CancellationError } from './utils/errors';
import { createContextCache } from './utils/contextGrouping';

// Services
import { processSingleImageTag, resolveDeferredImage, DeferredResolution } from './services/imageProcessor';
import { resetResolverCache } from './services/imagePathResolver';
import { processSingleVideoTag } from './services/videoProcessor';

/** Type guard: true when an image result requires phase-2 manual resolution. */
function isDeferredResolution(value: unknown): value is DeferredResolution {
    return typeof value === 'object' && value !== null
        && (value as { kind?: unknown }).kind === 'needs-manual-resolution';
}

// Core
import { needsSurroundingText } from './core/prompts';

// Constants
import { SELECTION_THRESHOLDS, BATCH_PROCESSING, CONTEXT_RANGE_VALUES } from './constants';

export async function activate(context: vscode.ExtensionContext) {
    // Watch for configuration changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
        // Clear output language cache when output language setting changes
        if (e.affectsConfiguration('autoAltWriter.outputLanguage')) {
            clearOutputLanguageCache();
        }
    });
    context.subscriptions.push(configWatcher);

    // Smart ALT/aria-label generation command (auto-detect tag type)
    const disposable = vscode.commands.registerCommand('auto-alt-writer.generateAlt', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('❌ No active editor');
            return;
        }

        const selections = editor.selections;
        const firstSelection = selections[0];

        // Check if selection is empty (cursor only)
        const isEmptySelection = firstSelection.isEmpty || editor.document.getText(firstSelection).trim().length < SELECTION_THRESHOLDS.MIN_SELECTION_LENGTH;

        if (isEmptySelection) {
            // Detect tag at cursor position (traditional behavior)
            const tagType = detectTagType(editor, firstSelection);

            if (tagType === 'video') {
                await vscode.commands.executeCommand('auto-alt-writer.generateVideoAriaLabel');
                return;
            } else if (tagType === 'img') {
                await generateAltForImages(editor, selections);
                return;
            } else {
                vscode.window.showErrorMessage('❌ No img or video tag found');
                return;
            }
        } else {
            // Detect all tags within selection
            const allTags = detectAllTags(editor, firstSelection);

            if (allTags.length === 0) {
                vscode.window.showErrorMessage('❌ No img or video tag found');
                return;
            }

            // Separate img tags and video tags
            const imgTags = allTags.filter(tag => tag.type === 'img');
            const videoTags = allTags.filter(tag => tag.type === 'video');

            // Process tags
            await processMultipleTags(editor, imgTags, videoTags);
        }
    });

    context.subscriptions.push(disposable);

    // Video tag aria-label generation command
    const videoDisposable = vscode.commands.registerCommand('auto-alt-writer.generateVideoAriaLabel', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('❌ No active editor');
            return;
        }

        const selection = editor.selection;

        // Get insertion mode from settings
        const config = vscode.workspace.getConfiguration('autoAltWriter');
        const insertionMode = config.get<'auto' | 'confirm'>('insertionMode', 'confirm');

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating...',
            cancellable: true
        }, async (progress, token) => {
            try {
                const result = await processSingleVideoTag(editor, selection, token, insertionMode, undefined, progress);

                // Show result dialog for confirm mode
                if (result && insertionMode === 'confirm') {
                    // For DECORATIVE case (no aria-label added), just show info message
                    if (result.ariaLabel.includes('not added')) {
                        vscode.window.showInformationMessage('📝 aria-label: Already described by surrounding text (not added)');
                    } else {
                        // Get video description length mode to customize message
                        const config = vscode.workspace.getConfiguration('autoAltWriter');
                        const videoDescriptionLength = config.get<string>('videoDescriptionMode', 'summary');

                        // Show confirmation dialog with appropriate message
                        const message = videoDescriptionLength === 'transcript'
                            ? `✅ Video description (as comment): ${result.ariaLabel}`
                            : `✅ aria-label: ${result.ariaLabel}`;

                        // Single item: show only Insert and Cancel (no Skip)
                        const choice = await vscode.window.showInformationMessage(
                            message,
                            'Insert',
                            'Cancel'
                        );

                        if (choice === 'Insert') {
                            // Use actualSelection from result to insert at correct position
                            await safeEditDocument(editor, result.actualSelection, result.newText);
                        }
                    }
                }
            } catch (error) {
                // Cancellation errors are already handled
                if (error instanceof CancellationError || token.isCancellationRequested) {
                    return;
                }
                const errorMessage = getUserFriendlyErrorMessage(error);
                vscode.window.showErrorMessage(errorMessage);
            }
        });
    });

    context.subscriptions.push(videoDisposable);
    // Note: no API-key commands. The Gemini API key is never stored in the
    // extension — all requests are routed through a server-side proxy (see /proxy).
}

/**
 * Show confirmation dialog for generated content
 * Returns user's choice: 'Insert', 'Skip', or 'Cancel'
 */
async function showConfirmationDialog(
    message: string,
    totalCount: number
): Promise<string | undefined> {
    // Single item: show only Insert and Cancel (no Skip)
    if (totalCount === 1) {
        return await vscode.window.showInformationMessage(
            message,
            'Insert',
            'Cancel'
        );
    } else {
        return await vscode.window.showInformationMessage(
            message,
            'Insert',
            'Skip',
            'Cancel'
        );
    }
}

/**
 * Handle user's choice from confirmation dialog
 * Returns true if processing should continue, false if cancelled
 */
async function handleUserChoice(
    choice: string | undefined,
    editor: vscode.TextEditor,
    actualSelection: vscode.Selection,
    newText: string,
    processedCount: number,
    totalCount: number
): Promise<boolean> {
    if (choice === 'Insert') {
        const success = await safeEditDocument(editor, actualSelection, newText);
        if (!success) {
            return false;
        }
    } else if (choice === 'Cancel') {
        vscode.window.showWarningMessage(formatMessage('⏸️ Cancelled ({0}/{1} processed)', processedCount + 1, totalCount));
        return false;
    }
    // Skip: continue processing
    return true;
}

/**
 * Resolve deferred (dynamic / not-found) image tags after the main pass.
 * Items are sorted ascending by their live start offset; a local delta keeps
 * later items' ranges correct as earlier ones are edited. Identical
 * unresolvedSrc values are auto-resolved by the session cache (asked once).
 * Returns the number of successfully resolved items.
 */
async function runDeferredResolutionPhase(
    editor: vscode.TextEditor,
    deferred: Array<{ item: DeferredResolution; liveStartOffset: number; liveLength: number }>,
    wsRoot: string,
    token: vscode.CancellationToken,
    insertionMode: string,
    batchOptions: { generationMode: string; decorativeKeywords: string[] }
): Promise<number> {
    let resolvedCount = 0;
    let phase2Delta = 0;
    const ordered = [...deferred].sort((a, b) => a.liveStartOffset - b.liveStartOffset);

    for (const entry of ordered) {
        if (token.isCancellationRequested) { break; }

        const start = editor.document.positionAt(entry.liveStartOffset + phase2Delta);
        const end = editor.document.positionAt(entry.liveStartOffset + phase2Delta + entry.liveLength);
        const liveSelection = new vscode.Selection(start, end);

        const result = await resolveDeferredImage(
            editor, entry.item, liveSelection, wsRoot, token, insertionMode, batchOptions
        );

        if (result === 'skip-all') { break; }
        if (result === 'skip' || !result) { continue; }

        // result is an AltTextResult
        if (insertionMode === 'confirm') {
            const replacedLen = entry.liveLength;
            const choice = await vscode.window.showInformationMessage(
                `✅ ALT: ${result.altText}`, 'Insert', 'Skip', 'Cancel'
            );
            if (choice === 'Cancel') { break; }   // abort remaining deferred resolutions
            if (choice === 'Insert') {
                const ok = await safeEditDocument(editor, liveSelection, result.newText);
                if (ok) {
                    phase2Delta += (result.newText.length - replacedLen);
                    resolvedCount++;
                }
            }
            // 'Skip' or dismissed (Esc) → leave unchanged, continue
        } else {
            // auto mode: resolveDeferredImage already edited the document
            phase2Delta += (result.newText.length - entry.liveLength);
            resolvedCount++;
        }
    }
    return resolvedCount;
}

// Process multiple tags (mixed img and video tags)
async function processMultipleTags(
    editor: vscode.TextEditor,
    imgTags: Array<{type: 'img' | 'video', range: vscode.Range, text: string}>,
    videoTags: Array<{type: 'img' | 'video', range: vscode.Range, text: string}>
): Promise<void> {
    // Pre-fetch configuration once for the whole batch (avoids per-item lookups)
    const insertionMode = getInsertionMode();
    const config = vscode.workspace.getConfiguration('autoAltWriter');
    const generationMode = config.get<string>('altGenerationMode', 'SEO');
    const videoDescriptionLength = config.get<string>('videoDescriptionMode', 'summary') as 'summary' | 'transcript';
    const decorativeKeywords = config.get<string[]>('decorativeKeywords', ['icon-', 'bg-', 'deco-']);

    // Pre-fetched config passed to the per-item processors
    const imageBatchOptions = { generationMode, decorativeKeywords };
    const videoBatchOptions = { videoDescriptionLength };

    // Check if any custom prompts need surrounding text
    const promptType = generationMode === 'SEO' ? 'seo' : 'a11y';
    const needsContext = needsSurroundingText(promptType) || needsSurroundingText('video', videoDescriptionLength);
    const contextRange = needsContext ? CONTEXT_RANGE_VALUES.default : 0;

    const totalCount = imgTags.length + videoTags.length;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: totalCount === 1 ? 'Generating...' : formatMessage('Processing {0} items...', totalCount),
        cancellable: true
    }, async (progress, token) => {
        let processedCount = 0;
        let successCount = 0;
        let failureCount = 0;

        // Combine all tags and sort by position in document (forward order)
        // Process from start to end for better user experience
        const allTags = [...imgTags, ...videoTags].sort((a, b) => {
            const aOffset = editor.document.offsetAt(a.range.start);
            const bOffset = editor.document.offsetAt(b.range.start);
            return aOffset - bOffset; // Forward order
        });

        // Track offset changes to adjust subsequent tag ranges after edits
        let cumulativeOffsetDelta = 0;

        // Deferred (dynamic / not-found) image tags collected for phase-2 resolution
        const deferredImages: Array<{ item: DeferredResolution; liveStartOffset: number; liveLength: number }> = [];

        // Store original offsets for all tags before any edits
        const tagOffsets = allTags.map(tag => ({
            tag,
            startOffset: editor.document.offsetAt(tag.range.start),
            endOffset: editor.document.offsetAt(tag.range.end),
            originalLength: editor.document.getText(tag.range).length
        }));

        // Process in chunks for memory efficiency
        for (let i = 0; i < allTags.length; i += BATCH_PROCESSING.CHUNK_SIZE) {
            const chunk = allTags.slice(i, i + BATCH_PROCESSING.CHUNK_SIZE);

            // Create context cache for this chunk only if needed
            const contextCache = await createContextCache(editor.document, chunk, contextRange, needsContext);

            // Process each tag in the chunk
            for (let j = 0; j < chunk.length; j++) {
                const tag = chunk[j];
                const tagIndex = i + j;
                const tagOffset = tagOffsets[tagIndex];

                if (token.isCancellationRequested) {
                    vscode.window.showWarningMessage(formatMessage('⏸️ Cancelled ({0}/{1} processed)', processedCount, totalCount));
                    return;
                }

                const isImageTag = tag.type === 'img';

                // Adjust tag range based on cumulative offset delta
                const adjustedStartOffset = tagOffset.startOffset + cumulativeOffsetDelta;
                const adjustedEndOffset = tagOffset.endOffset + cumulativeOffsetDelta;
                const adjustedStart = editor.document.positionAt(adjustedStartOffset);
                const adjustedEnd = editor.document.positionAt(adjustedEndOffset);
                const selection = new vscode.Selection(adjustedStart, adjustedEnd);

                // Store original length for offset calculation
                const originalLength = tagOffset.originalLength;

                try {
                    // Get cached surrounding text for optimization
                    const cachedContext = contextCache?.getSurroundingText(tag.range);

                    // Process based on tag type
                    if (isImageTag) {
                        const result = await processSingleImageTag(editor, selection, token, progress, processedCount, totalCount, insertionMode, cachedContext, imageBatchOptions);

                        if (isDeferredResolution(result)) {
                            // DeferredResolution: image src is dynamic or its file is missing.
                            // Collect for phase-2 (do NOT edit / count here). Captures the
                            // already-offset-adjusted start; later phase-1 edits sit at higher
                            // offsets and don't shift this tag.
                            deferredImages.push({
                                item: result,
                                liveStartOffset: adjustedStartOffset,
                                liveLength: result.selectedText.length
                            });
                        } else {
                            // result narrows to AltTextResult | undefined here.
                            // Count success/failure
                            if (result && result.success !== false) {
                                successCount++;
                            } else if (!result) {
                                failureCount++;
                            }

                            if (result && insertionMode === 'confirm') {
                                // Calculate replaced length BEFORE edit
                                const replacedStartOffset = editor.document.offsetAt(result.actualSelection.start);
                                const replacedEndOffset = editor.document.offsetAt(result.actualSelection.end);
                                const replacedLength = replacedEndOffset - replacedStartOffset;

                                const choice = await showConfirmationDialog(
                                    `✅ ALT: ${result.altText}`,
                                    totalCount
                                );

                                const shouldContinue = await handleUserChoice(
                                    choice,
                                    editor,
                                    result.actualSelection,
                                    result.newText,
                                    processedCount,
                                    totalCount
                                );

                                if (!shouldContinue) {
                                    return;
                                }

                                // Update offset delta only when an edit actually occurred.
                                // 'Skip' returns shouldContinue=true without editing, so the
                                // delta must NOT advance (otherwise later tags — including
                                // deferred items — drift).
                                if (choice === 'Insert') {
                                    const newTextLength = result.newText.length;
                                    cumulativeOffsetDelta += (newTextLength - replacedLength);
                                }
                            } else if (result && insertionMode === 'auto') {
                                // Auto mode already edited, calculate offset delta
                                // Note: In auto mode, safeEditDocument was already called in processSingleImageTag
                                // We need to calculate the replaced length based on original vs new text
                                const replacedLength = originalLength; // Use original tag length
                                const newTextLength = result.newText.length;
                                cumulativeOffsetDelta += (newTextLength - replacedLength);
                            }
                        }
                    } else {
                        // Video tag processing
                        const result = await processSingleVideoTag(editor, selection, token, insertionMode, cachedContext, progress, videoBatchOptions);

                        // Count success/failure
                        if (result && result.success !== false) {
                            successCount++;
                        } else if (!result) {
                            failureCount++;
                        }

                        if (result && insertionMode === 'confirm') {
                            // For DECORATIVE case (no aria-label added), skip confirmation dialog
                            if (!result.ariaLabel.includes('not added')) {
                                // Calculate replaced length BEFORE edit
                                const replacedStartOffset = editor.document.offsetAt(result.actualSelection.start);
                                const replacedEndOffset = editor.document.offsetAt(result.actualSelection.end);
                                const replacedLength = replacedEndOffset - replacedStartOffset;

                                // Show individual confirmation dialog with appropriate message
                                // (videoDescriptionLength pre-fetched for the batch above)
                                const message = videoDescriptionLength === 'transcript'
                                    ? `✅ Video description (as comment): ${result.ariaLabel}`
                                    : `✅ aria-label: ${result.ariaLabel}`;

                                const choice = await showConfirmationDialog(
                                    message,
                                    totalCount
                                );

                                const shouldContinue = await handleUserChoice(
                                    choice,
                                    editor,
                                    result.actualSelection,
                                    result.newText,
                                    processedCount,
                                    totalCount
                                );

                                if (!shouldContinue) {
                                    return;
                                }

                                // Update offset delta after edit
                                const newTextLength = result.newText.length;
                                cumulativeOffsetDelta += (newTextLength - replacedLength);
                            }
                        } else if (result && insertionMode === 'auto' && !result.ariaLabel.includes('not added')) {
                            // Auto mode already edited, calculate offset delta
                            // Use replacedLength from result if available (for expanded selections like video comments)
                            const replacedLength = result.replacedLength !== undefined ? result.replacedLength : originalLength;
                            const newTextLength = result.newText.length;
                            cumulativeOffsetDelta += (newTextLength - replacedLength);
                        }
                    }
                } catch (error) {
                    // Increment failure count on error
                    failureCount++;

                    // Display error message
                    if (!(error instanceof CancellationError) && !token?.isCancellationRequested) {
                        const errorMessage = getUserFriendlyErrorMessage(error);
                        vscode.window.showErrorMessage(errorMessage);
                    }
                }

                processedCount++;
            }

            // Clear cache after processing chunk to free memory
            contextCache?.clear();
        }

        // Phase 2: resolve deferred (dynamic / not-found) image tags
        let resolvedDeferred = 0;
        if (deferredImages.length > 0 && !token.isCancellationRequested) {
            const wsFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (wsFolder) {
                vscode.window.showInformationMessage(
                    formatMessage('✋ {0} image(s) need a file selection', deferredImages.length)
                );
                resolvedDeferred = await runDeferredResolutionPhase(
                    editor, deferredImages, wsFolder.uri.fsPath, token, insertionMode,
                    { generationMode, decorativeKeywords }
                );
                successCount += resolvedDeferred;
            }
        }
        resetResolverCache();

        // Surface deferred items the user skipped (Skip / Skip all / Esc / Cancel),
        // or all of them if phase 2 couldn't run (missing workspace folder).
        const deferredSkipped = deferredImages.length - resolvedDeferred;
        if (deferredSkipped > 0) {
            vscode.window.showWarningMessage(
                formatMessage('⚠️ {0} image(s) skipped (no file selected)', deferredSkipped)
            );
        }

        // Display completion message (only for multiple items)
        if (totalCount > 1) {
            const imgCount = imgTags.length;
            const videoCount = videoTags.length;

            if (failureCount === 0) {
                // All successful
                const itemsText = imgCount > 0 && videoCount > 0
                    ? formatMessage('{0} images, {1} video', imgCount, videoCount)
                    : imgCount > 0
                        ? formatMessage('{0} image' + (imgCount > 1 ? 's' : ''), imgCount)
                        : formatMessage('{0} video' + (videoCount > 1 ? 's' : ''), videoCount);
                vscode.window.showInformationMessage(formatMessage('✅ {0} items processed ({1})', totalCount, itemsText));
            } else {
                // Had errors
                vscode.window.showWarningMessage(formatMessage('⚠️ Completed with errors: {0} succeeded, {1} failed', successCount, failureCount));
            }
        }
    });
}

// ALT text generation for img tags
async function generateAltForImages(
    editor: vscode.TextEditor,
    selections: readonly vscode.Selection[]
): Promise<void> {
        // Pre-fetch configuration once (avoids per-image config lookups)
        const insertionMode = getInsertionMode();
        const config = vscode.workspace.getConfiguration('autoAltWriter');
        const generationMode = config.get<string>('altGenerationMode', 'SEO');
        const decorativeKeywords = config.get<string[]>('decorativeKeywords', ['icon-', 'bg-', 'deco-']);
        const imageBatchOptions = { generationMode, decorativeKeywords };

        // Always display progress dialog with indeterminate animation
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating...',
            cancellable: true
        }, async (progress, token) => {
            let processedCount = 0;
            let successCount = 0;
            let failureCount = 0;
            const totalCount = selections.length;

            // Cache for surrounding text to avoid redundant extraction
            let lastSurroundingText: string | undefined;
            let lastSelectionLine: number | undefined;

            // Deferred (dynamic / not-found) image tags collected for phase-2 resolution
            const deferredImages: Array<{ item: DeferredResolution; liveStartOffset: number; liveLength: number }> = [];

            // Pre-capture original offsets for every selection (document is unedited here).
            // Mirrors processMultipleTags so later edits don't invalidate ranges/offsets.
            const selectionOffsets = selections.map(s => ({
                startOffset: editor.document.offsetAt(s.start),
                endOffset: editor.document.offsetAt(s.end),
                originalLength: editor.document.getText(s).length
            }));
            let cumulativeOffsetDelta = 0;

            for (let i = 0; i < selections.length; i++) {
                // Check for cancellation
                if (token?.isCancellationRequested) {
                    vscode.window.showWarningMessage(formatMessage('⏸️ Cancelled ({0}/{1} processed)', processedCount, totalCount));
                    return;
                }

                // Rebuild the live selection from the adjusted offset (earlier phase-1
                // edits shift later tags). Pass THIS, not the stale static selection.
                const off = selectionOffsets[i];
                const adjustedStart = editor.document.positionAt(off.startOffset + cumulativeOffsetDelta);
                const adjustedEnd = editor.document.positionAt(off.endOffset + cumulativeOffsetDelta);
                const selection = new vscode.Selection(adjustedStart, adjustedEnd);

                try {
                    // Determine if we can reuse cached surrounding text
                    // Only reuse if selections are close (within 10 lines)
                    const currentLine = selection.start.line;
                    const canReuseCachedText = lastSelectionLine !== undefined &&
                                              Math.abs(currentLine - lastSelectionLine) <= 10;

                    const cachedSurroundingText = canReuseCachedText ? lastSurroundingText : undefined;

                    // Report progress to show animation
                    const result = await processSingleImageTag(
                        editor,
                        selection,
                        token,
                        progress,
                        processedCount,
                        totalCount,
                        insertionMode,
                        cachedSurroundingText,
                        imageBatchOptions
                    );

                    // Deferred check FIRST so the cast-free narrowing works below.
                    if (isDeferredResolution(result)) {
                        // DeferredResolution: image src is dynamic or its file is missing.
                        // Collect for phase-2 (do NOT edit / count here).
                        // NOTE: this is the cursor path — `off.startOffset` is the cursor
                        // position, not the tag start. extractTagInfo expands to the full tag,
                        // so use the live (already offset-adjusted) tag start from actualSelection.
                        deferredImages.push({
                            item: result,
                            liveStartOffset: editor.document.offsetAt(result.actualSelection.start),
                            liveLength: result.selectedText.length
                        });
                        processedCount++;
                        continue;
                    }

                    // result narrows to AltTextResult | undefined from here.
                    // Update cache for next iteration
                    if (result && result.surroundingText !== undefined) {
                        lastSurroundingText = result.surroundingText;
                        lastSelectionLine = currentLine;
                    }

                    // Count success/failure
                    if (result && result.success !== false) {
                        successCount++;
                    } else if (!result) {
                        // Void returned (error or cancellation)
                        failureCount++;
                    }

                    if (result) {
                        if (insertionMode === 'confirm') {
                            // Show confirmation dialog for each image immediately
                            // Single item: show only Insert and Cancel (no Skip)
                            const choice = await vscode.window.showInformationMessage(
                                `✅ ALT: ${result.altText}`,
                                'Insert',
                                'Cancel'
                            );

                            if (choice === 'Insert') {
                                const success = await safeEditDocument(editor, result.actualSelection, result.newText);
                                if (!success) {
                                    return;
                                }
                                // Document changed: advance delta so later tags stay aligned.
                                cumulativeOffsetDelta += (result.newText.length - off.originalLength);
                            } else if (choice === 'Cancel') {
                                vscode.window.showWarningMessage(formatMessage('⏸️ Cancelled ({0}/{1} processed)', processedCount + 1, totalCount));
                                return;
                            }
                            // If 'Skip', continue to next image
                        } else {
                            // Auto mode: processSingleImageTag already edited the document.
                            // Advance delta so later tags / deferred offsets stay aligned.
                            cumulativeOffsetDelta += (result.newText.length - off.originalLength);
                        }
                    }
                } catch (error) {
                    // Increment failure count on error
                    failureCount++;

                    // Display error message
                    if (!(error instanceof CancellationError) && !token?.isCancellationRequested) {
                        const errorMessage = getUserFriendlyErrorMessage(error);
                        vscode.window.showErrorMessage(errorMessage);
                    }
                }

                processedCount++;
            }

            // Phase 2: resolve deferred (dynamic / not-found) image tags
            let resolvedDeferred = 0;
            if (deferredImages.length > 0 && !token.isCancellationRequested) {
                const wsFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
                if (wsFolder) {
                    vscode.window.showInformationMessage(
                        formatMessage('✋ {0} image(s) need a file selection', deferredImages.length)
                    );
                    resolvedDeferred = await runDeferredResolutionPhase(
                        editor, deferredImages, wsFolder.uri.fsPath, token, insertionMode,
                        { generationMode, decorativeKeywords }
                    );
                    successCount += resolvedDeferred;
                }
            }
            resetResolverCache();

            // Surface deferred items the user skipped (Skip / Skip all / Esc / Cancel),
            // or all of them if phase 2 couldn't run (missing workspace folder).
            const deferredSkipped = deferredImages.length - resolvedDeferred;
            if (deferredSkipped > 0) {
                vscode.window.showWarningMessage(
                    formatMessage('⚠️ {0} image(s) skipped (no file selected)', deferredSkipped)
                );
            }

            // Display completion message
            if (totalCount > 1) {
                if (failureCount === 0) {
                    // All successful
                    vscode.window.showInformationMessage(formatMessage('✅ {0} images processed', totalCount));
                } else {
                    // Had errors
                    vscode.window.showWarningMessage(formatMessage('⚠️ Completed with errors: {0} succeeded, {1} failed', successCount, failureCount));
                }
            }
        });
}

export function deactivate() {}
