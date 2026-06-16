/**
 * Application constants
 * Centralized location for all magic numbers and configuration values
 */

/**
 * API and Network Configuration
 */
export const API_CONFIG = {
    /** Default Gemini API model */
    DEFAULT_MODEL: 'gemini-2.5-flash',
    /** Maximum number of retry attempts for retryable errors */
    MAX_RETRIES: 2,
    /** Base wait time in milliseconds for retry (multiplied by attempt number) */
    RETRY_WAIT_BASE_MS: 1000,
    /** Maximum video file size in MB */
    MAX_VIDEO_SIZE_MB: 20,
    /** Maximum image file size in MB */
    MAX_IMAGE_SIZE_MB: 20,
} as const;

/**
 * Text Processing Configuration
 */
export const TEXT_PROCESSING = {
    /** Maximum search range in characters for parent/sibling element detection */
    MAX_SEARCH_RANGE: 5000,
    /** Maximum number of parent element levels to traverse */
    MAX_PARENT_LEVELS: 3,
    /** Maximum number of sibling elements to collect (before + after) */
    MAX_SIBLINGS: 3,
    /** Minimum text length in characters to consider context sufficient */
    MIN_CONTEXT_LENGTH: 50,
    /** Maximum text length to prevent ReDoS attacks (500KB) */
    MAX_TEXT_LENGTH: 500000,
    /** Maximum HTML tag length to prevent ReDoS attacks */
    MAX_TAG_LENGTH: 500,
} as const;

/**
 * Tag Detection Configuration
 */
export const TAG_DETECTION = {
    /** Timeout in milliseconds for tag search operations */
    SEARCH_TIMEOUT_MS: 5000,
    /** Maximum attribute length for regex matching */
    MAX_ATTRIBUTE_LENGTH: 1000,
} as const;

/**
 * Selection Thresholds
 * Used to determine empty selections and minimum tag text length
 */
export const SELECTION_THRESHOLDS = {
    /** Minimum selection length to be considered non-empty */
    MIN_SELECTION_LENGTH: 5,
    /** Minimum tag text length for detection */
    MIN_TAG_TEXT_LENGTH: 10,
} as const;

/**
 * Character Constraints for ALT Text Generation
 * Used in prompts to constrain the length of generated descriptions
 */
export const CHAR_CONSTRAINTS = {
    /** Standard length for English ALT text */
    STANDARD_EN: '60-130 characters',
    /** Detailed length for English ALT text */
    DETAILED_EN: '100-200 characters',
    /** Standard length for Japanese ALT text */
    STANDARD_JA: '50-120 Japanese characters (full-width characters)',
    /** Detailed length for Japanese ALT text */
    DETAILED_JA: '100-200 Japanese characters (full-width characters)',
    /** Default fallback constraint */
    DEFAULT: '50-120 characters',
} as const;

/**
 * Prompt Configuration
 * Numbers used in prompt instructions
 */
export const PROMPT_CONSTRAINTS = {
    /** Minimum number of SEO keywords */
    SEO_KEYWORDS_MIN: 3,
    /** Maximum number of SEO keywords */
    SEO_KEYWORDS_MAX: 5,
    /** Maximum characters for supplementary description when context partially describes */
    MAX_SUPPLEMENTARY_CHARS: 50,
    /** Maximum words for supplementary video description */
    MAX_SUPPLEMENTARY_WORDS_VIDEO: 5,
    /** Maximum words for video aria-label (summary mode) */
    MAX_VIDEO_ARIA_LABEL_WORDS: 10,
} as const;

/**
 * JSON Formatting
 */
export const JSON_FORMATTING = {
    /** Indentation spaces for JSON.stringify */
    INDENT_SPACES: 2,
} as const;

/**
 * Context Range Values
 * Mapping from configuration string to actual character count
 */
export const CONTEXT_RANGE_VALUES = {
    'narrow': 500,
    'standard': 1500,
    'wide': 3000,
    /** Default fallback value */
    'default': 1500,
} as const;

/**
 * Special Keywords
 */
export const SPECIAL_KEYWORDS = {
    /** Keyword returned by API to indicate decorative/redundant content */
    DECORATIVE: 'DECORATIVE',
} as const;

/**
 * Batch Processing Configuration
 */
export const BATCH_PROCESSING = {
    /** Number of items to process in each chunk for memory efficiency */
    CHUNK_SIZE: 10,
} as const;

/**
 * Proxy Configuration
 *
 * The Gemini API key is NEVER shipped with the extension. All requests go
 * through a thin server-side proxy (see the /proxy directory) that injects the
 * key and forwards the call to Gemini. This is the only way to keep the key out
 * of the distributed extension.
 */
export const PROXY_CONFIG = {
    /** Deployed proxy endpoint. The Gemini API key lives only on the proxy. */
    DEFAULT_ENDPOINT: 'https://alt-gen-proxy.asobu.workers.dev',
    /**
     * Shared client token sent as the `x-client-token` header. It is embedded in
     * the extension and is therefore NOT a real secret — it only filters trivial
     * drive-by traffic. Real abuse protection lives on the proxy (rate limiting +
     * request validation) and on Google (per-key free-tier quotas). Must match the
     * proxy's CLIENT_TOKEN value.
     */
    CLIENT_TOKEN: 'altgen-public-client-v1',
} as const;

/**
 * Direct Google Gemini API configuration, used only when the user has supplied
 * their own API key (Bring Your Own Key). The host is a FIXED constant and must
 * never be derived from user input, settings, or the custom-prompts file.
 */
export const GEMINI_DIRECT = {
    /** Fixed base for the generateContent endpoint. Model name is appended as a path segment. */
    MODELS_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models',
    /** Allowlist for model names placed into the URL path (prevents path/SSRF injection). */
    MODEL_NAME_PATTERN: /^[a-zA-Z0-9.-]+$/,
} as const;
