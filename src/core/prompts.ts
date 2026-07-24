/**
 * Default prompts for ALT text and aria-label generation
 */

import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { CHAR_CONSTRAINTS, PROMPT_CONSTRAINTS } from '../constants';
import { selectTrustedPromptValue, resolveSafePromptPath, isAbsoluteOrTilde } from '../utils/security';
import { showWarning, editCustomFilePathAction, openPromptsFileAction } from '../utils/notify';

// Custom prompts interface
export interface CustomPrompts {
    imageAlt?: {
        seo?: string;
        a11y?: string;
    };
    videoDescription?: {
        summary?: string;
        transcript?: string;
    };
}

// Cache for custom prompts
let customPromptsCache: CustomPrompts | null = null;
let lastPromptsFilePath: string | null = null;
let lastSelectedPromptKey: string | null = null;
let warnedRepoAbsolutePromptPath = false;

// Type alias for the return of selectTrustedPromptValue
type SelectedPromptValue = NonNullable<ReturnType<typeof selectTrustedPromptValue>>;

// Default context instruction template (unified for all media types)
const DEFAULT_CONTEXT_PROMPT = `

Surrounding text is below:
{surroundingText}

If surrounding text fully describes the {mediaType}, return the special keyword: DECORATIVE
`;

/**
 * Get context instruction for avoiding redundancy with surrounding text
 * @param surroundingText - Text surrounding the image/video
 * @param type - Type of media: 'seo', 'a11y', or 'video'
 * @returns Context instruction string or empty string if no meaningful context
 */
function getContextInstruction(
    surroundingText: string,
    type: 'seo' | 'a11y' | 'video'
): string {
    // Determine media type for placeholder replacement
    const mediaType = type === 'video' ? 'video' : 'image';
    const mediaTypeUpper = mediaType.toUpperCase();

    // Replace BEFORE_MEDIA/AFTER_MEDIA with BEFORE_IMAGE/AFTER_IMAGE or BEFORE_VIDEO/AFTER_VIDEO
    // If no surrounding text found, use the placeholder text as-is
    const formattedSurroundingText = surroundingText
        .replace(/BEFORE_MEDIA/g, `BEFORE_${mediaTypeUpper}`)
        .replace(/AFTER_MEDIA/g, `AFTER_${mediaTypeUpper}`);

    return DEFAULT_CONTEXT_PROMPT
        .replace(/{surroundingText}/g, formattedSurroundingText)
        .replace(/{mediaType}/g, mediaType);
}

/**
 * Get language constraint instruction
 */
function getLanguageConstraint(lang: 'en' | 'ja'): string {
    return lang === 'ja' ? '\nRespond only in Japanese.' : '';
}

/**
 * Build SEO prompt with language-specific constraints
 */
function buildSeoPrompt(lang: 'en' | 'ja'): string {
    const languageConstraint = getLanguageConstraint(lang);

    return `You are an SEO expert. Generate alt text. Output only the alt text.${languageConstraint}`;
}

/**
 * Build A11Y prompt with language-specific constraints
 */
function buildA11yPrompt(lang: 'en' | 'ja', charConstraint: string): string {
    const languageConstraint = getLanguageConstraint(lang);

    return `You are an Accessibility expert. Generate alt text for visual impairments. Length: ${charConstraint}. Output only the alt text.${languageConstraint}`;
}

/**
 * Build Video prompt with language-specific constraints
 * @param lang - Output language
 * @param mode - 'summary' for short aria-label, 'transcript' for comprehensive description
 */
function buildVideoPrompt(lang: 'en' | 'ja', mode: 'summary' | 'transcript' = 'summary'): string {
    const languageConstraint = getLanguageConstraint(lang);

    if (mode === 'summary') {
        // Summary mode - short aria-label with word limit
        return `You are an Accessibility expert. Generate a concise video aria-label. Maximum ${PROMPT_CONSTRAINTS.MAX_VIDEO_ARIA_LABEL_WORDS} words. Do not include "video". Output only the aria-label.${languageConstraint}`;
    } else {
        // Transcript mode - comprehensive description with character limit
        return `You are a video content analyst. Generate a detailed narrative description of the video's content. Integrate all spoken dialogue and narration with essential visual information into a single, flowing text. Output only the resulting narrative text.${languageConstraint}`;
    }
}

