/**
 * Configuration helper utilities
 */

import * as vscode from 'vscode';

/**
 * Valid insertion modes
 */
export type InsertionMode = 'auto' | 'confirm';

// Memoization cache for output language
let cachedOutputLanguage: string | null = null;
let cachedOutputLanguageSetting: string | null = null;

/**
 * Get output language for ALT text generation
 * Returns 'ja' for Japanese or 'en' for English
 * Memoized to avoid redundant config reads
 */
export function getOutputLanguage(): string {
    const config = vscode.workspace.getConfiguration('autoAltWriter');
    const langSetting = config.get<string>('outputLanguage', 'auto');

    // Return cached result if setting hasn't changed
    if (cachedOutputLanguage !== null && cachedOutputLanguageSetting === langSetting) {
        return cachedOutputLanguage;
    }

    // Compute output language
    let result: string;
    if (langSetting === 'auto') {
        const vscodeLang = vscode.env.language;
        result = vscodeLang.startsWith('ja') ? 'ja' : 'en';
    } else {
        result = langSetting;
    }

    // Update cache
    cachedOutputLanguage = result;
    cachedOutputLanguageSetting = langSetting;

    return result;
}

/**
 * Clear output language cache (call when config changes)
 */
export function clearOutputLanguageCache(): void {
    cachedOutputLanguage = null;
    cachedOutputLanguageSetting = null;
}

/**
 * Get insertion mode with type safety and validation
 * Returns 'auto' or 'confirm', defaults to 'auto' for invalid values
 */
export function getInsertionMode(): InsertionMode {
    const config = vscode.workspace.getConfiguration('autoAltWriter');
    const mode = config.get<string>('insertionMode', 'auto');

    if (mode !== 'auto' && mode !== 'confirm') {
        console.warn(`[Auto ALT Writer] Invalid insertionMode: ${mode}, using 'auto'`);
        return 'auto';
    }

    return mode;
}
