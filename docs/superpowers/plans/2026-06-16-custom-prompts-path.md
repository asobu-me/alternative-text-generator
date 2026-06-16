# Flexible & Secure Custom-Prompts Path Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `autoAltWriter.customFilePath` accept an absolute/`~` path for a shared global prompts file while making it impossible for a repository to exfiltrate files outside the workspace via that setting or via symlinks.

**Architecture:** Replace the string-only path check in `loadCustomPrompts()` with two new functions in `src/utils/security.ts`: a pure `selectTrustedPromptValue()` that picks the effective setting value by origin (global = trusted, repo = untrusted), and `resolveSafePromptPath()` that expands `~`, resolves relative paths under the workspace, and re-checks containment using `fs.realpathSync` (closing the symlink-escape hole). `loadCustomPrompts()` is simplified to call them.

**Tech Stack:** TypeScript, VS Code Extension API (`workspace.getConfiguration().inspect`), Node `fs`/`os`/`path`, Mocha (`tdd` UI) run via `npm test` inside the extension host.

---

## File Structure

- **Modify** `src/utils/security.ts` — add `isAbsoluteOrTilde`, `selectTrustedPromptValue`, `resolveSafePromptPath` (+ private `expandTilde`, `validateExistingFile`) and the `PromptPathInspect` / `SelectedPromptValue` types. This file already owns path-security logic (`sanitizeFilePath`).
- **Modify** `src/core/prompts.ts` — add `resolveCustomPromptsPath()`, simplify `loadCustomPrompts()` to use it, delete the now-unused `isPathInWorkspace()`. Add `os` import.
- **Modify** `src/test/suite/security.test.ts` — add `selectTrustedPromptValue` and `resolveSafePromptPath` suites (the latter uses real temp dirs + symlinks).
- **Modify** `CLAUDE.md` — document the trust model for the prompts path.

> **Test command (used throughout):** `npm test`. It compiles, lints, then runs the full Mocha suite inside the VS Code extension host (`security.ts` imports `vscode`, so bare mocha cannot load it). Tests are added to the existing `security` suite.

---

### Task 1: Pure setting-value selection by origin (`selectTrustedPromptValue`)

**Files:**
- Modify: `src/utils/security.ts`
- Test: `src/test/suite/security.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this suite inside the top-level `suite('security', () => { ... })` block in `src/test/suite/security.test.ts` (after the `escapeHtml` suite):

```typescript
    suite('selectTrustedPromptValue', () => {
        test('picks a repo (workspace) relative value as untrusted', () => {
            const r = selectTrustedPromptValue({
                defaultValue: '.vscode/custom-prompts.md',
                workspaceValue: 'config/prompts.md',
            });
            assert.deepStrictEqual(r, { value: 'config/prompts.md', trusted: false });
        });

        test('workspaceFolderValue takes precedence over workspaceValue', () => {
            const r = selectTrustedPromptValue({
                workspaceValue: 'a.md',
                workspaceFolderValue: 'b.md',
            });
            assert.deepStrictEqual(r, { value: 'b.md', trusted: false });
        });

        test('rejects a repo ABSOLUTE value and falls back to the global value', () => {
            const r = selectTrustedPromptValue({
                defaultValue: '.vscode/custom-prompts.md',
                globalValue: '/Users/me/prompts.md',
                workspaceValue: '/Users/victim/.ssh/id_rsa',
            });
            assert.deepStrictEqual(r, { value: '/Users/me/prompts.md', trusted: true });
        });

        test('rejects a repo absolute value and falls back to default when no global', () => {
            const r = selectTrustedPromptValue({
                defaultValue: '.vscode/custom-prompts.md',
                workspaceValue: '/etc/passwd',
            });
            assert.deepStrictEqual(r, { value: '.vscode/custom-prompts.md', trusted: true });
        });

        test('rejects a repo tilde value as untrusted-absolute', () => {
            const r = selectTrustedPromptValue({
                defaultValue: '.vscode/custom-prompts.md',
                workspaceValue: '~/secrets.md',
            });
            assert.deepStrictEqual(r, { value: '.vscode/custom-prompts.md', trusted: true });
        });

        test('allows a global absolute value as trusted', () => {
            const r = selectTrustedPromptValue({ globalValue: '/Users/me/prompts.md' });
            assert.deepStrictEqual(r, { value: '/Users/me/prompts.md', trusted: true });
        });

        test('repo relative value overrides a global absolute value', () => {
            const r = selectTrustedPromptValue({
                globalValue: '/Users/me/prompts.md',
                workspaceValue: 'config/prompts.md',
            });
            assert.deepStrictEqual(r, { value: 'config/prompts.md', trusted: false });
        });

        test('returns null when nothing is set', () => {
            assert.strictEqual(selectTrustedPromptValue({}), null);
        });
    });
