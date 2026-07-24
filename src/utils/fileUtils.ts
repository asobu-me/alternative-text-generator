/**
 * File and MIME type utilities
 */

import * as path from 'path';

/**
 * Get MIME type for image files based on extension
 */
export function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp'
    };
    return mimeTypes[ext] || 'image/jpeg';
}

/**
 * Get MIME type for video files based on extension
 */
export function getVideoMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.ogg': 'video/ogg',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo'
    };
    return mimeTypes[ext] || 'video/mp4';
}

/**
 * Neutralize the sequences that would end an HTML comment.
 *
 * The HTML parser closes a comment on `-->` AND on `--!>`, so a body containing
 * either would put the rest of the model's output into the document as markup —
 * i.e. script injection into the user's source file. Escaping the `>` keeps the
 * text readable while making it inert.
 */
function escapeHtmlCommentBody(content: string): string {
    return content
        .replace(/--!>/g, '--!&gt;')
        .replace(/-->/g, '--&gt;');
}

/**
 * Neutralize the sequence that would end a C-style block comment (`/* ... *\/`),
 * used by both the JSX and PHP formats. A bare `*\/` in the body would otherwise
 * close the comment early and let the remaining text be parsed as JSX or PHP.
 *
 * `?>` is deliberately NOT touched: PHP does not leave PHP mode inside a block
 * comment, so it cannot break out and mangling it would only corrupt the text.
 */
function escapeBlockCommentBody(content: string): string {
    return content.replace(/\*\//g, '* /');
}

/**
 * Get comment format based on file extension.
 *
 * Escaping happens HERE rather than at the call site: this is the single place
 * that knows which comment syntax is being produced, so a new caller cannot
 * forget to sanitize model output before it lands in the user's file.
 *
 * @param filePath - Path to the file
 * @param content - Content to be commented (untrusted: comes from the model)
 * @returns Formatted comment string
 */
export function getCommentFormat(filePath: string, content: string): string {
    const ext = path.extname(filePath).toLowerCase();

    switch (ext) {
        case '.jsx':
        case '.tsx':
            // JSX/TSX: {/* comment */}
            return `{/* ${escapeBlockCommentBody(content)} */}`;

        case '.php':
            // PHP: <?php /* comment */ ?>
            return `<?php /* ${escapeBlockCommentBody(content)} */ ?>`;

        case '.html':
        case '.htm':
        default:
            // HTML and others: <!-- comment -->
            return `<!-- ${escapeHtmlCommentBody(content)} -->`;
    }
}
