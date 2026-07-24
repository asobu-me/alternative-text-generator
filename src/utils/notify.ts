/**
 * Centralized user-facing notifications.
 *
 * Copy rules (see CLAUDE.md "Notification copy"):
 * - No emoji at all. VS Code renders its own severity icon, so a leading emoji
 *   reads as a second icon, and the wording already carries the meaning
 *   ("decorative: matched ...", "already described by the surrounding text").
 * - Every error states what happened AND what to do next; when the next step is
 *   an action VS Code can perform, it is offered as a button rather than prose.
 * - All strings go through vscode.l10n.t() so l10n/bundle.l10n.*.json can translate them.
 */

import * as vscode from 'vscode';
import { RateLimitError, AuthenticationError } from './errors';

/** A notification button: label plus the effect of pressing it. */
interface NotifyAction {
    title: string;
    run: () => void | Promise<void>;
}

async function present(
    kind: 'error' | 'warning' | 'info',
    message: string,
    actions: NotifyAction[]
): Promise<void> {
    const show = kind === 'error'
        ? vscode.window.showErrorMessage
        : kind === 'warning'
            ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage;

    const picked = await show(message, ...actions.map(a => a.title));
    if (picked === undefined) { return; }
    await actions.find(a => a.title === picked)?.run();
}

/** Error notification with optional recovery buttons. */
export function showError(message: string, ...actions: NotifyAction[]): Promise<void> {
    return present('error', message, actions);
}

/** Warning notification with optional recovery buttons. */
export function showWarning(message: string, ...actions: NotifyAction[]): Promise<void> {
    return present('warning', message, actions);
}

/** Informational notification with optional follow-up buttons. */
export function showInfo(message: string, ...actions: NotifyAction[]): Promise<void> {
    return present('info', message, actions);
}

// ---------------------------------------------------------------------------
// Progress message composition
// ---------------------------------------------------------------------------

/**
 * Body of a progress notification: position (only when there is more than one
 * item) plus the file being worked on. VS Code renders it as "title: message",
 * so the title supplies the verb and this supplies the subject — never repeat
 * the total here, it already lives in the counter.
 *
 * Not localized on purpose: the output is digits, a slash and a filename.
 */
export function formatProgressMessage(fileName: string, current: number, total: number): string {
    return total === 1 ? fileName : `${current}/${total}  ${fileName}`;
}

// ---------------------------------------------------------------------------
// Reusable recovery actions
// ---------------------------------------------------------------------------

/** Open the BYOK key input. Offered whenever quota/auth is the blocker. */
function setApiKeyAction(): NotifyAction {
    return {
        title: vscode.l10n.t('Set API key'),
        run: () => { vscode.commands.executeCommand('auto-alt-writer.setApiKey'); }
    };
}

/** Open a folder — relative paths cannot be resolved without a workspace. */
export function openFolderAction(): NotifyAction {
    return {
        title: vscode.l10n.t('Open Folder'),
        run: () => { vscode.commands.executeCommand('workbench.action.files.openFolder'); }
    };
}

/** Jump to a specific extension setting. */
function openSettingAction(title: string, settingId: string): NotifyAction {
    return {
        title,
        run: () => { vscode.commands.executeCommand('workbench.action.openSettings', settingId); }
    };
}

/** Reveal the decorative-keyword list that produced a decorative verdict. */
export function editDecorativeKeywordsAction(): NotifyAction {
    return openSettingAction(vscode.l10n.t('Edit keywords'), 'autoAltWriter.decorativeKeywords');
}

/** Reveal the custom-prompts path, e.g. after a repository value was refused. */
export function editCustomFilePathAction(): NotifyAction {
    return openSettingAction(vscode.l10n.t('Edit setting'), 'autoAltWriter.customFilePath');
}

/** Open the prompts file itself — offered whenever something in it did not apply. */
export function openPromptsFileAction(filePath: string): NotifyAction {
    return {
        title: vscode.l10n.t('Open file'),
        run: async () => {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
        }
    };
}

// ---------------------------------------------------------------------------
// Error → message + actions
// ---------------------------------------------------------------------------

/**
 * Surface a thrown error with the recovery buttons that fit its type.
 * Quota and auth failures both point at BYOK, which is otherwise only
 * reachable from the command palette.
 */
export async function showErrorForException(error: unknown, message: string): Promise<void> {
    if (error instanceof RateLimitError || error instanceof AuthenticationError) {
        await showError(message, setApiKeyAction());
        return;
    }
    await showError(message);
}