```

Add `selectTrustedPromptValue` to the import block at the top of the test file:

```typescript
import {
    validateImageSrc,
    sanitizeFilePath,
    escapeHtml,
    validateRemoteImageUrl,
    selectTrustedPromptValue
} from '../../utils/security';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — compile/type error or assertion failures because `selectTrustedPromptValue` does not exist yet.

- [ ] **Step 3: Implement `isAbsoluteOrTilde` and `selectTrustedPromptValue`**

In `src/utils/security.ts`, add `import * as fs from 'fs';` and `import * as os from 'os';` near the top (alongside the existing `import * as path from 'path';`). Then append:

```typescript
/**
 * Subset of vscode WorkspaceConfiguration.inspect() result needed for prompt-path
 * trust decisions. Kept vscode-free so the selection logic stays pure/testable.
 */
export interface PromptPathInspect {
    defaultValue?: string;
    globalValue?: string;
    workspaceValue?: string;
    workspaceFolderValue?: string;
}

/** A chosen setting value plus whether its origin is trusted to point outside the workspace. */
export interface SelectedPromptValue {
    value: string;
    /** true → global (User) or built-in default origin; absolute paths are permitted. */
    trusted: boolean;
}

/** True if the value is an absolute path or a tilde (home) path. */
export function isAbsoluteOrTilde(value: string): boolean {
    return path.isAbsolute(value) || value === '~' || value.startsWith('~/') || value.startsWith('~\\');
}

/**
 * Choose the effective custom-prompts setting value, honoring VS Code precedence
 * (folder > workspace > global > default) but with a security override:
 * a repository-supplied (workspace/folder) ABSOLUTE or ~ path is rejected, falling
 * back to the global value, then the default. Only global/default origins are trusted
 * to point outside the workspace. Pure function: no fs / vscode access.
 */
export function selectTrustedPromptValue(inspect: PromptPathInspect): SelectedPromptValue | null {
    const untrusted = inspect.workspaceFolderValue ?? inspect.workspaceValue;

    if (untrusted !== undefined && !isAbsoluteOrTilde(untrusted)) {
        return { value: untrusted, trusted: false };
    }
    // (untrusted absolute/~ is silently dropped here — fall through to trusted origins)

    if (inspect.globalValue !== undefined) {
        return { value: inspect.globalValue, trusted: true };
    }
    if (inspect.defaultValue !== undefined) {
        return { value: inspect.defaultValue, trusted: true };
    }
    return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — the new `selectTrustedPromptValue` suite is green and all pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/security.ts src/test/suite/security.test.ts
git commit -m "feat(security): add origin-based custom-prompts value selection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Safe path resolution with realpath containment (`resolveSafePromptPath`)

**Files:**
- Modify: `src/utils/security.ts`
- Test: `src/test/suite/security.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `resolveSafePromptPath` to the test import block:

```typescript
import {
    validateImageSrc,
    sanitizeFilePath,
    escapeHtml,
    validateRemoteImageUrl,
    selectTrustedPromptValue,
    resolveSafePromptPath
} from '../../utils/security';
```

Add `fs` and `os` to the test file's Node imports at the top (next to `import * as path from 'path';`):

```typescript
import * as fs from 'fs';
import * as os from 'os';
```

Add this suite inside `suite('security', () => { ... })`:

