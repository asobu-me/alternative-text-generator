/**
 * Security and validation utilities
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as dns from 'dns';
import * as net from 'net';

/**
 * Safely edit a document with error handling
 * Ensures the document is still open before applying changes
 */
export async function safeEditDocument(
    editor: vscode.TextEditor,
    range: vscode.Range,
    newText: string
): Promise<boolean> {
    try {
        // ドキュメントが閉じられていないかチェック
        if (!editor || editor.document.isClosed) {
            vscode.window.showWarningMessage(vscode.l10n.t('The file was closed while generating. Reopen it and run the command again.'));
            return false;
        }

        // WorkspaceEditを使用して編集を適用（エディタがアクティブでなくても動作する）
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(editor.document.uri, range, newText);

        const success = await vscode.workspace.applyEdit(workspaceEdit);

        if (!success) {
            vscode.window.showWarningMessage(vscode.l10n.t('Could not write to the file — it may have been closed or changed in the meantime. Run the command again.'));
            return false;
        }

        return true;
    } catch (error) {
        // 編集中に例外が発生した場合
        console.error('[Auto ALT Text Writer] Error during document edit:', error);
        vscode.window.showWarningMessage(vscode.l10n.t('Could not write to the file. Run the command again; see the developer console for details.'));
        return false;
    }
}

/**
 * Escape HTML special characters to prevent XSS attacks
 */
export function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * True if `child` is `parent` itself or lives underneath it. The comparison is on a
 * path-separator boundary so a sibling directory that merely shares the name prefix
 * (e.g. /work/proj vs /work/proj-secrets) is NOT treated as contained. This is the
 * single canonical "is this path inside that directory" primitive — use it for every
 * workspace-containment check so the boundary rule lives in exactly one place.
 */
export function isPathInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Sanitize file path to prevent path traversal attacks
 * Returns null if the path is suspicious
 */
export function sanitizeFilePath(filePath: string, basePath: string): string | null {
    try {
        // パストラバーサルシーケンスを明示的に拒否
        if (filePath.includes('..') || filePath.includes('~')) {
            return null;
        }

        // ルートパス（/で始まる）の場合は先頭の/を削除
        let cleanPath = filePath;
        if (cleanPath.startsWith('/')) {
            cleanPath = cleanPath.substring(1);
        }

        // 絶対パスに解決
        const resolved = path.resolve(basePath, cleanPath);
        const normalized = path.normalize(resolved);
        const normalizedBase = path.normalize(basePath);

        // ワークスペース外へのアクセスを拒否（セパレータ境界で比較）
        if (!isPathInside(normalized, normalizedBase)) {
            return null;
        }

        // Symlink hardening: if the target already exists, re-validate via realpath so an
        // in-workspace symlink (e.g. public/img -> /etc) cannot read files outside the
        // workspace and leak their contents to the API. A not-yet-existing path is left to
        // the caller's existence check (it cannot leak content). Mirrors resolveSafePromptPath.
        if (fs.existsSync(normalized)) {
            let realPath: string;
            let realBase: string;
            try {
                realPath = fs.realpathSync(normalized);
                realBase = fs.realpathSync(normalizedBase);
            } catch {
                return null;
            }
            if (!isPathInside(realPath, realBase)) {
                return null;
            }
        }

        return normalized;
    } catch {
        return null;
    }
}

/**
 * Validation result for image src attribute
 */
interface ValidationResult {
    valid: boolean;
    reason?: string;
    /** For a validated remote URL: the public IP the host resolved to (for DNS pinning). */
    address?: string;
    /** IP family (4 or 6) of `address`, for the pinned-lookup callback. */
    family?: number;
}

/**
 * Validate image src attribute for dangerous protocols and patterns
 */
