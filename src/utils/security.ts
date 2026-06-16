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
            vscode.window.showWarningMessage('Editor was closed during ALT generation. Please try again.');
            return false;
        }

        // WorkspaceEditを使用して編集を適用（エディタがアクティブでなくても動作する）
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(editor.document.uri, range, newText);

        const success = await vscode.workspace.applyEdit(workspaceEdit);

        if (!success) {
            vscode.window.showWarningMessage('Failed to edit document. The file may have been closed or modified.');
            return false;
        }

        return true;
    } catch (error) {
        // 編集中に例外が発生した場合
        console.error('[Auto ALT Writer] Error during document edit:', error);
        vscode.window.showWarningMessage('An error occurred while editing the document. Please try again.');
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

        // ワークスペース外へのアクセスを拒否
        // セパレータ境界で比較し、接頭辞が一致するだけの兄弟ディレクトリ
        // (例: /work/proj に対する /work/proj-secrets) への漏れを防ぐ
        if (normalized !== normalizedBase && !normalized.startsWith(normalizedBase + path.sep)) {
            return null;
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
 * Check whether an IPv6 address is loopback/link-local/unique-local or maps to a blocked IPv4
 */
function isBlockedIpv6(ip: string): boolean {
    const lower = ip.toLowerCase();
    // IPv4-mapped addresses (::ffff:0:0/96). Node may normalize these to either
    // dotted form (::ffff:127.0.0.1) or compressed hex form (::ffff:7f00:1).
    const mapped = lower.match(/^::ffff:(.+)$/);
    if (mapped) {
        const rest = mapped[1];
        if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) {
            return isBlockedIpv4(rest);
        }
        const hex = rest.split(':');
        if (hex.length === 2) {
            const high = parseInt(hex[0], 16);
            const low = parseInt(hex[1], 16);
            if (!Number.isNaN(high) && !Number.isNaN(low)) {
                const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
                return isBlockedIpv4(v4);
            }
        }
        return true; // unrecognized mapped form – block defensively
    }
    if (lower === '::1' || lower === '::') {
        return true; // loopback / unspecified
    }
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) {
        return true; // fc00::/7 unique local
    }
    if (/^fe[89ab][0-9a-f]:/.test(lower)) {
        return true; // fe80::/10 link-local
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
 * Note: a determined attacker could still attempt DNS rebinding between this
 * lookup and the actual fetch; this check mitigates the common case for a
 * developer-facing tool but is not a substitute for an IP-pinned HTTP agent.
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
    if (net.isIP(hostname)) {
        return isBlockedAddress(hostname)
            ? { valid: false, reason: 'Access to private/internal addresses is not allowed' }
            : { valid: true };
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
    } catch {
        return { valid: false, reason: 'Host could not be resolved' };
    }

    return { valid: true };
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
    // TOCTOU note: a symlink could in theory be swapped between this realpath check and
    // the caller's readFileSync. Acceptable for a local single-user dev tool reading its
    // own workspace; the content is only sent to the API, never executed.
    return validateExistingFile(realPath);
}
