# Manual Image Resolution Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an image tag's `src` is dynamic or its file is not found, let the user manually pick the real image (workspace QuickPick ranked by filename similarity + native file browser) so ALT generation can continue; in batch mode collect unresolved tags and resolve them in a second pass.

**Architecture:** A new single-responsibility module `imagePathResolver.ts` owns candidate scanning, similarity ranking, the QuickPick/`showOpenDialog` UI, and a session-scoped resolution cache (so identical dynamic expressions are asked once). `imageProcessor.ts` stops hard-rejecting dynamic/not-found tags and instead returns a `DeferredResolution`. Both batch entry points in `extension.ts` collect deferred items and run a shared second-pass resolver after their main loop.

**Tech Stack:** TypeScript, VS Code Extension API (`workspace.findFiles`, `window.showQuickPick`, `window.showOpenDialog`), Mocha (TDD ui) tests run via `npm test` inside the VS Code test host.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/services/imagePathResolver.ts` | NEW. Pure helpers (`extractQueryToken`, `levenshtein`, `rankCandidates`) + VS Code helpers (`getWorkspaceImageCandidates`, `resolveImagePath`, `resetResolverCache`) + session cache. |
| `src/services/imageProcessor.ts` | MODIFY. `extractTagInfo` flags dynamic instead of erroring; `loadImageData` signals `'not-found'`; extract reusable `generateAndApplyAlt`; `processSingleImageTag` returns `DeferredResolution`; add `loadImageFile` + `resolveDeferredImage`. |
| `src/extension.ts` | MODIFY. Collect `DeferredResolution` items in both batch loops; add shared `runDeferredResolutionPhase`; update progress/summary text. |
| `src/test/suite/imagePathResolver.test.ts` | NEW. Unit tests for the pure helpers. |
| `CLAUDE.md` | MODIFY. Add manual test checklist items. |

**i18n convention (verified):** `package.nls.json` / `package.nls.ja.json` localize ONLY package.json contribution points (command titles, setting descriptions). Runtime messages in this codebase are plain English string literals passed through `formatMessage` (from `utils/textUtils`) — there is no `vscode.l10n` usage and no `l10n` field in package.json. New resolver UI strings therefore use plain English literals, matching existing messages like `'🚫 Dynamic src not supported'`. No nls changes are needed (no new contribution points).

**Shared types** (defined in `imageProcessor.ts`, imported where needed):

```typescript
export interface DeferredResolution {
    kind: 'needs-manual-resolution';
    unresolvedSrc: string;                 // raw dynamic expression OR not-found path (grouping key)
    reason: 'dynamic' | 'not-found';
    actualSelection: vscode.Selection;     // live range as of phase-1 processing
    selectedText: string;
    tagType: 'img' | 'Image';
    context: { fileName: string; line: number; snippet: string };
}
```

---

## Task 1: Pure helper — `extractQueryToken`

**Files:**
- Create: `src/services/imagePathResolver.ts`
- Test: `src/test/suite/imagePathResolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/test/suite/imagePathResolver.test.ts`:

```typescript
import * as assert from 'assert';
import { extractQueryToken } from '../../services/imagePathResolver';