export function validateImageSrc(src: string): ValidationResult {
    // 危険なプロトコルを拒否
    const dangerousProtocols = [
        'javascript:', 'data:', 'vbscript:', 'file:',
        'about:', 'chrome:', 'jar:', 'wyciwyg:'
    ];

    const lowerSrc = src.toLowerCase();
    for (const protocol of dangerousProtocols) {
        if (lowerSrc.startsWith(protocol)) {
            return { valid: false, reason: `Dangerous protocol: ${protocol}` };
        }
    }

    // UNCパス（Windows）を拒否（//で始まる場合でもhttp://やhttps://は除外）
    if (src.startsWith('\\\\') || (src.startsWith('//') && !lowerSrc.startsWith('http://') && !lowerSrc.startsWith('https://'))) {
        return { valid: false, reason: 'UNC paths not supported' };
    }

    // 動的表現を拒否
    const dynamicPatterns = [
        /\$\{/,           // テンプレートリテラル
        /\$\(/,           // コマンド置換
        /<\?php/i,        // PHPタグ
        /<%/,             // ASP/JSPタグ
        /@@/,             // Angular式
        /\[\[/,           // Vue式
    ];

    for (const pattern of dynamicPatterns) {
        if (pattern.test(src)) {
            return { valid: false, reason: 'Dynamic expression detected' };
        }
    }

    // http://またはhttps://で始まる場合は絶対URLとして許可
    if (lowerSrc.startsWith('http://') || lowerSrc.startsWith('https://')) {
        // URLとして妥当かチェック（基本的な検証）
        try {
            new URL(src);
            return { valid: true };
        } catch {
            return { valid: false, reason: 'Invalid URL format' };
        }
    }

    // ローカルパスの場合は許可された文字のみ
    const allowedChars = /^[a-zA-Z0-9/_.\-~]+$/;
    if (!allowedChars.test(src)) {
        return { valid: false, reason: 'Invalid characters in path' };
    }

    return { valid: true };
}

/**
 * Convert an IPv4 dotted string to a 32-bit unsigned integer
 */
function ipv4ToInt(ip: string): number {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * Check whether an IPv4 address falls inside a private/reserved range
 */
function isBlockedIpv4(ip: string): boolean {
    const value = ipv4ToInt(ip);
    const inRange = (base: string, bits: number): boolean => {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        return (value & mask) === (ipv4ToInt(base) & mask);
    };
    return (
        inRange('0.0.0.0', 8) ||       // "this" network
        inRange('10.0.0.0', 8) ||      // private
        inRange('100.64.0.0', 10) ||   // CGNAT
        inRange('127.0.0.0', 8) ||     // loopback
        inRange('169.254.0.0', 16) ||  // link-local (incl. cloud metadata 169.254.169.254)
        inRange('172.16.0.0', 12) ||   // private
        inRange('192.0.0.0', 24) ||    // IETF protocol assignments
        inRange('192.168.0.0', 16) ||  // private
        inRange('198.18.0.0', 15) ||   // benchmarking
        inRange('224.0.0.0', 4) ||     // multicast
        inRange('240.0.0.0', 4)        // reserved
    );
}

/**
 * Parse an IPv6 literal into its 16 octets, or null if it cannot be parsed.
 * Handles `::` zero-compression and a trailing embedded dotted-IPv4 group
 * (e.g. ::ffff:127.0.0.1). Numeric parsing (not textual regex matching) so every
 * spelling of the same address — compressed, mapped, compatible, NAT64 — normalizes
 * to the same bytes and is classified consistently.
 */
function parseIpv6ToBytes(ip: string): number[] | null {
    let s = ip;
    const zone = s.indexOf('%'); // strip any zone id (fe80::1%eth0)
    if (zone >= 0) {
        s = s.slice(0, zone);
    }
    const halves = s.split('::');
    if (halves.length > 2) {
        return null; // more than one "::" is invalid
    }

    const expand = (part: string): number[] => {
        if (part === '') {
            return [];
        }
        const groups = part.split(':');
        const bytes: number[] = [];
        for (const group of groups) {
            if (group.includes('.')) {
                // Embedded dotted IPv4 (only valid as the final group)
                const octets = group.split('.').map(Number);
                if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
                    throw new Error('invalid embedded IPv4');
                }
                bytes.push(octets[0], octets[1], octets[2], octets[3]);
            } else {
                const value = parseInt(group, 16);
                if (Number.isNaN(value) || value < 0 || value > 0xffff || !/^[0-9a-fA-F]+$/.test(group)) {
                    throw new Error('invalid hextet');
                }
                bytes.push((value >> 8) & 0xff, value & 0xff);
            }
        }
        return bytes;
    };

    try {
        if (halves.length === 2) {
            const head = expand(halves[0]);
            const tail = expand(halves[1]);
            const missing = 16 - head.length - tail.length;
            if (missing < 0) {
                return null;
            }
            return [...head, ...new Array(missing).fill(0), ...tail];
        }
        const all = expand(halves[0]);
        return all.length === 16 ? all : null;
    } catch {
        return null;
    }
}

/**
 * If the 16 octets embed an IPv4 address (mapped ::ffff:0:0/96, NAT64 64:ff9b::/96,
 * or the deprecated IPv4-compatible ::/96 form), return that IPv4 in dotted notation.
 * These are the ways an internal IPv4 can be smuggled inside an IPv6 literal.
 */
function embeddedIpv4(bytes: number[]): string | null {
    const dotted = () => `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    // IPv4-mapped: ::ffff:a.b.c.d
    if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
        return dotted();
    }
    // NAT64 well-known prefix: 64:ff9b::/96
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((b) => b === 0)) {
        return dotted();
    }
    // IPv4-compatible (deprecated): ::a.b.c.d — first 12 octets zero
    if (bytes.slice(0, 12).every((b) => b === 0)) {
        return dotted();
    }
    return null;
}

/**
 * Check whether an IPv6 address is loopback/unspecified/link-local/unique-local, or
 * embeds a blocked IPv4 (mapped / NAT64 / IPv4-compatible). Parses to bytes and masks
 * numerically so non-canonical spellings cannot slip past a textual matcher.
 */
function isBlockedIpv6(ip: string): boolean {
    const bytes = parseIpv6ToBytes(ip);
    if (!bytes) {
        return true; // unparseable – block defensively
    }
    // ::1 loopback
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) {
        return true;
    }
    // :: unspecified
    if (bytes.every((b) => b === 0)) {
        return true;
    }
    // fc00::/7 unique local
    if ((bytes[0] & 0xfe) === 0xfc) {
        return true;
    }
    // fe80::/10 link-local (incl. cloud metadata reachable via link-local)
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
        return true;
    }
    // Embedded IPv4 (mapped / NAT64 / compatible) → classify the inner IPv4
    const inner = embeddedIpv4(bytes);
    if (inner) {
        return isBlockedIpv4(inner);
    }
    return false;
}

/**
 * Returns true if the given IP literal points at a private/internal/reserved address
 */
function isBlockedAddress(ip: string): boolean {
    const kind = net.isIP(ip);
    if (kind === 4) {
        return isBlockedIpv4(ip);
    }
    if (kind === 6) {
        return isBlockedIpv6(ip);
    }
    return true; // not a valid IP literal – block defensively
}

/**
 * Validate a remote image URL before fetching to prevent SSRF.
 * Resolves the hostname and rejects any URL that points at a private,
 * loopback, link-local (e.g. cloud metadata) or otherwise internal address.
 *
 * On success the result carries the resolved public `address`/`family` so the caller
 * can pin the connection to that exact IP (a custom agent `lookup`), closing the
 * DNS-rebinding window between this check and the fetch. The caller must also disable
 * automatic redirect-following and re-validate each hop (a 3xx Location is a fresh URL
 * this function never saw).
 */
export async function validateRemoteImageUrl(rawUrl: string): Promise<ValidationResult> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { valid: false, reason: 'Invalid URL format' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { valid: false, reason: 'Only http/https URLs are allowed' };
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    const lowerHost = hostname.toLowerCase();

    // Block well-known internal hostnames outright
    if (
        lowerHost === 'localhost' ||
        lowerHost.endsWith('.localhost') ||
        lowerHost.endsWith('.local') ||
        lowerHost === 'metadata.google.internal'
    ) {
        return { valid: false, reason: 'Access to local/internal hosts is not allowed' };
    }

    // IP literal: validate directly without DNS
    const literalFamily = net.isIP(hostname);
    if (literalFamily) {
        return isBlockedAddress(hostname)
            ? { valid: false, reason: 'Access to private/internal addresses is not allowed' }
            : { valid: true, address: hostname, family: literalFamily };
    }

    // Hostname: resolve and ensure every resolved address is public
    try {
        const addresses = await dns.promises.lookup(hostname, { all: true });
        if (addresses.length === 0) {
            return { valid: false, reason: 'Host could not be resolved' };
        }
        for (const addr of addresses) {
            if (isBlockedAddress(addr.address)) {
                return { valid: false, reason: 'Host resolves to a private/internal address' };
            }
        }
        // Pin to the first validated address so the subsequent fetch cannot be rebound.
        return { valid: true, address: addresses[0].address, family: addresses[0].family };
    } catch {
        return { valid: false, reason: 'Host could not be resolved' };
    }
}

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

/** Single source of truth for the recognized tilde-home prefixes (POSIX + Windows). */
function hasTildePrefix(value: string): boolean {
    return value === '~' || value.startsWith('~/') || value.startsWith('~\\');
}

/** True if the value is an absolute path or a tilde (home) path. */
export function isAbsoluteOrTilde(value: string): boolean {
    return path.isAbsolute(value) || hasTildePrefix(value);
}

/**
 * Choose the effective custom-prompts setting value, honoring VS Code precedence
 * (folder > workspace > global > default) but with a security override:
 * a repository-supplied (workspace/folder) ABSOLUTE or ~ path is rejected, falling
 * back to the global value, then the default. Only global/default origins are trusted
 * to point outside the workspace. Pure function: no fs / vscode access.
 */
export function selectTrustedPromptValue(inspect: PromptPathInspect): SelectedPromptValue | null {
    // Honor folder > workspace precedence among the untrusted origins, but evaluate them
    // independently: an absolute/~ value at the higher-precedence scope is dropped for
    // security WITHOUT shadowing a legitimate relative value at the lower scope.
    for (const untrusted of [inspect.workspaceFolderValue, inspect.workspaceValue]) {
        if (untrusted !== undefined && !isAbsoluteOrTilde(untrusted)) {
            return { value: untrusted, trusted: false };
        }
        // (untrusted absolute/~ is silently dropped — fall through to the next origin)
    }

    if (inspect.globalValue !== undefined) {
        return { value: inspect.globalValue, trusted: true };
    }
    if (inspect.defaultValue !== undefined) {
        return { value: inspect.defaultValue, trusted: true };
    }
    return null;
}

/**
 * Maximum custom-prompts file size. 256KB is far above any real prompts file
 * (the documented example is under 2KB) and far below the point where parsing
 * a hostile file costs noticeable time. The previous 10MB cap was sized for
 * "prevent memory exhaustion" alone and left a wide CPU-burning margin.
 */
export const MAX_PROMPT_FILE_SIZE = 256 * 1024;

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
        // statSync throws ENOENT for a missing path (caught below), so a separate
        // existsSync would be a redundant second stat syscall.
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

    // path.isAbsolute is intentionally platform-aware: on Windows it also recognizes
    // drive (C:\) and UNC (\\server\share) paths, so those untrusted-origin forms are
    // caught here too. Do not replace this with a hand-rolled "/" check.
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
    let realPath: string;
    let realRoot: string;
    try {
        // realpathSync throws ENOENT for a missing candidate (caught here), so a separate
        // existsSync pre-check would be a redundant stat syscall.
        realPath = fs.realpathSync(candidate);
        realRoot = fs.realpathSync(workspaceRoot);
    } catch {
        return null;
    }
    // Containment check on a path-separator boundary so a sibling dir sharing the
    // workspace name prefix (proj vs proj-secrets) is not treated as inside.
    if (!isPathInside(realPath, realRoot)) {
        return null;
    }
    // TOCTOU note: a symlink could in theory be swapped between this realpath check and
    // the caller's readFileSync. Acceptable for a local single-user dev tool reading its
    // own workspace; the content is only sent to the API, never executed.
    return validateExistingFile(realPath);
}
