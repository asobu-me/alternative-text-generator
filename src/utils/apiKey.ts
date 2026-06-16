/**
 * User-supplied Gemini API key storage (Bring Your Own Key).
 *
 * Security model:
 * - The key is stored ONLY in VS Code SecretStorage (OS keychain / DPAPI /
 *   libsecret), never in settings.json, globalState, or the workspace.
 * - When a user key is present, requests go DIRECTLY to Google with the key in
 *   the `x-goog-api-key` header (never the URL). The key is never sent through
 *   the bundled proxy, so it is exposed only to Google.
 * - When no user key is present, the extension falls back to the shared proxy.
 *
 * The key is cached in memory to avoid a keychain round-trip on every request
 * during batch operations. The cache is invalidated on set/clear and whenever
 * SecretStorage changes (e.g. from another window) via onDidChange.
 */

import * as vscode from 'vscode';

/** SecretStorage key. Kept stable for backward compatibility. */
const SECRET_KEY = 'geminiApiKey';

let secretStorage: vscode.SecretStorage | undefined;

/** In-memory cache. `loaded` distinguishes "not yet read" from "read as empty". */
let loaded = false;
let cachedKey: string | undefined;

/**
 * Wire up the secret store. Call once from activate(). Registers a listener that
 * invalidates the in-memory cache when the secret changes out-of-band.
 */
export function initApiKeyStore(context: vscode.ExtensionContext): void {
    secretStorage = context.secrets;
    context.subscriptions.push(
        context.secrets.onDidChange((e) => {
            if (e.key === SECRET_KEY) {
                loaded = false;
                cachedKey = undefined;
            }
        })
    );
}

/**
 * Return the user's API key, or undefined if none is set (→ use the proxy).
 * Reads SecretStorage once, then serves from the in-memory cache.
 */
export async function getUserApiKey(): Promise<string | undefined> {
    if (loaded) {
        return cachedKey;
    }
    const stored = await secretStorage?.get(SECRET_KEY);
    cachedKey = stored && stored.length > 0 ? stored : undefined;
    loaded = true;
    return cachedKey;
}

/** Store a user API key (trimmed). Updates the cache immediately. */
export async function setUserApiKey(key: string): Promise<void> {
    if (!secretStorage) {
        throw new Error('Secret storage is not initialized');
    }
    const trimmed = key.trim();
    await secretStorage.store(SECRET_KEY, trimmed);
    cachedKey = trimmed.length > 0 ? trimmed : undefined;
    loaded = true;
}

/** Remove the stored key and revert to the shared proxy. */
export async function clearUserApiKey(): Promise<void> {
    if (!secretStorage) {
        throw new Error('Secret storage is not initialized');
    }
    await secretStorage.delete(SECRET_KEY);
    cachedKey = undefined;
    loaded = true;
}
