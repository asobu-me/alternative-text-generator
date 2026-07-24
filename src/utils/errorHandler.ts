/**
 * Error handling utilities for Gemini API
 */

import * as vscode from 'vscode';
import { Response } from 'node-fetch';
import {
    GeminiError,
    RateLimitError,
    AuthenticationError,
    ContentBlockedError,
    InvalidRequestError,
    ServerError,
    NetworkError,
    ResponseFormatError
} from './errors';
import { JSON_FORMATTING } from '../constants';

/**
 * Parse HTTP error response and throw appropriate error
 */
export async function handleHttpError(response: Response): Promise<never> {
    const statusCode = response.status;
    let errorBody: string;

    try {
        errorBody = await response.text();
    } catch {
        errorBody = 'Unable to read error response';
    }

    // Parse error details from response body if available
    let errorDetails = errorBody;
    try {
        const errorJson = JSON.parse(errorBody);
        if (errorJson.error && errorJson.error.message) {
            errorDetails = errorJson.error.message;
        }
    } catch {
        // Not JSON, use raw text
    }

    // Handle different status codes.
    // Each message is one sentence: what happened, then what to do next. The
    // "next step" is a button (see notify.ts) whenever VS Code can perform it.
    switch (statusCode) {
        case 429:
            throw new RateLimitError(
                vscode.l10n.t('Gemini API rate limit reached (the shared tier allows 15 requests per minute). Wait about a minute, or set your own API key to use your own quota.')
            );

        case 401:
            throw new AuthenticationError(
                vscode.l10n.t('The Gemini API key was rejected. Set a valid key issued by Google AI Studio.'),
                401
            );

        case 403:
            throw new AuthenticationError(
                vscode.l10n.t('The Gemini API key lacks permission, or the Gemini API is not enabled for it. Check the key in Google AI Studio.'),
                403
            );

        case 400:
            throw new InvalidRequestError(
                vscode.l10n.t('Gemini API rejected the request: {0}', errorDetails),
                400
            );

        case 404:
            throw new InvalidRequestError(
                vscode.l10n.t('The Gemini model this extension uses is unavailable. Try again later, or report it if it persists.'),
                404
            );

        case 500:
        case 502:
        case 503:
        case 504:
            throw new ServerError(
                vscode.l10n.t('Gemini API server error ({0}). This is usually temporary — try again in a moment.', statusCode),
                statusCode
            );

        default:
            // Unknown error
            throw new GeminiError(
                vscode.l10n.t('Gemini API error ({0}): {1}', statusCode, errorDetails),
                statusCode,
                statusCode >= 500 // 5xx errors are generally retryable
            );
    }
}

/**
 * Handle content blocked error from promptFeedback
 */
export function handleContentBlocked(blockReason: string, contentType: 'image' | 'video'): never {
    // Blocking is expected behaviour, not a defect — say so plainly and point at
    // the only real remedy (writing the attribute by hand).
    const reason = describeBlockReason(blockReason);

    const errorMessage = contentType === 'image'
        ? vscode.l10n.t('Gemini blocked this image ({0}). Write the alt text manually.', reason)
        : vscode.l10n.t('Gemini blocked this video ({0}). Write the aria-label manually.', reason);

    throw new ContentBlockedError(errorMessage, blockReason);
}

/** Human-readable phrase for a Gemini promptFeedback block reason. */
function describeBlockReason(blockReason: string): string {
    switch (blockReason) {
        case 'SAFETY':             return vscode.l10n.t('safety filter');
        case 'BLOCKLIST':          return vscode.l10n.t('blocked term');
        case 'PROHIBITED_CONTENT': return vscode.l10n.t('prohibited content');
        case 'OTHER':              return vscode.l10n.t('reason unspecified');
        default:                   return blockReason;
    }
}

/**
 * Validate API response structure
 */
export function validateResponseStructure(data: unknown): void {
    // Type guard: check if data is an object
    if (typeof data !== 'object' || data === null) {
        console.error('Unexpected API response:', JSON.stringify(data, null, JSON_FORMATTING.INDENT_SPACES));
        throw new ResponseFormatError(
            vscode.l10n.t('Unexpected Gemini API response (not an object). See the developer console for details.')
        );
    }

    // Check candidates array
    if (!hasProperty(data, 'candidates') || !Array.isArray(data.candidates) || data.candidates.length === 0) {
        console.error('Unexpected API response:', JSON.stringify(data, null, JSON_FORMATTING.INDENT_SPACES));
        throw new ResponseFormatError(
            vscode.l10n.t('Unexpected Gemini API response (no candidates returned). See the developer console for details.')
        );
    }

    // Check content structure
    const candidate = data.candidates[0];
    if (typeof candidate !== 'object' || candidate === null ||
        !hasProperty(candidate, 'content') || typeof candidate.content !== 'object' || candidate.content === null ||
        !hasProperty(candidate.content, 'parts') || !Array.isArray(candidate.content.parts) || candidate.content.parts.length === 0) {
        console.error('Unexpected API response:', JSON.stringify(data, null, JSON_FORMATTING.INDENT_SPACES));
        throw new ResponseFormatError(
            vscode.l10n.t('Unexpected Gemini API response (missing content). See the developer console for details.')
        );
    }

    // Check if text is present
    const part = candidate.content.parts[0];
    if (typeof part !== 'object' || part === null || !hasProperty(part, 'text') || !part.text) {
        console.error('Unexpected API response:', JSON.stringify(data, null, JSON_FORMATTING.INDENT_SPACES));
        throw new ResponseFormatError(
            vscode.l10n.t('Gemini API returned no text. Try again, or write the attribute manually.')
        );
    }
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: unknown): boolean {
    if (error instanceof GeminiError) {
        return error.isRetryable;
    }

    // Network errors are typically retryable
    if (error instanceof NetworkError) {
        return true;
    }

    // Unknown errors are not retryable by default
    return false;
}

/**
 * Type guard for Error objects
 */
function isError(error: unknown): error is Error {
    return error instanceof Error;
}

/**
 * Type guard for objects with specific properties
 */
function hasProperty<T extends string>(error: unknown, prop: T): error is Record<T, unknown> {
    return typeof error === 'object' && error !== null && prop in error;
}

/**
 * Get user-friendly error message
 */
export function getUserFriendlyErrorMessage(error: unknown): string {
    // Handle GeminiError instances
    if (error instanceof GeminiError) {
        return error.message;
    }

    // Handle standard Error instances
    if (!isError(error)) {
        return vscode.l10n.t('Unexpected error. See the developer console for details.');
    }

    // Handle fetch/network errors
    if (
        error.name === 'FetchError' ||
        (hasProperty(error, 'code') && (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED'))
    ) {
        return vscode.l10n.t('Cannot reach the Gemini API. Check your internet connection and firewall settings.');
    }

    // Timeout errors
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
        return vscode.l10n.t('The Gemini API request timed out. Try a smaller file, or check your connection speed.');
    }

    // Generic error with message
    return error.message || vscode.l10n.t('Unexpected error. See the developer console for details.');
}
