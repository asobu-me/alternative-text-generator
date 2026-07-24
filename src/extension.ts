import * as vscode from 'vscode';

// Utils
import { safeEditDocument } from './utils/security';
import { detectTagType, detectAllTags } from './utils/tagUtils';
import { getInsertionMode, clearOutputLanguageCache } from './utils/config';
import { initApiKeyStore, setUserApiKey, clearUserApiKey, getUserApiKey } from './utils/apiKey';
import { initFreeTierNotice, ensureFreeTierConsent } from './utils/freeTierNotice';
import { getUserFriendlyErrorMessage } from './utils/errorHandler';
import { CancellationError } from './utils/errors';
import { createContextCache } from './utils/contextGrouping';
import { showError, showWarning, showInfo, showErrorForException, openFolderAction } from './utils/notify';

// Services
import { processSingleImageTag, resolveDeferredImage, DeferredResolution } from './services/imageProcessor';
import { resetResolverCache } from './services/imagePathResolver';
import { processSingleVideoTag } from './services/videoProcessor';

/**
 * Starter content for the custom prompts file.
 *
 * One section, so creating the file changes exactly one prompt. The rest are listed in
 * a comment: adding them is a matter of typing a heading, and comments never reach the
 * model, so the guidance costs nothing at generation time.
 */
function buildCustomPromptsTemplate(): string {
    return [
        vscode.l10n.t('<!-- Write what you want under a heading. Only the sections you write are overridden. -->'),
        '',
        '# SEO',
        '',
        vscode.l10n.t('You are an SEO expert. Describe the subject using the words people would search for. Include the product name when it is legible.'),
        '',
        vscode.l10n.t('<!-- Other headings you can add: A11Y (alt for screen readers), Video (aria-label), Transcript -->'),
        ''
    ].join('\n');
}

/**
 * Create `.vscode/custom-prompts.md` and open it. An existing file is opened, never
 * overwritten — this command must be safe to run twice.
 */
