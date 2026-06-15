/**
 * Resolves unresolvable image references (dynamic src / not-found files)
 * to a real workspace file via user selection.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { formatMessage } from '../utils/textUtils';

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

// Session-scoped resolution state. Cleared by resetResolverCache().
const sessionMappings = new Map<string, string>();   // unresolvedSrc -> resolved fsPath
const skippedSources = new Set<string>();             // unresolvedSrc the user chose to skip
let skipAllRequested = false;
let candidateCache: { wsRoot: string; files: string[] } | null = null;

const IMAGE_GLOB = '**/*.{png,jpg,jpeg,gif,webp,avif,PNG,JPG,JPEG,GIF,WEBP,AVIF}';
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,.next,out,.vscode}/**';

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

/** Sentinel ids for the non-file QuickPick actions. */
const BROWSE_ID = '__browse__';
const SKIP_ID = '__skip__';
const SKIP_ALL_ID = '__skip_all__';

/** QuickPick item carrying a required `id` (candidate fsPath or a sentinel). */
interface ResolverPickItem extends vscode.QuickPickItem {
    readonly id: string;
}

/** True if `target` resolves inside `wsRoot` (no traversal, not absolute-outside). */
function isInsideWorkspace(target: string, wsRoot: string): boolean {
    const rel = path.relative(wsRoot, target);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
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

    const items: ResolverPickItem[] = ranked.map(p => ({
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

    let chosenPath: string;
    if (picked.id === BROWSE_ID) {
        // Loop the dialog until a valid in-workspace file is chosen or the user cancels.
        for (;;) {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Use for ALT generation',
                defaultUri: vscode.Uri.file(wsRoot),
                filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] }
            });
            const browsedPath = uris && uris[0] ? uris[0].fsPath : undefined;
            if (!browsedPath) { return null; } // dialog cancelled
            if (isInsideWorkspace(browsedPath, wsRoot)) {
                chosenPath = browsedPath;
                break;
            }
            vscode.window.showErrorMessage('🚫 File must be inside the workspace.');
        }
    } else {
        // A ranked candidate — picked.id is the candidate fsPath.
        chosenPath = picked.id;
    }

    sessionMappings.set(unresolvedSrc, chosenPath);
    return chosenPath;
}