suite('imagePathResolver', () => {
    suite('extractQueryToken', () => {
        test('takes identifier after last dot inside ${...}', () => {
            assert.strictEqual(extractQueryToken('${product.image}'), 'image');
        });
        test('uses ${...} content even when wrapped in a path', () => {
            assert.strictEqual(extractQueryToken('/assets/${slug}.jpg'), 'slug');
        });
        test('returns a bare JSX variable unchanged', () => {
            assert.strictEqual(extractQueryToken('imageUrl'), 'imageUrl');
        });
        test('uses basename without extension for a plain path', () => {
            assert.strictEqual(extractQueryToken('../images/hero-banner.png'), 'hero-banner');
        });
        test('keeps underscores and digits from a filename', () => {
            assert.strictEqual(extractQueryToken('photos/IMG_1234.JPG'), 'IMG_1234');
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `imagePathResolver` has no export `extractQueryToken` (module not found / undefined is not a function).

- [ ] **Step 3: Write minimal implementation**

Create `src/services/imagePathResolver.ts`:

```typescript
/**
 * Resolves unresolvable image references (dynamic src / not-found files)
 * to a real workspace file via user selection.
 */

import * as path from 'path';

/**
 * Derive a short query string from an unresolvable src, used to rank
 * candidate filenames. Prefers the identifier inside the last `${...}`,
 * falls back to a JSX variable name or a path basename (no extension).
 */
export function extractQueryToken(unresolvedSrc: string): string {
    const tmpl = [...unresolvedSrc.matchAll(/\$\{([^}]*)\}/g)];
    if (tmpl.length > 0) {
        const inner = tmpl[tmpl.length - 1][1];
        const afterDot = inner.split('.').pop() || inner;
        return afterDot.replace(/[^a-zA-Z0-9_-]/g, '');
    }
    if (unresolvedSrc.includes('/') || unresolvedSrc.includes('.')) {
        const base = path.basename(unresolvedSrc);
        const noExt = base.replace(/\.[^.]*$/, '');
        return noExt.replace(/[^a-zA-Z0-9_-]/g, '');
    }
    return unresolvedSrc.replace(/[^a-zA-Z0-9_-]/g, '');
}
```

(Regexes use `[^}]*`, `[^.]*$`, `\.[^.]*$` — no nested quantifiers, ReDoS-safe per CLAUDE.md.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all 5 `extractQueryToken` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/imagePathResolver.ts src/test/suite/imagePathResolver.test.ts
git commit -m "feat: add extractQueryToken for image path resolution"
```

---

## Task 2: Pure helpers — `levenshtein` and `rankCandidates`

**Files:**
- Modify: `src/services/imagePathResolver.ts`
- Test: `src/test/suite/imagePathResolver.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `suite('imagePathResolver', ...)` block in `src/test/suite/imagePathResolver.test.ts` (add the import at top):

```typescript
// add to the top import:
// import { extractQueryToken, levenshtein, rankCandidates } from '../../services/imagePathResolver';

    suite('levenshtein', () => {
        test('classic kitten/sitting distance is 3', () => {
            assert.strictEqual(levenshtein('kitten', 'sitting'), 3);
        });
        test('identical strings have distance 0', () => {
            assert.strictEqual(levenshtein('hero', 'hero'), 0);
        });
    });

    suite('rankCandidates', () => {
        const files = [
            '/ws/img/footer.png',
            '/ws/img/product-image.png',
            '/ws/img/header.png'
        ];
        test('ranks a substring filename match first', () => {
            const ranked = rankCandidates('image', files);
            assert.ok(ranked[0].endsWith('product-image.png'), `got ${ranked[0]}`);
        });
        test('ranks an exact-name match first', () => {
            const ranked = rankCandidates('header', files);
            assert.ok(ranked[0].endsWith('header.png'), `got ${ranked[0]}`);
        });
        test('returns every candidate (no drops)', () => {
            assert.strictEqual(rankCandidates('x', files).length, files.length);
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `levenshtein` / `rankCandidates` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/services/imagePathResolver.ts`:

```typescript
/** Standard Levenshtein edit distance (iterative DP, single row). */
export function levenshtein(a: string, b: string): number {
    if (a === b) { return 0; }
    if (a.length === 0) { return b.length; }
    if (b.length === 0) { return a.length; }
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const curr = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        prev = curr;
    }
    return prev[b.length];
}

/** Score a candidate path against the query (higher = better match). */
function scoreCandidate(query: string, candidatePath: string): number {
    const name = path.basename(candidatePath).replace(/\.[^.]*$/, '').toLowerCase();
    const q = query.toLowerCase();
    if (!q) { return 0; }
    if (name === q) { return 1000; }
    if (name.includes(q) || q.includes(name)) {
        return 500 + Math.max(0, 100 - Math.abs(name.length - q.length));
    }
    const tokens = name.split(/[-_.\s]+/);
    if (tokens.includes(q)) { return 400; }
    const dist = levenshtein(name, q);
    const maxLen = Math.max(name.length, q.length) || 1;
    return Math.round((1 - dist / maxLen) * 300);
}

/** Return candidate paths sorted by descending similarity to query (stable, no drops). */
export function rankCandidates(query: string, candidates: string[]): string[] {
    return candidates
        .map((p, i) => ({ p, i, s: scoreCandidate(query, p) }))
        .sort((a, b) => (b.s - a.s) || (a.i - b.i))
        .map(x => x.p);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — `levenshtein` (2) and `rankCandidates` (3) tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/imagePathResolver.ts src/test/suite/imagePathResolver.test.ts
git commit -m "feat: add levenshtein + rankCandidates for similarity ordering"
```

---

## Task 3: Candidate scanning + session cache (`getWorkspaceImageCandidates`, `resetResolverCache`)

**Files:**
- Modify: `src/services/imagePathResolver.ts`

No unit test (depends on `vscode.workspace.findFiles`; verified by compile + manual test in Task 7).

- [ ] **Step 1: Add the vscode import and module state at the top of the file**

At the very top of `src/services/imagePathResolver.ts`, add the `vscode` import (keep the existing `import * as path`):

```typescript
import * as vscode from 'vscode';
```

After the imports, add module-level state:

```typescript
// Session-scoped resolution state. Cleared by resetResolverCache().
const sessionMappings = new Map<string, string>();   // unresolvedSrc -> resolved fsPath
const skippedSources = new Set<string>();             // unresolvedSrc the user chose to skip
let skipAllRequested = false;
let candidateCache: { wsRoot: string; files: string[] } | null = null;

const IMAGE_GLOB = '**/*.{png,jpg,jpeg,gif,webp,avif,PNG,JPG,JPEG,GIF,WEBP,AVIF}';
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,.next,out,.vscode}/**';
```

- [ ] **Step 2: Add `resetResolverCache` and `getWorkspaceImageCandidates`**

Append to `src/services/imagePathResolver.ts`:

```typescript
/** Clear all session state. Call when a batch finishes or the document changes. */
export function resetResolverCache(): void {
    sessionMappings.clear();
    skippedSources.clear();
    skipAllRequested = false;
    candidateCache = null;
}

/** List workspace image files (cached for the duration of a batch). */
export async function getWorkspaceImageCandidates(wsRoot: string): Promise<string[]> {
    if (candidateCache && candidateCache.wsRoot === wsRoot) {
        return candidateCache.files;
    }
    const uris = await vscode.workspace.findFiles(IMAGE_GLOB, EXCLUDE_GLOB);
    const files = uris.map(u => u.fsPath);
    candidateCache = { wsRoot, files };
    return files;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run compile`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/imagePathResolver.ts
git commit -m "feat: add workspace image candidate scanning with session cache"
```

---

## Task 4: The resolution UI (`resolveImagePath`)

**Files:**
- Modify: `src/services/imagePathResolver.ts`

Depends on VS Code QuickPick/OpenDialog; verified by compile + manual test (Task 7).

- [ ] **Step 1: Add the `formatMessage` import**

At the top of `src/services/imagePathResolver.ts`, alongside the existing imports, add:

```typescript
import { formatMessage } from '../utils/textUtils';
```

- [ ] **Step 2: Implement `resolveImagePath`**

Append to `src/services/imagePathResolver.ts`:

```typescript
/** Sentinel ids for the non-file QuickPick actions. */
const BROWSE_ID = '__browse__';
const SKIP_ID = '__skip__';
const SKIP_ALL_ID = '__skip_all__';

/** True if `target` resolves inside `wsRoot` (no traversal, not absolute-outside). */
function isInsideWorkspace(target: string, wsRoot: string): boolean {
    const rel = path.relative(wsRoot, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve an unresolvable image reference to a real workspace file.
 * Remembers the choice for identical `unresolvedSrc` values within the session.
 * Returns: fsPath | 'skip' | 'skip-all' | null (Esc — skip this occurrence only).
 */
export async function resolveImagePath(
    unresolvedSrc: string,
    reason: 'dynamic' | 'not-found',
    context: { fileName: string; line: number; snippet: string },
    wsRoot: string
): Promise<string | 'skip' | 'skip-all' | null> {
    if (skipAllRequested) { return 'skip-all'; }
    const cached = sessionMappings.get(unresolvedSrc);
    if (cached) { return cached; }
    if (skippedSources.has(unresolvedSrc)) { return 'skip'; }

    const candidates = await getWorkspaceImageCandidates(wsRoot);
    const ranked = rankCandidates(extractQueryToken(unresolvedSrc), candidates);

    const reasonLabel = reason === 'dynamic' ? 'Dynamic src' : 'File not found';

    const items: Array<vscode.QuickPickItem & { id?: string }> = ranked.map(p => ({
        id: p,
        label: path.basename(p),
        description: path.relative(wsRoot, p)
    }));
    items.push(
        { id: BROWSE_ID, label: '$(folder) Browse for a file...' },
        { id: SKIP_ID, label: '$(circle-slash) Skip this image' },
        { id: SKIP_ALL_ID, label: '$(close-all) Skip all remaining' }
    );

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Select image for ALT generation',
        placeHolder: formatMessage(
            '{0}: {1}  (line {2}, {3})',
            reasonLabel, unresolvedSrc, String(context.line), context.fileName
        ),
        matchOnDescription: true
    });

    if (!picked) { return null; } // Esc — skip this occurrence only
    if (picked.id === SKIP_ID) { skippedSources.add(unresolvedSrc); return 'skip'; }
    if (picked.id === SKIP_ALL_ID) { skipAllRequested = true; return 'skip-all'; }

    let chosenPath: string | undefined;
    if (picked.id === BROWSE_ID) {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Use for ALT generation',
            defaultUri: vscode.Uri.file(wsRoot),
            filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] }
        });
        chosenPath = uris && uris[0] ? uris[0].fsPath : undefined;
        if (!chosenPath) { return null; } // dialog cancelled
        if (!isInsideWorkspace(chosenPath, wsRoot)) {
            vscode.window.showErrorMessage('🚫 File must be inside the workspace.');
            return resolveImagePath(unresolvedSrc, reason, context, wsRoot); // re-prompt
        }
    } else {
        chosenPath = picked.id; // a ranked candidate (already inside workspace)
    }

    sessionMappings.set(unresolvedSrc, chosenPath);
    return chosenPath;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run compile`
Expected: no errors.

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/imagePathResolver.ts
git commit -m "feat: add resolveImagePath QuickPick + browse fallback"
```

---

## Task 5: Wire resolver into `imageProcessor.ts`

**Files:**
- Modify: `src/services/imageProcessor.ts`

### 5a — Add `dynamic` to `TagInfo` and stop hard-rejecting dynamic src

- [ ] **Step 1: Add `dynamic` to the `TagInfo` interface**

In `src/services/imageProcessor.ts`, change the `TagInfo` interface (around line 21):

```typescript
interface TagInfo {
    selectedText: string;
    actualSelection: vscode.Selection;
    imageSrc: string;
    imageFileName: string;
    tagType: 'img' | 'Image';
    dynamic: boolean;
}
```

- [ ] **Step 2: Replace the validation + dynamic block in `extractTagInfo`**

Replace lines 125–152 (the block from `// 入力検証` through the final `return { ... }`) with:

```typescript
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
```

- [ ] **Step 3: Verify compile**

Run: `npm run compile`
Expected: errors ONLY about `dynamic` missing elsewhere are not expected (TagInfo is built only here). Should compile clean.

- [ ] **Step 4: Commit**

```bash
git add src/services/imageProcessor.ts
git commit -m "refactor: flag dynamic src instead of rejecting in extractTagInfo"
```

### 5b — Make `loadImageData` signal `'not-found'` and add `loadImageFile`

- [ ] **Step 1: Change `loadImageData` return type and the not-found branch**

Change the signature (around line 171):

```typescript
async function loadImageData(
    imageSrc: string,
    editor: vscode.TextEditor
): Promise<ImageData | 'not-found' | null> {
```

Replace the not-found block (lines 231–235):

```typescript
        if (!fs.existsSync(imagePath)) {
            return 'not-found'; // caller decides whether to offer manual resolution
        }
```

(Leave the SVG, too-large, invalid-path, and URL-fetch branches returning `null` with their existing error messages — those are hard errors, not deferrable.)

- [ ] **Step 2: Add `loadImageFile` for an already-resolved absolute path**

Add this exported helper right after `loadImageData` (it reuses the same validation as the local-file branch, for phase-2 picked files):

```typescript
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
```

- [ ] **Step 3: Verify compile**

Run: `npm run compile`
Expected: a type error at the existing `const imageData = await loadImageData(...)` usage (line ~367) because `'not-found'` is now part of the type. This is fixed in 5d. It is OK for this step to leave that error; do not commit until 5d compiles. (If you prefer a green commit, jump to 5d before committing 5b/5c.)

### 5c — Extract reusable `generateAndApplyAlt`

- [ ] **Step 1: Extract the generation tail into a helper**

Cut the body from line 372 (`// Resolve generation mode ...`) through line 457 (the final `return { ... }`) of `processSingleImageTag` into a new function placed above `processSingleImageTag`:

```typescript
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
    const generationMode = batchOptions?.generationMode
        ?? vscode.workspace.getConfiguration('autoAltWriter').get<string>('altGenerationMode', 'SEO');

    const customPrompts = loadCustomPrompts();
    const geminiModel = getGeminiApiModel(customPrompts);

    let surroundingText: string | undefined;
    if (cachedSurroundingText !== undefined) {
        surroundingText = cachedSurroundingText;
    } else {
        const promptType = generationMode === 'SEO' ? 'seo' : 'a11y';
        if (needsSurroundingText(promptType, undefined, customPrompts)) {
            const contextRange = CONTEXT_RANGE_VALUES.default;
            surroundingText = extractSurroundingText(editor.document, tagInfo.actualSelection, contextRange);
        }
    }

    if (token?.isCancellationRequested) { return; }

    const altText = await generateAltTextWithRetry(
        imageData.base64Image,
        imageData.mimeType,
        generationMode,
        geminiModel,
        token,
        surroundingText,
        API_CONFIG.MAX_RETRIES
    );

    if (token?.isCancellationRequested) { return; }

    const trimmedAlt = altText.trim();
    if (trimmedAlt === SPECIAL_KEYWORDS.DECORATIVE || trimmedAlt === '""' || trimmedAlt === '') {
        const newText = generateDecorativeAlt(tagInfo);
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
            selection, altText: formatMessage('{0} → alt=""', reason), newText,
            actualSelection: tagInfo.actualSelection, success: true, surroundingText
        };
    }

    const newText = applyAltTextToTag(tagInfo.selectedText, altText, tagInfo.tagType);
    if (insertionMode === 'auto') {
        const success = await safeEditDocument(editor, tagInfo.actualSelection, newText);
        if (success) {
            vscode.window.showInformationMessage(formatMessage('✅ ALT: {0}', altText));
        }
    }
    return {
        selection, altText, newText,
        actualSelection: tagInfo.actualSelection, success: true, surroundingText
    };
}
```

### 5d — `processSingleImageTag` returns `DeferredResolution`; add `resolveDeferredImage`

- [ ] **Step 1: Add imports and export the `DeferredResolution` type**

At the top of `src/services/imageProcessor.ts`, add:

```typescript
import { resolveImagePath } from './imagePathResolver';
```

And export the interface (place near the other interfaces):

```typescript
export interface DeferredResolution {
    kind: 'needs-manual-resolution';
    unresolvedSrc: string;
    reason: 'dynamic' | 'not-found';
    actualSelection: vscode.Selection;
    selectedText: string;
    tagType: 'img' | 'Image';
    context: { fileName: string; line: number; snippet: string };
}
```

- [ ] **Step 2: Rewrite the tail of `processSingleImageTag`**

`processSingleImageTag` now ends right after the decorative check and delegates. Replace its signature return type and the body from the decorative guard onward so it reads:

```typescript
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
    const tagInfo = await extractTagInfo(editor, selection);
    if (!tagInfo) { return; }

    // ... KEEP the existing progress-report block unchanged ...

    // Decorative check only for resolvable (static) filenames
    if (!tagInfo.dynamic && isDecorativeImage(tagInfo.imageFileName, batchOptions?.decorativeKeywords)) {
        // ... KEEP the existing decorative-handling block unchanged ...
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
```

- [ ] **Step 3: Add `buildDeferred` and `resolveDeferredImage` helpers**

Add below `processSingleImageTag`:

```typescript
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
```

- [ ] **Step 4: Verify compile + lint**

Run: `npm run compile && npm run lint`
Expected: clean. (Callers in `extension.ts` still treat the result loosely via `result.success !== false`; a `DeferredResolution` has no `success` so it is counted as a "result" today — Task 6 fixes the callers to branch on `kind` first.)

- [ ] **Step 5: Run tests (pure helpers still green)**

Run: `npm test`
Expected: PASS — Task 1/2 tests unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/services/imageProcessor.ts
git commit -m "feat: return DeferredResolution + add resolveDeferredImage"
```

---

## Task 6: Two-phase batch in `extension.ts`

**Files:**
- Modify: `src/extension.ts`

VS Code-integration; verified by compile + lint + manual test (Task 7).

- [ ] **Step 1: Add imports**

At the top of `src/extension.ts`, extend the imageProcessor import and add the resolver reset:

```typescript
import { processSingleImageTag, resolveDeferredImage, DeferredResolution } from './services/imageProcessor';
import { resetResolverCache } from './services/imagePathResolver';
```

- [ ] **Step 2: Add the shared second-pass helper (top-level function in extension.ts)**

Add this function near `processMultipleTags`:

```typescript
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
                `✅ ALT: ${result.altText}`, 'Insert', 'Skip'
            );
            if (choice === 'Insert') {
                const ok = await safeEditDocument(editor, liveSelection, result.newText);
                if (ok) {
                    phase2Delta += (result.newText.length - replacedLen);
                    resolvedCount++;
                }
            }
            // 'Skip' or dismissed → leave unchanged
        } else {
            // auto mode: resolveDeferredImage already edited the document
            phase2Delta += (result.newText.length - entry.liveLength);
            resolvedCount++;
        }
    }
    return resolvedCount;
}
```

- [ ] **Step 3: Collect deferred items in `processMultipleTags`**

Inside the image branch of `processMultipleTags` (around line 284), replace the block that processes the image result so deferred items are collected instead of counted as failures. Declare a collector before the chunk loop (near line 238, beside `cumulativeOffsetDelta`):

```typescript
        const deferredImages: Array<{ item: DeferredResolution; liveStartOffset: number; liveLength: number }> = [];
