/**
 * Custom error classes for better error handling
 */

/**
 * Base class for all Gemini API errors
 */
export class GeminiError extends Error {
    public readonly statusCode?: number;
    public readonly isRetryable: boolean;
    public readonly errorType: string;

    constructor(message: string, statusCode?: number, isRetryable = false, errorType = 'UNKNOWN') {
        super(message);
        this.name = 'GeminiError';
        this.statusCode = statusCode;
        this.isRetryable = isRetryable;
        this.errorType = errorType;
        Object.setPrototypeOf(this, GeminiError.prototype);
    }
}

/**
 * Rate limit error (429) - NOT retryable
 * User should wait before trying again
 */
export class RateLimitError extends GeminiError {
    constructor(message = 'Rate limit exceeded. Please wait and try again.') {
        super(message, 429, false, 'RATE_LIMIT');
        this.name = 'RateLimitError';
        Object.setPrototypeOf(this, RateLimitError.prototype);
    }
}

/**
 * Authentication error (401, 403) - Not retryable
 */
export class AuthenticationError extends GeminiError {
    constructor(message: string, statusCode: number) {
        super(message, statusCode, false, 'AUTHENTICATION');
        this.name = 'AuthenticationError';
        Object.setPrototypeOf(this, AuthenticationError.prototype);
    }
}

/**
 * Content blocked error - Not retryable
 */
export class ContentBlockedError extends GeminiError {
    public readonly blockReason: string;

    constructor(message: string, blockReason: string) {
        super(message, undefined, false, 'CONTENT_BLOCKED');
        this.name = 'ContentBlockedError';
        this.blockReason = blockReason;
        Object.setPrototypeOf(this, ContentBlockedError.prototype);
    }
}

/**
 * Invalid request error (400, 404) - Not retryable
 */
export class InvalidRequestError extends GeminiError {
    constructor(message: string, statusCode: number) {
        super(message, statusCode, false, 'INVALID_REQUEST');
        this.name = 'InvalidRequestError';
        Object.setPrototypeOf(this, InvalidRequestError.prototype);
    }
}

/**
 * Server error (500, 503, etc.) - Retryable
 */
export class ServerError extends GeminiError {
    constructor(message: string, statusCode: number) {
        super(message, statusCode, true, 'SERVER_ERROR');
        this.name = 'ServerError';
        Object.setPrototypeOf(this, ServerError.prototype);
    }
}

/**
 * Network error (connection failed, timeout, etc.) - Retryable
 */
export class NetworkError extends GeminiError {
    constructor(message: string) {
        super(message, undefined, true, 'NETWORK');
        this.name = 'NetworkError';
        Object.setPrototypeOf(this, NetworkError.prototype);
    }
}

/**
 * Response format error - Not retryable
 */
export class ResponseFormatError extends GeminiError {
    constructor(message: string) {
        super(message, undefined, false, 'RESPONSE_FORMAT');
        this.name = 'ResponseFormatError';
        Object.setPrototypeOf(this, ResponseFormatError.prototype);
    }
}

/**
 * Cancellation error - Not retryable
 */
export class CancellationError extends GeminiError {
    constructor(message = 'Operation was cancelled by user') {
        super(message, undefined, false, 'CANCELLED');
        this.name = 'CancellationError';
        Object.setPrototypeOf(this, CancellationError.prototype);
    }
}
