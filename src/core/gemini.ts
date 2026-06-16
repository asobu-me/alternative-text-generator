/**
 * Gemini API integration
 */

import * as vscode from 'vscode';
import fetch, { Response } from 'node-fetch';
import { getDefaultPrompt } from './prompts';
import { getOutputLanguage } from '../utils/config';
import { CancellationError, NetworkError, InvalidRequestError } from '../utils/errors';
import { handleHttpError, handleContentBlocked, validateResponseStructure, isRetryableError } from '../utils/errorHandler';
import { API_CONFIG, JSON_FORMATTING, CHAR_CONSTRAINTS, PROXY_CONFIG, GEMINI_DIRECT } from '../constants';
import { getUserApiKey } from '../utils/apiKey';


/**
 * Gemini API response structure
 * Defines the expected JSON structure from Gemini API generateContent endpoint
 */
interface GeminiResponse {
    candidates: Array<{
        content: {
            parts: Array<{
                text: string;
            }>;
        };
    }>;
    promptFeedback?: {
        blockReason?: string;
    };
}

/**
 * Send a generateContent request to the proxy, which injects the API key and
 * forwards it to Gemini. The proxy passes Gemini's status code and response
 * body straight back, so the existing response/error handling works unchanged.
 *
 * The endpoint is a fixed bundled constant — the Gemini API key lives ONLY on
 * the proxy, never in the extension.
 */
async function fetchViaProxy(
    model: string,
    contents: unknown,
    token?: vscode.CancellationToken
): Promise<Response> {
    if (token?.isCancellationRequested) {
        throw new CancellationError();
    }

    try {
        return await fetch(PROXY_CONFIG.DEFAULT_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-client-token': PROXY_CONFIG.CLIENT_TOKEN
            },
            body: JSON.stringify({ model, contents })
        });
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new NetworkError(
            'Failed to connect to the ALT generation service.\n\n' +
            'Possible causes:\n' +
            '1. No internet connection\n' +
            '2. Network firewall blocking the request\n' +
            '3. The proxy service is unavailable or misconfigured\n\n' +
            `Error details: ${errorMessage}`
        );
    }
}

/**
 * Send a generateContent request DIRECTLY to Google using the user's own API key
 * (Bring Your Own Key). The key is sent in the `x-goog-api-key` header — never in
 * the URL — so it does not end up in logs or error messages. The model name is
 * allowlisted before being placed into the URL path to prevent path/SSRF
 * injection, and the host is a fixed constant.
 */
async function fetchDirect(
    model: string,
    contents: unknown,
    apiKey: string,
    token?: vscode.CancellationToken
): Promise<Response> {
    if (token?.isCancellationRequested) {
        throw new CancellationError();
    }

    const safeModel = model.trim();
    if (!GEMINI_DIRECT.MODEL_NAME_PATTERN.test(safeModel)) {
        throw new InvalidRequestError(
            `❌ Invalid model name\n\n` +
            `"${safeModel}" is not an allowed model name.\n` +
            `Check the model in your custom prompts file.`,
            400
        );
    }

    // Model name only goes into the URL path; the key only goes into the header.
    const url = `${GEMINI_DIRECT.MODELS_ENDPOINT}/${encodeURIComponent(safeModel)}:generateContent`;

    try {
        return await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify({ contents })
        });
    } catch (error: unknown) {
        // Never include the URL or key in the error — only the underlying message.
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new NetworkError(
            'Failed to connect to the Gemini API.\n\n' +
            'Possible causes:\n' +
            '1. No internet connection\n' +
            '2. Network firewall blocking the request\n\n' +
            `Error details: ${errorMessage}`
        );
    }
}

/**
 * Route a generateContent request: use the user's own key (direct to Google) when
 * one is set, otherwise fall back to the shared proxy.
 */
async function sendGenerateContent(
    model: string,
    contents: unknown,
    token?: vscode.CancellationToken
): Promise<Response> {
    const apiKey = await getUserApiKey();
    return apiKey
        ? fetchDirect(model, contents, apiKey, token)
        : fetchViaProxy(model, contents, token);
}