/**
 * Whether the extension should extract the text surrounding each tag.
 *
 * Controlled by one setting. There is no per-prompt placeholder opt-in: the
 * surrounding-text rules are appended by the extension, never written into a
 * custom prompt, so the only question is whether the user turned the analysis on.
 *
 * @returns true when `contextAnalysisEnabled` is set
 */
export function needsSurroundingText(): boolean {
    const config = vscode.workspace.getConfiguration('autoAltWriter');
    return config.get<boolean>('contextAnalysisEnabled', false);
}

/**
 * Helper function to get the appropriate prompt based on type, language, and options
 *
 * @param type - Type of prompt: 'seo', 'a11y', or 'video'
 * @param lang - Output language: 'en' or 'ja'
 * @param options - Additional options for prompt generation
 * @param options.mode - For Video: 'summary' or 'transcript' (not used for seo/a11y)
 * @param options.charConstraint - Character constraint string for A11Y prompts
 * @param options.surroundingText - Surrounding text context for prompts
 * @param options.customPrompts - Pre-loaded custom prompts (optional, will load if not provided)
 * @returns The generated prompt string
 */
export function getDefaultPrompt(
    type: 'seo' | 'a11y' | 'video',
    lang: 'en' | 'ja',
    options?: {
        mode?: 'summary' | 'transcript';
        charConstraint?: string;
        surroundingText?: string;
        customPrompts?: CustomPrompts | null;
    }
): string {
    // Use pre-loaded custom prompts if provided, otherwise load
    const customPrompts = options?.customPrompts !== undefined ? options.customPrompts : loadCustomPrompts();

    // Get character constraint (used by all prompt types)
    const charConstraint = options?.charConstraint || CHAR_CONSTRAINTS.DEFAULT;

    // Language constraint to append to custom prompts
    // Only add if the custom prompt doesn't already contain language instructions
    const getLanguageConstraint = (customPrompt?: string): string => {
        if (lang !== 'ja') {
            return '';
        }
        // Check if custom prompt already has Japanese language instruction
        if (customPrompt && (
            customPrompt.includes('Respond only in Japanese') ||
            customPrompt.includes('日本語で') ||
            customPrompt.includes('Japanese only')
        )) {
            return '';
        }
        return ' Respond only in Japanese.';
    };

    /**
     * Turn a section the user wrote into the prompt actually sent.
     *
     * The body IS the whole instruction. The extension owns the two things that also
     * exist as settings — the output language and the surrounding-text rules — and
     * appends them itself, so a custom prompt can never silently lose them. Writing
     * nothing extra is correct; there is no placeholder syntax to learn.
     */
    const buildFromCustomSection = (
        body: string,
        promptType: 'seo' | 'a11y' | 'video'
    ): string => {
        const instruction = body.trim();

        const contextInstruction = (needsSurroundingText() && options?.surroundingText)
            ? getContextInstruction(options.surroundingText, promptType)
            : '';

        // The instruction is passed on so an author who already wrote "日本語で" in
        // their own words does not get a second, redundant language sentence.
        return instruction + contextInstruction + getLanguageConstraint(instruction);
    };

    const contextFor = (promptType: 'seo' | 'a11y' | 'video'): string =>
        (needsSurroundingText() && options?.surroundingText)
            ? getContextInstruction(options.surroundingText, promptType)
            : '';

    if (type === 'seo') {
        const customPrompt = customPrompts?.imageAlt?.seo;
        if (customPrompt) {
            return buildFromCustomSection(customPrompt, 'seo');
        }
        return buildSeoPrompt(lang) + contextFor('seo');
    }

    if (type === 'video') {
        const videoMode = options?.mode === 'transcript' ? 'transcript' : 'summary';

        const customPrompt = customPrompts?.videoDescription?.[videoMode];
        if (customPrompt) {
            return buildFromCustomSection(customPrompt, 'video');
        }
        return buildVideoPrompt(lang, videoMode) + contextFor('video');
    }

    if (type === 'a11y') {
        const customPrompt = customPrompts?.imageAlt?.a11y;
        if (customPrompt) {
            return buildFromCustomSection(customPrompt, 'a11y');
        }
        return buildA11yPrompt(lang, charConstraint) + contextFor('a11y');
    }

    throw new Error(`Unknown prompt type: ${type}`);
}