async function createCustomPromptsFile(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        await showError(vscode.l10n.t('Open a folder first — the prompts file is created inside your workspace.'), openFolderAction());
        return;
    }

    const target = vscode.Uri.joinPath(folder.uri, '.vscode', 'custom-prompts.md');
    let created = false;
    try {
        await vscode.workspace.fs.stat(target);
    } catch {
        await vscode.workspace.fs.writeFile(target, Buffer.from(buildCustomPromptsTemplate(), 'utf8'));
        created = true;
    }

    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));

    // Say what will happen next: the connection between this file and the generated
    // text is otherwise invisible until the next run.
    showInfo(created
        ? vscode.l10n.t('Created .vscode/custom-prompts.md. It is used from the next generation onwards.')
        : vscode.l10n.t('.vscode/custom-prompts.md already exists, so it was left as it is.'));
}

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
    // Initialize the user API key store (SecretStorage). Must run before any
    // generation command so Bring-Your-Own-Key routing works.
    initApiKeyStore(context);
    initFreeTierNotice(context);

    // Watch for configuration changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
        // Clear output language cache when output language setting changes
        if (e.affectsConfiguration('autoAltWriter.outputLanguage')) {
            clearOutputLanguageCache();
        }
    });
    context.subscriptions.push(configWatcher);

    // Command: set your own Gemini API key (stored in SecretStorage).
    // With a key set, requests go directly to Google using your free/paid quota
    // instead of the shared bundled proxy.
    const setKeyDisposable = vscode.commands.registerCommand('auto-alt-writer.setApiKey', async () => {
        const hasKey = (await getUserApiKey()) !== undefined;
        const key = await vscode.window.showInputBox({
            title: vscode.l10n.t('Auto ALT Text Writer: Set your Gemini API key'),
            prompt: hasKey
                ? vscode.l10n.t('A key is already stored. Enter a new key to replace it — get one from Google AI Studio.')
                : vscode.l10n.t('Enter your Gemini API key from Google AI Studio. Leave empty to cancel.'),
            placeHolder: 'AIza...',
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) => {
                const trimmed = value.trim();
                if (trimmed.length === 0) {
                    return null; // empty = cancel, handled below
                }
                return trimmed.length < 20 ? vscode.l10n.t('That does not look like a Gemini API key.') : null;
            }
        });

        // Undefined (Esc) or empty input → cancel without changing anything.
        if (key === undefined || key.trim().length === 0) {
            return;
        }

        await setUserApiKey(key);
        showInfo(vscode.l10n.t('API key saved. Requests now go directly to Google using your own quota.'));
    });
    context.subscriptions.push(setKeyDisposable);

    // Command: remove the stored key and revert to the shared proxy.
    const clearKeyDisposable = vscode.commands.registerCommand('auto-alt-writer.clearApiKey', async () => {
        const hasKey = (await getUserApiKey()) !== undefined;
        if (!hasKey) {
            showInfo(vscode.l10n.t('No API key is stored. Requests already use the shared free tier.'));
            return;
        }
        await clearUserApiKey();
        showInfo(vscode.l10n.t('API key removed. Requests now use the shared free tier.'));
    });
    context.subscriptions.push(clearKeyDisposable);

    // Command: scaffold the custom prompts file.
    //
    // Nobody should have to read documentation to find out what this file looks like,
    // so the command writes a working one and opens it. It contains ONE section: a
    // template with all six would silently replace every built-in prompt the moment it
    // was created, which contradicts the rule that only what you write is overridden.
    const createPromptsDisposable = vscode.commands.registerCommand(
        'auto-alt-writer.createCustomPrompts',
        () => createCustomPromptsFile()
    );
    context.subscriptions.push(createPromptsDisposable);

    // Smart ALT/aria-label generation command (auto-detect tag type)
    const disposable = vscode.commands.registerCommand('auto-alt-writer.generateAlt', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            showError(vscode.l10n.t('No file is open. Open a file containing <img> or <video> tags and try again.'));
            return;
        }

        // Nothing is sent to Google until the user consents on first free-tier use.
        if (!await ensureFreeTierConsent()) {
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
                showError(vscode.l10n.t('No <img> or <video> tag at the cursor. Place the cursor inside a tag, or select a range containing one.'));
                return;
            }
        } else {
            // Detect all tags within selection
            const allTags = detectAllTags(editor, firstSelection);

            if (allTags.length === 0) {
                showError(vscode.l10n.t('No <img> or <video> tag in the selection. Select the whole tag and try again.'));
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
            showError(vscode.l10n.t('No file is open. Open a file containing <img> or <video> tags and try again.'));
            return;
        }

        // Nothing is sent to Google until the user consents on first free-tier use.
        if (!await ensureFreeTierConsent()) {
            return;
        }

        const selection = editor.selection;

        // Get insertion mode from settings
        const config = vscode.workspace.getConfiguration('autoAltWriter');
        const insertionMode = config.get<'auto' | 'confirm'>('insertionMode', 'confirm');
        const videoDescriptionLength = config.get<'summary' | 'transcript'>('videoDescriptionMode', 'summary');

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: progressTitle(0, 1, videoDescriptionLength),
            cancellable: true
        }, async (progress, token) => {
            try {
                const result = await processSingleVideoTag(editor, selection, token, insertionMode, undefined, progress);

                // Show result dialog for confirm mode
                if (result && insertionMode === 'confirm') {
                    // 'described' is a deliberate no-op — report it, never offer to insert it.
                    if (result.outcome === 'described') {
                        showInfo(result.ariaLabel);
                    } else {
                        const choice = await askToInsert(
                            buildReviewMessage(result.fileName, result.ariaLabel, true, 1, 1),
                            false
                        );
                        if (choice === 'insert') {
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
                await showErrorForException(error, getUserFriendlyErrorMessage(error));
            }
        });
    });

    context.subscriptions.push(videoDisposable);
    // Note: no API-key commands. The Gemini API key is never stored in the
    // extension — all requests are routed through a server-side proxy (see /proxy).
}

// ---------------------------------------------------------------------------
// Notification copy helpers
// ---------------------------------------------------------------------------

/**
 * Progress-notification title: a verb phrase naming what is being produced.
 * VS Code renders "title: message", so the title carries the verb and the
 * per-item message (built in the processors) carries position + filename.
 * The total never appears here — it already lives in the counter.
 */
function progressTitle(imgCount: number, videoCount: number, videoMode: 'summary' | 'transcript'): string {
    if (imgCount > 0 && videoCount > 0) {
        return vscode.l10n.t('Generating alternative text');
    }
    if (videoCount > 0) {
        return videoMode === 'transcript'
            ? vscode.l10n.t('Generating video transcript')
            : vscode.l10n.t('Generating aria-label');
    }
    return vscode.l10n.t('Generating alt text');
}

/**
 * Body of a review dialog. Without the filename a user reviewing a 12-item batch
 * cannot tell which image a suggestion belongs to, so `isPhrase` results are
 * rendered as "file → suggestion". Decorative / already-described results are
 * complete sentences that already name their file, and are shown verbatim —
 * wrapping those would print the filename twice.
 */