/**
 * Validate Gemini API response and extract data
 */
async function validateGeminiResponse(
    response: Response,
    contentType: 'image' | 'video',
    token?: vscode.CancellationToken
): Promise<GeminiResponse> {
    if (token?.isCancellationRequested) {
        throw new CancellationError();
    }

    if (!response.ok) {
        await handleHttpError(response);
    }

    const data: unknown = await response.json();

    // Check for content blocked
    if (typeof data === 'object' && data !== null && 'promptFeedback' in data) {
        const dataObj = data as { promptFeedback?: { blockReason?: string } };
        if (dataObj.promptFeedback?.blockReason) {
            console.error('API blocked the request:', JSON.stringify(data, null, JSON_FORMATTING.INDENT_SPACES));
            handleContentBlocked(dataObj.promptFeedback.blockReason, contentType);
        }
    }

    validateResponseStructure(data);
    return data as GeminiResponse;
}

/**
 * Generate ALT text for an image using Gemini API
 */
export async function generateAltText(
    base64Image: string,
    mimeType: string,
    mode: string,
    model: string,
    token?: vscode.CancellationToken,
    surroundingText?: string
): Promise<string> {
    // キャンセルチェック
    if (token?.isCancellationRequested) {
        throw new Error('Cancelled');
    }

    // 出力言語を取得
    const outputLang = getOutputLanguage();

    // 設定からプロンプトを取得
    let prompt: string;

    if (mode === 'A11Y') {
        // A11Yモード - 常に標準の文字数制約を使用
        const charLengthConstraint = outputLang === 'ja'
            ? CHAR_CONSTRAINTS.STANDARD_JA
            : CHAR_CONSTRAINTS.STANDARD_EN;

        prompt = getDefaultPrompt('a11y', outputLang as 'en' | 'ja', {
            charConstraint: charLengthConstraint,
            surroundingText
        });
    } else {
        // SEOモード
        prompt = getDefaultPrompt('seo', outputLang as 'en' | 'ja', {
            surroundingText
        });
    }

    // デバッグ: 送信するプロンプトをコンソールに表示
    console.log('[Auto ALT Writer] ========================================');
    console.log('[Auto ALT Writer] Prompt sent to Gemini API (Image):');
    console.log('[Auto ALT Writer] Mode:', mode);
    console.log('[Auto ALT Writer] Model:', model);
    console.log('[Auto ALT Writer] ========================================');
    console.log(prompt);
    console.log('[Auto ALT Writer] ========================================');

    const contents = [{
        parts: [
            {
                text: prompt
            },
            {
                inline_data: {
                    mime_type: mimeType,
                    data: base64Image
                }
            }
        ]
    }];

    const response = await sendGenerateContent(model, contents, token);
    const validatedData = await validateGeminiResponse(response, 'image', token);
    const altText = validatedData.candidates[0].content.parts[0].text.trim();

    return altText;
}

/**
 * Generate aria-label for video using Gemini API
 */
