/**
 * First-use consent for the shared free tier.
 *
 * The extension ships a shared Gemini key, so the very first generation would send
 * the user's image or text to Google's free tier without them ever choosing to.
 * Under the Gemini API terms, free-tier data may be used to improve Google's models.
 * So the first time the proxy path would be used, we ask first — and send nothing
 * until the user agrees.
 *
 * Storage: a boolean in globalState (not the workspace) — the shared key is the same
 * across every workspace, so consent is asked once per machine, not once per project.
 */

import * as vscode from 'vscode';
import { getUserApiKey } from './apiKey';

/** globalState flag. Kept stable so consent is never re-asked after an update. */
const FLAG = 'freeTierConsent';

let memento: vscode.Memento | undefined;

/** Wire up globalState. Call once from activate(). */
export function initFreeTierNotice(context: vscode.ExtensionContext): void {
    memento = context.globalState;
}

/**
 * Gate the first-ever use of the shared free tier behind explicit consent.
 *
 * Returns true when generation may proceed — either a user key is set (the free tier
 * is not involved) or the user has agreed. Returns false when the user declined, in
 * which case the caller MUST NOT send anything.
 *
 * Awaited at the command entry point, before any request is built: the whole point is
 * that nothing reaches Google until this resolves true.
 */
export async function ensureFreeTierConsent(): Promise<boolean> {
    // BYOK users never touch the shared free tier — their key, their terms.
    if (await getUserApiKey()) {
        return true;
    }
    if (memento?.get<boolean>(FLAG)) {
        return true;
    }

    const cont = vscode.l10n.t('Continue');
    const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t('This sends your image or video to Google to generate the text. On the free tier, what you send may be used to improve Google’s AI, including training. Do not send anything sensitive or private.'),
        cont,
        vscode.l10n.t('Cancel')
    );

    // Only "Continue" proceeds. Cancel, or dismissing the notice, sends nothing.
    if (choice === cont) {
        await memento?.update(FLAG, true);
        return true;
    }
    return false;
}