```typescript
    suite('resolveSafePromptPath', () => {
        let ws: string;        // workspace root (realpath-normalized)
        let outside: string;   // a sibling dir outside the workspace
        let home: string;      // fake home dir for ~ expansion

        setup(() => {
            const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aaw-')));
            ws = path.join(tmp, 'proj');
            outside = path.join(tmp, 'proj-secrets'); // shares the "proj" prefix on purpose
            home = path.join(tmp, 'home');
            fs.mkdirSync(ws);
            fs.mkdirSync(outside);
            fs.mkdirSync(home);
        });

        test('resolves a relative path inside the workspace', () => {
            const file = path.join(ws, '.vscode');
            fs.mkdirSync(file);
            fs.writeFileSync(path.join(file, 'custom-prompts.md'), '# hi');
            const r = resolveSafePromptPath('.vscode/custom-prompts.md', false, ws, home);
            assert.strictEqual(r, path.join(ws, '.vscode', 'custom-prompts.md'));
        });

        test('rejects a relative path that escapes the workspace via symlink', () => {
            fs.writeFileSync(path.join(outside, 'secret.md'), 'TOP SECRET');
            // workspace-internal symlink pointing OUT to the sibling secrets dir
            fs.symlinkSync(path.join(outside, 'secret.md'), path.join(ws, 'link.md'));
            const r = resolveSafePromptPath('link.md', false, ws, home);
            assert.strictEqual(r, null);
        });

        test('rejects a symlink into a sibling dir sharing the name prefix', () => {
            fs.writeFileSync(path.join(outside, 'p.md'), 'x');
            fs.symlinkSync(outside, path.join(ws, 'sib')); // ws/sib -> .../proj-secrets
            const r = resolveSafePromptPath('sib/p.md', false, ws, home);
            assert.strictEqual(r, null);
        });

        test('allows a trusted absolute path outside the workspace', () => {
            const abs = path.join(outside, 'global.md');
            fs.writeFileSync(abs, '# global');
            const r = resolveSafePromptPath(abs, true, ws, home);
            assert.strictEqual(r, abs);
        });

        test('expands ~ for a trusted path', () => {
            fs.writeFileSync(path.join(home, 'prompts.md'), '# home');
            const r = resolveSafePromptPath('~/prompts.md', true, ws, home);
            assert.strictEqual(r, path.join(home, 'prompts.md'));
        });

        test('rejects an absolute path that is NOT trusted (defensive)', () => {
            const abs = path.join(outside, 'global.md');
            fs.writeFileSync(abs, '# global');
            const r = resolveSafePromptPath(abs, false, ws, home);
            assert.strictEqual(r, null);
        });

        test('returns null for a non-existent relative path', () => {
            assert.strictEqual(resolveSafePromptPath('nope.md', false, ws, home), null);
        });

        test('returns null when the path is a directory', () => {
            fs.mkdirSync(path.join(ws, 'adir'));
            assert.strictEqual(resolveSafePromptPath('adir', false, ws, home), null);
        });

        test('returns null for a file larger than 10MB', () => {
            fs.writeFileSync(path.join(ws, 'big.md'), Buffer.alloc(10 * 1024 * 1024 + 1));
            assert.strictEqual(resolveSafePromptPath('big.md', false, ws, home), null);
        });

        test('returns null for a relative path when there is no workspace', () => {
            assert.strictEqual(resolveSafePromptPath('a.md', false, undefined, home), null);
        });
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `resolveSafePromptPath` is not defined.

- [ ] **Step 3: Implement `resolveSafePromptPath` and helpers**

Append to `src/utils/security.ts`:

```typescript
/** Maximum custom-prompts file size (10MB) to prevent memory exhaustion. */
const MAX_PROMPT_FILE_SIZE = 10 * 1024 * 1024;

/** Expand a leading ~ / ~/ to the given home directory. Other values pass through. */
function expandTilde(value: string, homeDir: string): string {
    if (value === '~') {
        return homeDir;
    }
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.join(homeDir, value.slice(2));
    }
    return value;
}

/** Return the path if it is an existing regular file within the size limit, else null. */
function validateExistingFile(absPath: string): string | null {
    try {
        if (!fs.existsSync(absPath)) {
            return null;
        }
        const stat = fs.statSync(absPath);
        if (!stat.isFile() || stat.size > MAX_PROMPT_FILE_SIZE) {
            return null;
        }
        return absPath;
    } catch {
        return null;
    }
}

/**
 * Resolve a selected custom-prompts value to a safe absolute path, or null.
 *
 * - Absolute / ~ values are only honored when `trusted` is true (global/default origin);
 *   they may point anywhere the user can read (the user chose it). ~ is expanded via homeDir.
 * - Relative values are resolved under workspaceRoot and then re-validated with
 *   fs.realpathSync so a symlink cannot escape the workspace (both sides are realpath'd
 *   to absorb e.g. /tmp -> /private/tmp). A relative value with no workspace is rejected.
 */