export async function generateVideoAriaLabel(
    base64Video: string,
    mimeType: string,
    model: string,
    token?: vscode.CancellationToken,
    surroundingText?: string,
    mode: 'summary' | 'transcript' = 'summary'
): Promise<string> {
    // キャンセルチェック
    if (token?.isCancellationRequested) {
        throw new Error('Cancelled');
    }

    // 出力言語を取得
    const outputLang = getOutputLanguage();

    // Transcript モード時のみ文字数制約を選択
    const charLengthConstraint = mode === 'transcript'
        ? (outputLang === 'ja' ? CHAR_CONSTRAINTS.DETAILED_JA : CHAR_CONSTRAINTS.DETAILED_EN)
        : undefined;

    // プロンプトを取得
    const prompt = getDefaultPrompt('video', outputLang as 'en' | 'ja', {
        surroundingText,
        mode,
        charConstraint: charLengthConstraint
    });

    // デバッグ: 送信するプロンプトをコンソールに表示
    console.log('[Auto ALT Writer] ========================================');
    console.log('[Auto ALT Writer] Prompt sent to Gemini API (Video):');
    console.log('[Auto ALT Writer] Mode:', mode);
    console.log('[Auto ALT Writer] Model:', model);
    console.log('[Auto ALT Writer] ========================================');
    console.log(prompt);
    console.log('[Auto ALT Writer] ========================================');

    const contents = [{
        parts: [
            {
                text: prompt
            },
            {
                inline_data: {
                    mime_type: mimeType,
                    data: base64Video
                }
            }
        ]
    }];

    const response = await sendGenerateContent(model, contents, token);
    const validatedData = await validateGeminiResponse(response, 'video', token);
    const ariaLabel = validatedData.candidates[0].content.parts[0].text.trim();

    return ariaLabel;
}

/**
 * Generate ALT text with automatic retry for retryable errors
 * Only retries network errors and server errors (5xx)
 * Does NOT retry rate limit errors (429) - user must wait
 */
export async function generateAltTextWithRetry(
    base64Image: string,
    mimeType: string,
    mode: string,
    model: string,
    token?: vscode.CancellationToken,
    surroundingText?: string,
    maxRetries: number = API_CONFIG.MAX_RETRIES
): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // キャンセルチェック
            if (token?.isCancellationRequested) {
                throw new CancellationError();
            }

            return await generateAltText(
                base64Image,
                mimeType,
                mode,
                model,
                token,
                surroundingText
            );
        } catch (error: unknown) {
            lastError = error instanceof Error ? error : new Error('Unknown error');

            // キャンセルエラーは即座に投げる
            if (error instanceof CancellationError || token?.isCancellationRequested) {
                throw error;
            }

            // リトライ不可能なエラーは即座に投げる
            if (!isRetryableError(error)) {
                throw error;
            }

            // 最後の試行でエラーが出た場合は投げる
            if (attempt === maxRetries - 1) {
                throw error;
            }

            // Short wait for network/server errors
            const waitTime = API_CONFIG.RETRY_WAIT_BASE_MS * (attempt + 1);
            console.log(`[Auto ALT Writer] Retrying after network/server error (attempt ${attempt + 1}/${maxRetries}, waiting ${waitTime}ms)`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    throw lastError || new Error('Unknown error during retry');
}

/**
 * Generate aria-label with automatic retry for retryable errors
 * Only retries network errors and server errors (5xx)
 * Does NOT retry rate limit errors (429) - user must wait
 */
export async function generateVideoAriaLabelWithRetry(
    base64Video: string,
    mimeType: string,
    model: string,
    token?: vscode.CancellationToken,
    surroundingText?: string,
    maxRetries: number = API_CONFIG.MAX_RETRIES,
    mode: 'summary' | 'transcript' = 'summary'
): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // キャンセルチェック
            if (token?.isCancellationRequested) {
                throw new CancellationError();
            }

            return await generateVideoAriaLabel(
                base64Video,
                mimeType,
                model,
                token,
                surroundingText,
                mode
            );
        } catch (error: unknown) {
            lastError = error instanceof Error ? error : new Error('Unknown error');

            // キャンセルエラーは即座に投げる
            if (error instanceof CancellationError || token?.isCancellationRequested) {
                throw error;
            }

            // リトライ不可能なエラーは即座に投げる
            if (!isRetryableError(error)) {
                throw error;
            }

            // 最後の試行でエラーが出た場合は投げる
            if (attempt === maxRetries - 1) {
                throw error;
            }

            // Short wait for network/server errors
            const waitTime = API_CONFIG.RETRY_WAIT_BASE_MS * (attempt + 1);
            console.log(`[Auto ALT Writer] Retrying after network/server error (attempt ${attempt + 1}/${maxRetries}, waiting ${waitTime}ms)`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    throw lastError || new Error('Unknown error during retry');
}