function buildReviewMessage(fileName: string, text: string, isPhrase: boolean, index: number, total: number): string {
    const position = total > 1 ? `${index}/${total}  ` : '';
    return position + (isPhrase ? `${fileName} → ${text}` : text);
}

/** What the user decided about one generated suggestion. */
type ReviewChoice = 'insert' | 'skip' | 'cancel';

/**
 * Ask whether to insert one suggestion.
 * Dismissing the notification (Esc) is treated as Skip: it leaves this item
 * untouched without abandoning the rest of the batch.
 */
async function askToInsert(message: string, allowSkip: boolean): Promise<ReviewChoice> {
    const insert = vscode.l10n.t('Insert');
    const skip = vscode.l10n.t('Skip');
    const cancel = vscode.l10n.t('Cancel');

    const picked = allowSkip
        ? await vscode.window.showInformationMessage(message, insert, skip, cancel)
        : await vscode.window.showInformationMessage(message, insert, cancel);

    if (picked === insert) { return 'insert'; }
    if (picked === cancel) { return 'cancel'; }
    return 'skip';
}

/**
 * Per-batch outcome counters. `skipped` is tracked separately from `inserted`
 * because a confirm-mode run where the user skips most suggestions is not the
 * same as one where everything was written — the completion message must say so.
 */
interface Tally {
    inserted: number;
    skipped: number;
    failed: number;
    /** Items that correctly received nothing (already described by nearby copy). */
    noChangeNeeded: number;
}

function newTally(): Tally {
    return { inserted: 0, skipped: 0, failed: 0, noChangeNeeded: 0 };
}

/** "3 images" / "1 video" — used only where a breakdown adds information. */
function countLabel(count: number, kind: 'image' | 'video'): string {
    if (kind === 'image') {
        return count === 1 ? vscode.l10n.t('1 image') : vscode.l10n.t('{0} images', count);
    }
    return count === 1 ? vscode.l10n.t('1 video') : vscode.l10n.t('{0} videos', count);
}

/**
 * Final notification for a batch. A clean run states the achievement in one
 * number; any skip or failure switches to the full breakdown so nothing is
 * silently lost. Single-item runs stay quiet — the per-item notification and the
 * edit itself are the feedback.
 */
function reportCompletion(tally: Tally, imgCount: number, videoCount: number): void {
    const total = imgCount + videoCount;
    if (total <= 1) { return; }

    if (tally.skipped === 0 && tally.failed === 0 && tally.noChangeNeeded === 0) {
        const message = imgCount > 0 && videoCount > 0
            ? vscode.l10n.t('Added alternative text to {0} items ({1}, {2}).', total, countLabel(imgCount, 'image'), countLabel(videoCount, 'video'))
            : videoCount > 0
                ? vscode.l10n.t('Added aria-labels to {0}.', countLabel(videoCount, 'video'))
                : vscode.l10n.t('Added alt text to {0}.', countLabel(imgCount, 'image'));
        showInfo(message);
        return;
    }

    // Only non-zero outcomes appear, so nothing is silently dropped and no slot
    // reads "0 failed" when there were no failures at all.
    const parts: string[] = [];
    if (tally.inserted > 0) { parts.push(vscode.l10n.t('{0} added', tally.inserted)); }
    if (tally.noChangeNeeded > 0) { parts.push(vscode.l10n.t('{0} already described', tally.noChangeNeeded)); }
    if (tally.skipped > 0) { parts.push(vscode.l10n.t('{0} skipped', tally.skipped)); }
    if (tally.failed > 0) { parts.push(vscode.l10n.t('{0} failed', tally.failed)); }

    const summary = vscode.l10n.t('Done: {0}.', parts.join(vscode.l10n.t(', ')));
    if (tally.failed > 0) {
        showWarning(summary);
    } else {
        showInfo(summary);
    }
}