/**
 * Normalize section title for flexible matching
 * Removes leading #, spaces, hyphens, underscores, and converts to lowercase
 */
function normalizeSectionTitle(title: string): string {
    return title.toLowerCase()
        .replace(/^#+\s*/, '') // Remove leading # symbols
        .replace(/[\s\-_]+/g, '') // Remove spaces, hyphens, underscores
        .trim();
}

/**
 * The four documented headings, keyed by their normalized form (lowercase, with
 * spaces/hyphens/underscores removed). The value is the dot path into CustomPrompts.
 */
const SECTION_MAP: Record<string, string> = {
    seo: 'imageAlt.seo',
    a11y: 'imageAlt.a11y',
    video: 'videoDescription.summary',
    transcript: 'videoDescription.transcript'
};

/**
 * Resolve a section title to its CustomPrompts dot path, or null if unrecognized.
 * @param title - Section title from markdown
 */
function findSectionMapping(title: string): string | null {
    return SECTION_MAP[normalizeSectionTitle(title)] ?? null;
}

// ---------------------------------------------------------------------------
// Markdown scanning
//
// The custom-prompts file is untrusted input: a repository can ship
// `.vscode/custom-prompts.md` and it is read with no further opt-in (that path
// is the setting's default value). Everything below therefore scans with
// indexOf/char tests instead of regex.
//
// The regexes these replaced were all quadratic on adversarial input, because
// `[\s\S]*?` and `[\s]*` can each restart from every position in the file.
// Measured before the rewrite: 1MB of `<!--` with no `-->` took 8.5s in the
// MODE scan and 54s in the comment strip, and 256KB of newlines took 43s in the
// horizontal-rule pass — i.e. opening a hostile repo froze the extension host.
// Keep these functions regex-free.
// ---------------------------------------------------------------------------

const HTML_COMMENT_OPEN = '<!--';
const HTML_COMMENT_CLOSE = '-->';

/** True for space/tab/CR — the horizontal-rule padding, newline excluded. */
function isInlineSpace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\r';
}

/** True for the three characters markdown accepts in a horizontal rule. */
function isRuleChar(ch: string): boolean {
    return ch === '-' || ch === '*' || ch === '_';
}

/**
 * True if the line holds nothing but a markdown horizontal rule (3+ of `-*_`,
 * mixing allowed, optionally padded with spaces/tabs).
 */
function isHorizontalRule(line: string): boolean {
    let i = 0;
    while (i < line.length && isInlineSpace(line[i])) { i++; }

    let ruleChars = 0;
    while (i < line.length && isRuleChar(line[i])) { i++; ruleChars++; }
    if (ruleChars < 3) { return false; }

    while (i < line.length && isInlineSpace(line[i])) { i++; }
    return i === line.length;
}

/**
 * Remove every `<!-- ... -->` pair. An unterminated trailing `<!--` is kept
 * verbatim, matching the non-greedy regex this replaced.
 */
function stripHtmlComments(content: string): string {
    if (content.indexOf(HTML_COMMENT_OPEN) === -1) { return content; }

    let out = '';
    let from = 0;
    for (;;) {
        const open = content.indexOf(HTML_COMMENT_OPEN, from);
        if (open === -1) { break; }
        const close = content.indexOf(HTML_COMMENT_CLOSE, open + HTML_COMMENT_OPEN.length);
        if (close === -1) { break; }

        out += content.slice(from, open);
        from = close + HTML_COMMENT_CLOSE.length;
    }
    return out + content.slice(from);
}

/**
 * Clean markdown content by removing HTML comments and horizontal rules.
 * @param content - Raw section content
 * @returns Cleaned content
 */
export function cleanMarkdownContent(content: string): string {
    const withoutComments = stripHtmlComments(content);

    const withoutRules = withoutComments
        .split('\n')
        .map(line => (isHorizontalRule(line) ? '' : line))
        .join('\n');

    // Collapse runs of blank lines left behind. Safe as a regex: a counted
    // quantifier over a single literal cannot backtrack ambiguously.
    return withoutRules.replace(/\n{3,}/g, '\n\n').trim();
}