```

Then change the image-handling block (the `if (isImageTag) { ... }` body, lines ~283–327) to branch on `kind` first:

```typescript
                    if (isImageTag) {
                        const result = await processSingleImageTag(editor, selection, token, progress, processedCount, totalCount, insertionMode, cachedContext, imageBatchOptions);

                        if (result && 'kind' in result && result.kind === 'needs-manual-resolution') {
                            // Defer: do NOT edit, do NOT change offset delta.
                            deferredImages.push({
                                item: result,
                                liveStartOffset: adjustedStartOffset,
                                liveLength: result.selectedText.length
                            });
                        } else {
                            // ... KEEP the existing success/failure counting + confirm/auto
                            //     insertion + cumulativeOffsetDelta block exactly as-is ...
                        }
                    } else {
```

- [ ] **Step 4: Run the resolution phase after the chunk loop in `processMultipleTags`**

Immediately after the chunk loop ends (after line 399 `contextCache?.clear();` closing the `for` over chunks, before the completion message at line 401), insert:

```typescript
        // Phase 2: resolve deferred (dynamic / not-found) image tags
        if (deferredImages.length > 0 && !token.isCancellationRequested) {
            const wsFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (wsFolder) {
                vscode.window.showInformationMessage(
                    formatMessage('✋ {0} image(s) need a file selection', deferredImages.length)
                );
                const resolved = await runDeferredResolutionPhase(
                    editor, deferredImages, wsFolder.uri.fsPath, token, insertionMode,
                    { generationMode, decorativeKeywords }
                );
                successCount += resolved;
            }
        }
        resetResolverCache();
```

- [ ] **Step 5: Mirror the same collection + phase in `generateAltForImages`**

In `generateAltForImages` (line 423+), add a collector before the `for (const selection of selections)` loop:

```typescript
            const deferredImages: Array<{ item: DeferredResolution; liveStartOffset: number; liveLength: number }> = [];
```

Inside the loop, right after obtaining `result` (line ~476) and BEFORE the cache update / success counting, branch out deferred items:

```typescript
                    if (result && 'kind' in result && result.kind === 'needs-manual-resolution') {
                        deferredImages.push({
                            item: result,
                            liveStartOffset: editor.document.offsetAt(result.actualSelection.start),
                            liveLength: result.selectedText.length
                        });
                        processedCount++;
                        continue;
                    }
```

After the `for` loop ends, before the function's closing, add:

```typescript
            if (deferredImages.length > 0 && !token.isCancellationRequested) {
                const wsFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
                if (wsFolder) {
                    vscode.window.showInformationMessage(
                        formatMessage('✋ {0} image(s) need a file selection', deferredImages.length)
                    );
                    successCount += await runDeferredResolutionPhase(
                        editor, deferredImages, wsFolder.uri.fsPath, token, insertionMode,
                        { generationMode, decorativeKeywords }
                    );
                }
            }
            resetResolverCache();
```

(`generateAltForImages` has `imageBatchOptions = { generationMode, decorativeKeywords }` in scope — pass those two values as shown.)

- [ ] **Step 6: Verify compile + lint**

Run: `npm run compile && npm run lint`
Expected: clean.

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS (pure-function suites unaffected).

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts
git commit -m "feat: two-phase batch with deferred manual image resolution"
```

---

## Task 7: Manual test pass + CLAUDE.md checklist

**Files:**
- Modify: `CLAUDE.md`
- Create (scratch, not committed): test HTML files under `testdir/`

- [ ] **Step 1: Build**

Run: `npm run compile && npm run lint && npm test`
Expected: compile clean, lint clean, all unit tests PASS.

- [ ] **Step 2: Create manual test fixtures**

Create `testdir/dynamic-images.html` (place a real image at `testdir/images/hero.png` first):

```html
<img src="/images/hero.png" alt="">
<img src={imageUrl} alt="">
<img src={`/images/${slug}.jpg`} alt="">
<img src="/images/does-not-exist.png" alt="">
<img src={imageUrl} alt="">
```

- [ ] **Step 3: Launch the Extension Development Host and exercise the flows**

Press F5 in VS Code (or run the "Run Extension" launch config). In the dev host, open `testdir/dynamic-images.html`, select all, run the batch ALT command, and verify:

- Static `/images/hero.png` is processed in phase 1 (auto/confirm per setting).
- After phase 1, the "✋ N image(s) need a file selection" message appears.
- Phase 2 opens a QuickPick for `imageUrl` showing ranked workspace images + "Browse..." + "Skip" + "Skip all remaining".
- Picking a file generates ALT and inserts it into the correct `<img>` tag (offsets correct).
- The SECOND `src={imageUrl}` is auto-resolved WITHOUT a second prompt (session cache dedupe).
- "Browse..." opens Finder; selecting a file OUTSIDE the workspace shows the workspace error and re-prompts.
- "Skip" leaves one tag unchanged and continues; "Skip all remaining" stops phase 2.
- `/images/does-not-exist.png` (not-found) is offered for resolution.
- Single-tag command (cursor in one dynamic tag) opens the QuickPick immediately.

- [ ] **Step 4: Add manual checklist items to CLAUDE.md**

In `CLAUDE.md`, under "Manual Testing Checklist", add:

```markdown
- [ ] Dynamic src (variable / template literal) → manual file resolution
- [ ] Not-found static path → manual file resolution
- [ ] Batch: deferred items resolved in second pass (offsets stay correct)
- [ ] Identical dynamic expression asked only once (session cache dedupe)
- [ ] Browse opens native file dialog; workspace-external file rejected
- [ ] Skip / Skip all remaining / Esc behaviors
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add manual test checklist for image resolution fallback"
```

---

## Self-Review Notes

- **Spec coverage:** dynamic + not-found trigger (5a/5b), defer-to-end batch (Task 6), similarity-ranked QuickPick + browse (Tasks 2/4), workspace-only via `isInsideWorkspace` (Task 4), session-cache dedupe of identical expressions (Task 4 state + Task 6 ordering), context-rich prompt placeholder (`buildDeferred` line/snippet → QuickPick placeHolder), status messaging (Task 6 "✋ N images" + existing summary), unit tests for pure helpers (Tasks 1/2), manual checklist (Task 7). All spec sections mapped.
- **Type consistency:** `DeferredResolution` shape identical in spec and Task 5d; `resolveImagePath` returns `string | 'skip' | 'skip-all' | null` consistently consumed by `resolveDeferredImage`, which returns `AltTextResult | 'skip' | 'skip-all' | void` consumed by `runDeferredResolutionPhase`. `loadImageData` return widened to `ImageData | 'not-found' | null`; `loadImageFile` returns `ImageData | null`.
- **i18n:** Resolver UI strings are plain English literals (with `formatMessage` for placeholders), matching the codebase's runtime-message convention. No `package.nls.*` changes (those cover package.json contribution points only).