/** Warning shown when the user aborts a batch part-way through. */
function reportCancelled(processed: number, total: number): void {
    showWarning(vscode.l10n.t('Cancelled — {0} of {1} items processed.', processed, total));
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

    for (const [i, entry] of ordered.entries()) {
        if (token.isCancellationRequested) { break; }

        const start = editor.document.positionAt(entry.liveStartOffset + phase2Delta);
        const end = editor.document.positionAt(entry.liveStartOffset + phase2Delta + entry.liveLength);
        const liveSelection = new vscode.Selection(start, end);

        // The picker's own title announces how many prompts remain, so this phase
        // needs no separate heads-up notification — the old one was covered by the
        // very picker it was announcing.
        const position = { index: i + 1, total: ordered.length };

        const result = await resolveDeferredImage(
            editor, entry.item, liveSelection, wsRoot, token, insertionMode, batchOptions, position
        );

        if (result === 'skip-all') { break; }
        if (result === 'skip' || !result) { continue; }

        // result is an AltTextResult
        if (insertionMode === 'confirm') {
            const replacedLen = entry.liveLength;
            const choice = await askToInsert(
                buildReviewMessage(result.fileName, result.altText, result.outcome === 'alt', position.index, position.total),
                true
            );
            if (choice === 'cancel') { break; }   // abort remaining deferred resolutions
            if (choice === 'insert') {
                const ok = await safeEditDocument(editor, liveSelection, result.newText);
                if (ok) {
                    phase2Delta += (result.newText.length - replacedLen);
                    resolvedCount++;
                }
            }
            // 'skip' (button or Esc) → leave unchanged, continue
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

    // Extract surrounding text only when context analysis is turned on.
    const contextRange = needsSurroundingText() ? CONTEXT_RANGE_VALUES.default : 0;

    const totalCount = imgTags.length + videoTags.length;

    const batch = vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: progressTitle(imgTags.length, videoTags.length, videoDescriptionLength),
        cancellable: true
    }, async (progress, token) => {
        let processedCount = 0;
        const tally = newTally();

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
            const contextCache = await createContextCache(editor.document, chunk, contextRange, contextRange > 0);

            // Process each tag in the chunk
            for (let j = 0; j < chunk.length; j++) {
                const tag = chunk[j];
                const tagIndex = i + j;
                const tagOffset = tagOffsets[tagIndex];

                if (token.isCancellationRequested) {
                    reportCancelled(processedCount, totalCount);
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
                        } else if (!result) {
                            // result narrows to AltTextResult | undefined here.
                            tally.failed++;
                        } else {
                            if (insertionMode === 'confirm') {
                                // Calculate replaced length BEFORE edit
                                const replacedStartOffset = editor.document.offsetAt(result.actualSelection.start);
                                const replacedEndOffset = editor.document.offsetAt(result.actualSelection.end);
                                const replacedLength = replacedEndOffset - replacedStartOffset;

                                const choice = await askToInsert(
                                    buildReviewMessage(result.fileName, result.altText, result.outcome === 'alt', processedCount + 1, totalCount),
                                    totalCount > 1
                                );

                                if (choice === 'cancel') {
                                    reportCancelled(processedCount, totalCount);
                                    return;
                                }

                                if (choice === 'insert') {
                                    const ok = await safeEditDocument(editor, result.actualSelection, result.newText);
                                    if (!ok) {
                                        tally.failed++;
                                        return;
                                    }
                                    tally.inserted++;
                                    // Update offset delta only when an edit actually occurred.
                                    // A skip leaves the document untouched, so the delta must NOT
                                    // advance (otherwise later tags — including deferred items — drift).
                                    cumulativeOffsetDelta += (result.newText.length - replacedLength);
                                } else {
                                    tally.skipped++;
                                }
                            } else if (insertionMode === 'auto') {
                                tally.inserted++;
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
                        const result = await processSingleVideoTag(
                            editor, selection, token, insertionMode, cachedContext, progress, videoBatchOptions,
                            { index: processedCount + 1, total: totalCount }
                        );

                        if (!result) {
                            tally.failed++;
                        } else if (result.outcome === 'described') {
                            // Deliberate no-op: the surrounding text already covers this
                            // video, so no attribute is added and no dialog is shown.
                            tally.noChangeNeeded++;
                        } else if (insertionMode === 'confirm') {
                            // Calculate replaced length BEFORE edit
                            const replacedStartOffset = editor.document.offsetAt(result.actualSelection.start);
                            const replacedEndOffset = editor.document.offsetAt(result.actualSelection.end);
                            const replacedLength = replacedEndOffset - replacedStartOffset;

                            const choice = await askToInsert(
                                buildReviewMessage(result.fileName, result.ariaLabel, true, processedCount + 1, totalCount),
                                totalCount > 1
                            );

                            if (choice === 'cancel') {
                                reportCancelled(processedCount, totalCount);
                                return;
                            }

                            if (choice === 'insert') {
                                const ok = await safeEditDocument(editor, result.actualSelection, result.newText);
                                if (!ok) {
                                    tally.failed++;
                                    return;
                                }
                                tally.inserted++;
                                // Only advance the delta on an actual edit — a skip leaves
                                // the document unchanged.
                                cumulativeOffsetDelta += (result.newText.length - replacedLength);
                            } else {
                                tally.skipped++;
                            }
                        } else {
                            // Auto mode already edited, calculate offset delta
                            // Use replacedLength from result if available (for expanded selections like video comments)
                            tally.inserted++;
                            const replacedLength = result.replacedLength !== undefined ? result.replacedLength : originalLength;
                            const newTextLength = result.newText.length;
                            cumulativeOffsetDelta += (newTextLength - replacedLength);
                        }
                    }
                } catch (error) {
                    // Increment failure count on error
                    tally.failed++;

                    // Display error message
                    if (!(error instanceof CancellationError) && !token?.isCancellationRequested) {
                        await showErrorForException(error, getUserFriendlyErrorMessage(error));
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
                resolvedDeferred = await runDeferredResolutionPhase(
                    editor, deferredImages, wsFolder.uri.fsPath, token, insertionMode,
                    { generationMode, decorativeKeywords }
                );
                tally.inserted += resolvedDeferred;
            }
        }

        // Deferred items the user skipped (Skip / Skip all / Esc / Cancel), or all
        // of them if phase 2 couldn't run (missing workspace folder). Folding these
        // into the tally keeps the completion message from over-reporting success.
        tally.skipped += deferredImages.length - resolvedDeferred;

        reportCompletion(tally, imgTags.length, videoTags.length);
    });

    // The resolver's session state (src → chosen file, skip-all, candidate list)
    // must not outlive the run. Cancelling returns early from several points
    // inside the callback, so the reset has to sit in a finally around the whole
    // batch — otherwise the next run silently reuses the previous run's choices.
    try {
        await batch;
    } finally {
        resetResolverCache();
    }
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
        const batch = vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: progressTitle(selections.length, 0, 'summary'),
            cancellable: true
        }, async (progress, token) => {
            let processedCount = 0;
            const tally = newTally();
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
                    reportCancelled(processedCount, totalCount);
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

                    if (!result) {
                        // Void returned (error or cancellation)
                        tally.failed++;
                    } else if (insertionMode === 'confirm') {
                        // Show confirmation dialog for each image immediately.
                        // Skip is offered only when there is a rest of the batch to skip to.
                        const choice = await askToInsert(
                            buildReviewMessage(result.fileName, result.altText, result.outcome === 'alt', processedCount + 1, totalCount),
                            totalCount > 1
                        );

                        if (choice === 'cancel') {
                            reportCancelled(processedCount, totalCount);
                            return;
                        }

                        if (choice === 'insert') {
                            const success = await safeEditDocument(editor, result.actualSelection, result.newText);
                            if (!success) {
                                tally.failed++;
                                return;
                            }
                            tally.inserted++;
                            // Document changed: advance delta so later tags stay aligned.
                            cumulativeOffsetDelta += (result.newText.length - off.originalLength);
                        } else {
                            tally.skipped++;
                        }
                    } else {
                        // Auto mode: processSingleImageTag already edited the document.
                        // Advance delta so later tags / deferred offsets stay aligned.
                        tally.inserted++;
                        cumulativeOffsetDelta += (result.newText.length - off.originalLength);
                    }
                } catch (error) {
                    // Increment failure count on error
                    tally.failed++;

                    // Display error message
                    if (!(error instanceof CancellationError) && !token?.isCancellationRequested) {
                        await showErrorForException(error, getUserFriendlyErrorMessage(error));
                    }
                }

                processedCount++;
            }

            // Phase 2: resolve deferred (dynamic / not-found) image tags
            let resolvedDeferred = 0;
            if (deferredImages.length > 0 && !token.isCancellationRequested) {
                const wsFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
                if (wsFolder) {
                    resolvedDeferred = await runDeferredResolutionPhase(
                        editor, deferredImages, wsFolder.uri.fsPath, token, insertionMode,
                        { generationMode, decorativeKeywords }
                    );
                    tally.inserted += resolvedDeferred;
                }
            }

            // Deferred items the user skipped (Skip / Skip all / Esc / Cancel), or all
            // of them if phase 2 couldn't run (missing workspace folder).
            tally.skipped += deferredImages.length - resolvedDeferred;

            reportCompletion(tally, totalCount, 0);
        });

        // Reset in a finally: the callback returns early on cancellation, which
        // would otherwise leak this run's src → file choices into the next one.
        try {
            await batch;
        } finally {
            resetResolverCache();
        }
}

export function deactivate() {}