/** What the file got wrong, so the caller can tell the user instead of the console. */
export interface PromptsFileProblems {
    /** Headings that match none of the four known sections. */
    unknownSections: string[];
    /** Recognized headings with nothing written under them. */
    emptySections: string[];
}

/** Parsed prompts plus everything worth reporting back about the file. */
export interface ParsedPromptsFile {
    prompts: CustomPrompts | null;
    problems: PromptsFileProblems;
}

/**
 * Parse the custom-prompts Markdown file.
 *
 * Sections are split on H1 headings. The heading names the section; the text under
 * it is the prompt. A section the user did not write keeps the built-in prompt.
 *
 * @param content - Raw markdown file content
 */
export function parsePromptsFile(content: string): ParsedPromptsFile {
    const problems: PromptsFileProblems = { unknownSections: [], emptySections: [] };

    if (!content || content.trim() === '') {
        console.error('[Auto ALT Text Writer] Empty markdown content');
        return { prompts: null, problems };
    }

    const result: CustomPrompts = {};

    // Split by H1 headers (# Section Name)
    // Use regex to find all H1 headers and their content
    const h1Regex = /^# (.+)$/gm;
    const sections: Array<{ title: string; content: string }> = [];

    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = h1Regex.exec(content)) !== null) {
        // Save previous section if exists
        if (sections.length > 0) {
            const prevSection = sections[sections.length - 1];
            const rawContent = content.substring(lastIndex, match.index).trim();
            prevSection.content = rawContent;
        }

        // Add new section
        sections.push({
            title: match[1].trim(),
            content: '' // Will be filled in next iteration or at end
        });

        lastIndex = match.index + match[0].length;
    }

    // Handle last section
    if (sections.length > 0) {
        const lastSection = sections[sections.length - 1];
        const rawContent = content.substring(lastIndex).trim();
        lastSection.content = rawContent;
    }

    if (sections.length === 0) {
        console.error('[Auto ALT Text Writer] No H1 sections found in markdown');
        return { prompts: null, problems };
    }

    // Map sections to CustomPrompts structure
    for (const section of sections) {
        const label = section.title;
        const path = findSectionMapping(label);
        if (!path) {
            // Collected rather than swallowed: a heading nobody recognizes is the most
            // common way a prompts file "does nothing" with no explanation.
            problems.unknownSections.push(label);
            continue;
        }

        // The heading is a label for sorting sections, NOT part of the prompt. What the
        // user wrote under it is the whole instruction, so it is the only thing sent.
        const body = cleanMarkdownContent(section.content);

        if (body === '') {
            problems.emptySections.push(label);
            continue;
        }

        // Set value in result object using dot notation path (e.g., "imageAlt.seo").
        const [parentKey, childKey] = path.split('.');

        if (parentKey === 'imageAlt') {
            if (!result.imageAlt) {
                result.imageAlt = {};
            }
            if (childKey === 'seo' || childKey === 'a11y') {
                result.imageAlt[childKey] = body;
            }
        } else if (parentKey === 'videoDescription') {
            if (!result.videoDescription) {
                result.videoDescription = {};
            }
            if (childKey === 'summary' || childKey === 'transcript') {
                result.videoDescription[childKey] = body;
            }
        }
    }

    // Nothing usable in the file: fall back to the built-in prompts entirely.
    if (Object.keys(result).length === 0) {
        console.error('[Auto ALT Text Writer] No valid prompts found in markdown');
        return { prompts: null, problems };
    }

    return { prompts: result, problems };
}

/**
 * Parse and return only the prompts, discarding the problem report.
 * Kept for call sites and tests that do not surface problems to the user.
 */
export function parseMarkdownPrompts(content: string): CustomPrompts | null {
    return parsePromptsFile(content).prompts;
}


/**
 * Cheap (no filesystem) selection of the effective custom-prompts setting value,
 * applying the origin-trust policy. Warns at most once per session when a repository
 * setting tries to point the prompts file outside the workspace.
 */