export function resolveSafePromptPath(
    value: string,
    trusted: boolean,
    workspaceRoot: string | undefined,
    homeDir: string
): string | null {
    const expanded = expandTilde(value, homeDir);

    if (path.isAbsolute(expanded)) {
        // Reachable with an absolute path only from a trusted origin; reject otherwise.
        if (!trusted) {
            return null;
        }
        return validateExistingFile(expanded);
    }

    // Relative path: must resolve to a real file inside the workspace.
    if (!workspaceRoot) {
        return null;
    }
    const candidate = path.resolve(workspaceRoot, expanded);
    if (!fs.existsSync(candidate)) {
        return null;
    }
    let realPath: string;
    let realRoot: string;
    try {
        realPath = fs.realpathSync(candidate);
        realRoot = fs.realpathSync(workspaceRoot);
    } catch {
        return null;
    }
    // Containment check on a path-separator boundary so a sibling dir sharing the
    // workspace name prefix (proj vs proj-secrets) is not treated as inside.
    if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
        return null;
    }
    return validateExistingFile(realPath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — the `resolveSafePromptPath` suite is green; earlier suites still pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/security.ts src/test/suite/security.test.ts
git commit -m "feat(security): realpath-based safe custom-prompts path resolution

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire resolution into `loadCustomPrompts` and remove the old check

**Files:**
- Modify: `src/core/prompts.ts` (add `resolveCustomPromptsPath`, simplify `loadCustomPrompts` at `src/core/prompts.ts:647`, delete `isPathInWorkspace` at `src/core/prompts.ts:368`)

> No unit test in this task: `loadCustomPrompts()` depends on live `vscode.workspace` configuration/folders, which are not configurable from the in-host test suite. The security-critical logic is already covered by Tasks 1–2; this task is verified by `npm test` (suite stays green) plus the manual checklist in Task 4.

- [ ] **Step 1: Add the `os` import and the new imports from security**

At the top of `src/core/prompts.ts`, add `import * as os from 'os';` after the existing `import * as path from 'path';`. Update the security import (or add one if none exists) to include the new functions:

```typescript
import { selectTrustedPromptValue, resolveSafePromptPath, isAbsoluteOrTilde } from '../utils/security';
```

- [ ] **Step 2: Add `resolveCustomPromptsPath` and rewrite `loadCustomPrompts`**

Replace the entire body of `loadCustomPrompts()` (the function starting at `src/core/prompts.ts:647`, through its closing brace and final `return null;` in the catch) with:

```typescript
/**
 * Resolve the effective, security-validated absolute path to the custom prompts file.
 * Returns null when no safe file applies (callers then use built-in defaults).
 *
 * Trust model:
 * - Absolute / ~ paths are honored ONLY from User (global) settings.
 * - A repository (workspace/folder) setting may only use a relative path inside the
 *   workspace; symlink escapes are blocked via realpath. See utils/security.ts.
 */
function resolveCustomPromptsPath(): string | null {
    const config = vscode.workspace.getConfiguration('autoAltWriter');
    const inspect = config.inspect<string>('customFilePath');
    if (!inspect) {
        return null;
    }

    // Visibility: a repo trying to point the prompts file outside the workspace is a
    // (benign-by-design) security event worth a log line, but never a modal.
    const repoValue = inspect.workspaceFolderValue ?? inspect.workspaceValue;
    if (repoValue !== undefined && isAbsoluteOrTilde(repoValue)) {
        console.warn(
            '[Auto ALT Writer] Ignored an absolute custom-prompts path from workspace settings; ' +
            'only User (global) settings may point outside the workspace.'
        );
    }

    const selected = selectTrustedPromptValue({
        defaultValue: inspect.defaultValue,
        globalValue: inspect.globalValue,
        workspaceValue: inspect.workspaceValue,
        workspaceFolderValue: inspect.workspaceFolderValue,
    });
    if (!selected) {
        return null;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return resolveSafePromptPath(selected.value, selected.trusted, workspaceRoot, os.homedir());
}

/**
 * Load and parse custom prompts from the resolved Markdown file.
 * Returns null if no safe file exists or it cannot be parsed (use defaults).
 *
 * Security: path trust/containment is enforced by resolveCustomPromptsPath()
 * (origin-based absolute-path policy + realpath symlink-escape protection).
 */
export function loadCustomPrompts(): CustomPrompts | null {
    try {
        const absolutePath = resolveCustomPromptsPath();
        if (!absolutePath) {
            return null;
        }

        // Reset cache if the resolved file changed.
        if (lastPromptsFilePath !== absolutePath) {
            customPromptsCache = null;
            lastPromptsFilePath = absolutePath;
        }
        if (customPromptsCache !== null) {
            return customPromptsCache;
        }

        const fileContent = fs.readFileSync(absolutePath, 'utf-8');
        const parsedPrompts = parseMarkdownPrompts(fileContent);
        if (!parsedPrompts) {
            console.error('[Auto ALT Writer] Invalid custom prompts structure');
            return null;
        }

        customPromptsCache = parsedPrompts;
        return parsedPrompts;
    } catch (error) {
        if (error instanceof Error && !error.message.includes('ENOENT')) {
            console.error('[Auto ALT Writer] Failed to load custom prompts:', error);
        }
        return null;
    }
}
```

- [ ] **Step 3: Delete the now-unused `isPathInWorkspace`**

Remove the entire function at `src/core/prompts.ts:365-375` (the JSDoc comment `/** Validate that a path is within the workspace ... */` and the `function isPathInWorkspace(...) { ... }` body). It has no remaining callers.

- [ ] **Step 4: Verify compile, lint, and the full suite**

Run: `npm test`
Expected: PASS — TypeScript compiles with no unused-symbol/`os`/import errors, ESLint passes, and all security suites are green.

If compilation complains that `fs` or `path` is now unused in `prompts.ts`, confirm they are still used elsewhere in the file (they are: `parseMarkdownPrompts` reads other files / `path` is used in other helpers). Only remove an import if the compiler flags it as unused.

- [ ] **Step 5: Commit**

```bash
git add src/core/prompts.ts
git commit -m "feat: resolve custom-prompts path via origin-trust + realpath guard

Allow an absolute/~ prompts path from User (global) settings only; repo
settings stay confined to the workspace, with symlink escapes blocked.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Document the trust model and run final manual verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the prompts-path trust model in CLAUDE.md**

In `CLAUDE.md`, under the `### Customizing Prompts` area (where `.vscode/custom-prompts.md` is described), add this subsection:

```markdown
#### Custom Prompts Path Resolution (security)

`autoAltWriter.customFilePath` is resolved by trust origin (`src/utils/security.ts`):

- **Relative path (any origin)**: resolved under the first workspace folder and
  re-validated with `fs.realpathSync` — the real file must stay inside the workspace,
  so a committed symlink cannot read files outside it.
- **Absolute / `~` path from User (global) settings**: trusted and used as-is
  (`~` expands to the home dir). This is how a single shared prompts file is reused
  across all projects.
- **Absolute / `~` path from repository (workspace/folder) settings**: rejected and
  logged via `console.warn`; resolution falls back to the global value, then the
  default. This prevents a malicious `.vscode/settings.json` from exfiltrating files
  (the prompt file's contents are sent to the Gemini API).
```

- [ ] **Step 2: Commit the docs**

```bash
git add CLAUDE.md
git commit -m "docs: document custom-prompts path trust model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Manual verification (VS Code, F5 Extension Development Host)**

Confirm each, end-to-end:

- [ ] Default behavior unchanged: a repo with `.vscode/custom-prompts.md` still loads it.
- [ ] Repo `settings.json` sets `customFilePath` to a relative file inside the workspace → loads it.
- [ ] Repo `settings.json` sets `customFilePath` to an absolute path (e.g. `/etc/hosts`) → ignored, `console.warn` shown, defaults used.
- [ ] User (global) `settings.json` sets `customFilePath` to an absolute path to a real prompts file outside any workspace → loads it across projects.
- [ ] User global setting uses `~/...` → expands and loads.
- [ ] A symlink inside the workspace pointing outside (`ln -s /etc/passwd .vscode/custom-prompts.md`) → not loaded.
- [ ] Repo relative value overrides a global absolute value (repo wins).

- [ ] **Step 4: Final green check**

Run: `npm test`
Expected: PASS — full suite green.

---

## Notes / Out of Scope (YAGNI)

- Multi-root: still uses `workspaceFolders[0]` (unchanged).
- No inline-prompt setting and no zero-config fixed global path (`globalStorageUri`/`~/.config`).
- No change to `package.json` settings schema or the default value `.vscode/custom-prompts.md`.
