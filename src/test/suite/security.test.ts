import * as assert from 'assert';
import * as path from 'path';
import {
    validateImageSrc,
    sanitizeFilePath,
    escapeHtml,
    validateRemoteImageUrl,
    selectTrustedPromptValue
} from '../../utils/security';

suite('security', () => {
    suite('validateImageSrc', () => {
        test('rejects javascript: protocol', () => {
            assert.strictEqual(validateImageSrc('javascript:alert(1)').valid, false);
        });

        test('rejects data: URI', () => {
            assert.strictEqual(validateImageSrc('data:image/png;base64,AAAA').valid, false);
        });

        test('rejects template-literal expression', () => {
            assert.strictEqual(validateImageSrc('${someVar}.png').valid, false);
        });

        test('allows a normal relative path', () => {
            assert.strictEqual(validateImageSrc('images/foo.png').valid, true);
        });

        test('allows an https URL', () => {
            assert.strictEqual(validateImageSrc('https://example.com/a.png').valid, true);
        });
    });

    suite('sanitizeFilePath', () => {
        const base = path.resolve('/tmp/alt-gen-workspace');

        test('rejects parent-directory traversal', () => {
            assert.strictEqual(sanitizeFilePath('../secret.png', base), null);
        });

        test('rejects tilde paths', () => {
            assert.strictEqual(sanitizeFilePath('~/secret.png', base), null);
        });

        test('resolves a normal path within the base', () => {
            assert.strictEqual(sanitizeFilePath('img/a.png', base), path.join(base, 'img', 'a.png'));
        });

        test('strips a leading slash and resolves under the base', () => {
            assert.strictEqual(sanitizeFilePath('/img/a.png', base), path.join(base, 'img', 'a.png'));
        });

        test('does not leak into a sibling directory sharing the name prefix', () => {
            // path.resolve collapses to a sibling only via "..", which is already
            // rejected; this asserts the separator-boundary guard holds regardless.
            const sibling = sanitizeFilePath('../alt-gen-workspace-secrets/x.png', base);
            assert.strictEqual(sibling, null);
        });
    });

    suite('validateRemoteImageUrl (SSRF)', () => {
        test('blocks the cloud metadata IP', async () => {
            const r = await validateRemoteImageUrl('http://169.254.169.254/latest/meta-data/');
            assert.strictEqual(r.valid, false);
        });

        test('blocks localhost', async () => {
            const r = await validateRemoteImageUrl('http://localhost:8888/');
            assert.strictEqual(r.valid, false);
        });

        test('blocks 127.0.0.1 loopback', async () => {
            const r = await validateRemoteImageUrl('http://127.0.0.1/img.png');
            assert.strictEqual(r.valid, false);
        });

        test('blocks the 10.0.0.0/8 private range', async () => {
            const r = await validateRemoteImageUrl('http://10.0.0.5/img.png');
            assert.strictEqual(r.valid, false);
        });

        test('blocks the 192.168.0.0/16 private range', async () => {
            const r = await validateRemoteImageUrl('http://192.168.1.1/');
            assert.strictEqual(r.valid, false);
        });

        test('blocks IPv6 loopback ::1', async () => {
            const r = await validateRemoteImageUrl('http://[::1]/');
            assert.strictEqual(r.valid, false);
        });

        test('blocks IPv4-mapped IPv6 loopback', async () => {
            const r = await validateRemoteImageUrl('http://[::ffff:127.0.0.1]/');
            assert.strictEqual(r.valid, false);
        });

        test('rejects non-http(s) protocols', async () => {
            const r = await validateRemoteImageUrl('ftp://example.com/a.png');
            assert.strictEqual(r.valid, false);
        });

        test('allows a public IP literal without DNS', async () => {
            const r = await validateRemoteImageUrl('http://8.8.8.8/a.png');
            assert.strictEqual(r.valid, true);
        });
    });

    suite('escapeHtml', () => {
        test('escapes angle brackets and quotes', () => {
            assert.strictEqual(escapeHtml('<a "x">'), '&lt;a &quot;x&quot;&gt;');
        });
    });

    suite('selectTrustedPromptValue', () => {
        test('picks a repo (workspace) relative value as untrusted', () => {
            const r = selectTrustedPromptValue({
                defaultValue: '.vscode/custom-prompts.md',
                workspaceValue: 'config/prompts.md',
            });
            assert.deepStrictEqual(r, { value: 'config/prompts.md', trusted: false });
        });

        test('workspaceFolderValue takes precedence over workspaceValue', () => {
            const r = selectTrustedPromptValue({
                workspaceValue: 'a.md',
                workspaceFolderValue: 'b.md',
            });
            assert.deepStrictEqual(r, { value: 'b.md', trusted: false });
        });

        test('rejects a repo ABSOLUTE value and falls back to the global value', () => {
            const r = selectTrustedPromptValue({
                defaultValue: '.vscode/custom-prompts.md',
                globalValue: '/Users/me/prompts.md',
                workspaceValue: '/Users/victim/.ssh/id_rsa',
            });
            assert.deepStrictEqual(r, { value: '/Users/me/prompts.md', trusted: true });
        });

        test('rejects a repo absolute value and falls back to default when no global', () => {
            const r = selectTrustedPromptValue({
                defaultValue: '.vscode/custom-prompts.md',
                workspaceValue: '/etc/passwd',
            });
            assert.deepStrictEqual(r, { value: '.vscode/custom-prompts.md', trusted: true });
        });

        test('rejects a repo tilde value as untrusted-absolute', () => {
            const r = selectTrustedPromptValue({
                defaultValue: '.vscode/custom-prompts.md',
                workspaceValue: '~/secrets.md',
            });
            assert.deepStrictEqual(r, { value: '.vscode/custom-prompts.md', trusted: true });
        });

        test('allows a global absolute value as trusted', () => {
            const r = selectTrustedPromptValue({ globalValue: '/Users/me/prompts.md' });
            assert.deepStrictEqual(r, { value: '/Users/me/prompts.md', trusted: true });
        });

        test('repo relative value overrides a global absolute value', () => {
            const r = selectTrustedPromptValue({
                globalValue: '/Users/me/prompts.md',
                workspaceValue: 'config/prompts.md',
            });
            assert.deepStrictEqual(r, { value: 'config/prompts.md', trusted: false });
        });

        test('returns null when nothing is set', () => {
            assert.strictEqual(selectTrustedPromptValue({}), null);
        });
    });
});