function getSelectedPromptValue(): SelectedPromptValue | null {
    const config = vscode.workspace.getConfiguration('autoAltWriter');
    const inspect = config.inspect<string>('customFilePath');
    if (!inspect) {
        return null;
    }

    // Visibility: a repo trying to point the prompts file outside the workspace is a
    // (benign-by-design) security event. The setting silently doing nothing is worse
    // than the event itself, so say so in the UI — a toast with a jump to the setting,
    // never a modal. Guard ensures this fires at most once per session.
    const repoValue = inspect.workspaceFolderValue ?? inspect.workspaceValue;
    if (!warnedRepoAbsolutePromptPath && repoValue !== undefined && isAbsoluteOrTilde(repoValue)) {
        warnedRepoAbsolutePromptPath = true;
        console.warn(
            '[Auto ALT Text Writer] Ignored an absolute custom-prompts path from workspace settings; ' +
            'only User (global) settings may point outside the workspace.'
        );
        void showWarning(
            vscode.l10n.t(
                'Ignored the custom prompts path in this workspace\'s settings: only User settings may point outside the workspace. Move it to User settings to use it.'
            ),
            editCustomFilePathAction()
        );
    }

    return selectTrustedPromptValue({
        defaultValue: inspect.defaultValue,
        globalValue: inspect.globalValue,
        workspaceValue: inspect.workspaceValue,
        workspaceFolderValue: inspect.workspaceFolderValue,
    });
}

/** Section names the user may write, in the order the documentation lists them. */
const KNOWN_SECTION_NAMES = 'SEO, A11Y, Video, Transcript';

/** Problem messages already shown this session, so a warm loop cannot spam. */
const reportedPromptProblems = new Set<string>();

/**
 * Tell the user what the prompts file got wrong.
 *
 * A section that silently does nothing is the worst outcome this feature has: the user
 * wrote a prompt, sees no change, and has no way to find out why. Each distinct problem
 * is shown once per session with a button that opens the file at fault.
 */
function reportPromptsFileProblems(problems: PromptsFileProblems, filePath: string): void {
    const messages: string[] = [];

    for (const heading of problems.unknownSections) {
        messages.push(vscode.l10n.t(
            '"{0}" is not a section this extension knows, so it was ignored. Use one of: {1}.',
            heading,
            KNOWN_SECTION_NAMES
        ));
    }
    for (const heading of problems.emptySections) {
        messages.push(vscode.l10n.t('The "{0}" section is empty, so the built-in prompt is used.', heading));
    }

    for (const message of messages) {
        if (reportedPromptProblems.has(message)) {
            continue;
        }
        reportedPromptProblems.add(message);
        void showWarning(message, openPromptsFileAction(filePath));
    }
}

/**
 * Load and parse custom prompts from the resolved Markdown file.
 * Returns null if no safe file exists or it cannot be parsed (use defaults).
 *
 * Performance: the cheap config.inspect + trust-policy selection runs on every call
 * (no filesystem I/O). The fs-heavy resolveSafePromptPath is only called on a cache
 * miss or when the selected setting value changes.
 *
 * Security: path trust/containment is enforced via origin-based absolute-path policy
 * + realpath symlink-escape protection (see utils/security.ts).
 */
export function loadCustomPrompts(): CustomPrompts | null {
    try {
        // Cheap path: config.inspect + trust policy — no filesystem I/O.
        const selected = getSelectedPromptValue();
        if (!selected) {
            return null;
        }

        const selectedKey = `${selected.trusted ? 'T' : 'U'}:${selected.value}`;
        // Warm cache: same selection as last time AND we have a parsed result → no fs I/O.
        if (selectedKey === lastSelectedPromptKey && customPromptsCache !== null) {
            return customPromptsCache;
        }
        lastSelectedPromptKey = selectedKey;

        // Cache miss or selection changed — now do the fs-heavy resolution.
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const absolutePath = resolveSafePromptPath(selected.value, selected.trusted, workspaceRoot, os.homedir());
        if (!absolutePath) {
            customPromptsCache = null;
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
        const { prompts, problems } = parsePromptsFile(fileContent);
        reportPromptsFileProblems(problems, absolutePath);

        if (!prompts) {
            console.error('[Auto ALT Text Writer] Invalid custom prompts structure');
            return null;
        }

        customPromptsCache = prompts;
        return prompts;
    } catch (error) {
        if (error instanceof Error && !error.message.includes('ENOENT')) {
            console.error('[Auto ALT Text Writer] Failed to load custom prompts:', error);
        }
        return null;
    }
}
