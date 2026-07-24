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
 *
 * Note: the cache is invalidated on set/clear and via onDidChange. Across windows the
 * onDidChange is delivered asynchronously, so a request fired in the brief window after
 * another window rotated the key may use the previous value (then 401 and fall back).
 * Acceptable for a single-user dev tool; the key is never logged or placed in a URL.
 */
export async function getUserApiKey(): Promise<string | undefined> {
    if (loaded) {
        return cachedKey;
    }
    try {
        const stored = await secretStorage?.get(SECRET_KEY);
        cachedKey = stored && stored.length > 0 ? stored : undefined;
        loaded = true;
    } catch (error) {
        // Keychain read failed: fall back to the proxy and leave the cache unloaded so a
        // later call retries rather than sticking on a wrong value. Never log the key.
        console.error('[Auto ALT Text Writer] Failed to read the stored API key:', error instanceof Error ? error.message : String(error));
        cachedKey = undefined;
        loaded = false;
    }
    return cachedKey;
}

/** Store a user API key (trimmed). Updates the cache immediately. */
export async function setUserApiKey(key: string): Promise<void> {
    if (!secretStorage) {
        throw new Error('Secret storage is not initialized');
    }
    const trimmed = key.trim();
    try {
        await secretStorage.store(SECRET_KEY, trimmed);
    } catch (error) {
        console.error('[Auto ALT Text Writer] Failed to store the API key:', error instanceof Error ? error.message : String(error));
        throw new Error('Failed to store the API key in secure storage.');
    }
    cachedKey = trimmed.length > 0 ? trimmed : undefined;
    loaded = true;
}

/** Remove the stored key and revert to the shared proxy. */
export async function clearUserApiKey(): Promise<void> {
    if (!secretStorage) {
        throw new Error('Secret storage is not initialized');
    }
    try {
        await secretStorage.delete(SECRET_KEY);
    } catch (error) {
        console.error('[Auto ALT Text Writer] Failed to clear the API key:', error instanceof Error ? error.message : String(error));
        throw new Error('Failed to clear the API key from secure storage.');
    }
    cachedKey = undefined;
    loaded = true;
}
