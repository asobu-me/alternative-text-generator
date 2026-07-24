import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    validateImageSrc,
    sanitizeFilePath,
    escapeHtml,
    validateRemoteImageUrl,
    selectTrustedPromptValue,
    resolveSafePromptPath,
    isPathInside,
    MAX_PROMPT_FILE_SIZE
} from '../../utils/security';
import { cleanMarkdownContent, parseMarkdownPrompts, parsePromptsFile } from '../../core/prompts';
import { getCommentFormat } from '../../utils/fileUtils';

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

        suite('symlink hardening (existing files)', () => {
            let ws: string;
            let outside: string;

            setup(() => {
                const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aaw-img-')));
                ws = path.join(tmp, 'public');
                outside = path.join(tmp, 'secrets');
                fs.mkdirSync(ws);
                fs.mkdirSync(outside);
            });

            test('resolves a real file inside the base', () => {
                fs.writeFileSync(path.join(ws, 'a.png'), 'img');
                assert.strictEqual(sanitizeFilePath('a.png', ws), path.join(ws, 'a.png'));
            });

            test('rejects an in-workspace symlink that escapes via realpath', () => {
                fs.writeFileSync(path.join(outside, 'secret.png'), 'TOP SECRET');
                fs.symlinkSync(path.join(outside, 'secret.png'), path.join(ws, 'link.png'));
                assert.strictEqual(sanitizeFilePath('link.png', ws), null);
            });

            test('still returns a not-yet-existing path (caller handles not-found)', () => {
                assert.strictEqual(sanitizeFilePath('missing.png', ws), path.join(ws, 'missing.png'));
            });
        });
    });

    suite('isPathInside', () => {
        const base = path.resolve('/work/proj');
        test('treats the directory itself as inside', () => {
            assert.strictEqual(isPathInside(base, base), true);
        });
        test('treats a child path as inside', () => {
            assert.strictEqual(isPathInside(path.join(base, 'a', 'b'), base), true);
        });
        test('rejects a sibling sharing the name prefix', () => {
            assert.strictEqual(isPathInside(path.resolve('/work/proj-secrets'), base), false);
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

        test('blocks IPv4-compatible IPv6 loopback (::127.0.0.1)', async () => {
            const r = await validateRemoteImageUrl('http://[::127.0.0.1]/');
            assert.strictEqual(r.valid, false);
        });

        test('blocks NAT64-embedded loopback (64:ff9b::7f00:1)', async () => {
            const r = await validateRemoteImageUrl('http://[64:ff9b::7f00:1]/');
            assert.strictEqual(r.valid, false);
        });

        test('blocks IPv6 unique-local fc00::/7', async () => {
            const r = await validateRemoteImageUrl('http://[fd12:3456::1]/');
            assert.strictEqual(r.valid, false);
        });

        test('blocks IPv6 link-local fe80::/10', async () => {
            const r = await validateRemoteImageUrl('http://[fe80::1]/');
            assert.strictEqual(r.valid, false);
        });

        test('allows a public IPv6 literal and pins its address', async () => {
            const r = await validateRemoteImageUrl('http://[2606:4700:4700::1111]/');
            assert.strictEqual(r.valid, true);
            assert.strictEqual(r.family, 6);
            assert.ok(r.address);
        });

        test('returns the pinned address/family for a public IPv4 literal', async () => {
            const r = await validateRemoteImageUrl('http://8.8.8.8/a.png');
            assert.strictEqual(r.valid, true);
            assert.strictEqual(r.address, '8.8.8.8');
            assert.strictEqual(r.family, 4);
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

        test('falls back from a folder ABSOLUTE value to a workspace RELATIVE value', () => {
            // folder scope is absolute (untrusted → dropped) but must NOT shadow the
            // legitimate relative value at the workspace scope.
            const r = selectTrustedPromptValue({
                defaultValue: '.vscode/custom-prompts.md',
                workspaceFolderValue: '/Users/victim/.ssh/id_rsa',
                workspaceValue: 'config/prompts.md',
            });
            assert.deepStrictEqual(r, { value: 'config/prompts.md', trusted: false });
        });

        test('drops both untrusted absolute scopes and falls back to default', () => {
            const r = selectTrustedPromptValue({
                defaultValue: '.vscode/custom-prompts.md',
                workspaceFolderValue: '/etc/passwd',
                workspaceValue: '~/secrets.md',
            });
            assert.deepStrictEqual(r, { value: '.vscode/custom-prompts.md', trusted: true });
        });

        test('returns null when nothing is set', () => {
            assert.strictEqual(selectTrustedPromptValue({}), null);
        });
    });

    suite('resolveSafePromptPath', () => {
        let ws: string;        // workspace root (realpath-normalized)
        let outside: string;   // a sibling dir outside the workspace
        let home: string;      // fake home dir for ~ expansion

        setup(() => {
            const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aaw-')));
            ws = path.join(tmp, 'proj');
            outside = path.join(tmp, 'proj-secrets'); // shares the "proj" prefix on purpose
            home = path.join(tmp, 'home');
            fs.mkdirSync(ws);
            fs.mkdirSync(outside);
            fs.mkdirSync(home);
        });

        test('resolves a relative path inside the workspace', () => {
            const file = path.join(ws, '.vscode');
            fs.mkdirSync(file);
            fs.writeFileSync(path.join(file, 'custom-prompts.md'), '# hi');
            const r = resolveSafePromptPath('.vscode/custom-prompts.md', false, ws, home);
            assert.strictEqual(r, path.join(ws, '.vscode', 'custom-prompts.md'));
        });

        test('rejects a relative path that escapes the workspace via symlink', () => {
            fs.writeFileSync(path.join(outside, 'secret.md'), 'TOP SECRET');
            // workspace-internal symlink pointing OUT to the sibling secrets dir
            fs.symlinkSync(path.join(outside, 'secret.md'), path.join(ws, 'link.md'));
            const r = resolveSafePromptPath('link.md', false, ws, home);
            assert.strictEqual(r, null);
        });

        test('rejects a symlink into a sibling dir sharing the name prefix', () => {
            fs.writeFileSync(path.join(outside, 'p.md'), 'x');
            fs.symlinkSync(outside, path.join(ws, 'sib')); // ws/sib -> .../proj-secrets
            const r = resolveSafePromptPath('sib/p.md', false, ws, home);
            assert.strictEqual(r, null);
        });

        test('allows a trusted absolute path outside the workspace', () => {
            const abs = path.join(outside, 'global.md');
            fs.writeFileSync(abs, '# global');
            const r = resolveSafePromptPath(abs, true, ws, home);
            assert.strictEqual(r, abs);
        });

        test('expands ~ for a trusted path', () => {
            fs.writeFileSync(path.join(home, 'prompts.md'), '# home');
            const r = resolveSafePromptPath('~/prompts.md', true, ws, home);
            assert.strictEqual(r, path.join(home, 'prompts.md'));
        });

        test('rejects an absolute path that is NOT trusted (defensive)', () => {
            const abs = path.join(outside, 'global.md');
            fs.writeFileSync(abs, '# global');
            const r = resolveSafePromptPath(abs, false, ws, home);
            assert.strictEqual(r, null);
        });

        test('returns null for a non-existent relative path', () => {
            assert.strictEqual(resolveSafePromptPath('nope.md', false, ws, home), null);
        });

        test('returns null when the path is a directory', () => {
            fs.mkdirSync(path.join(ws, 'adir'));
            assert.strictEqual(resolveSafePromptPath('adir', false, ws, home), null);
        });

        test('returns null for a file over the size cap', () => {
            fs.writeFileSync(path.join(ws, 'big.md'), Buffer.alloc(MAX_PROMPT_FILE_SIZE + 1));
            assert.strictEqual(resolveSafePromptPath('big.md', false, ws, home), null);
        });

        test('accepts a file exactly at the size cap', () => {
            fs.writeFileSync(path.join(ws, 'atcap.md'), Buffer.alloc(MAX_PROMPT_FILE_SIZE));
            assert.strictEqual(
                resolveSafePromptPath('atcap.md', false, ws, home),
                path.join(ws, 'atcap.md')
            );
        });

        test('returns null for a relative path when there is no workspace', () => {
            assert.strictEqual(resolveSafePromptPath('a.md', false, undefined, home), null);
        });

        test('rejects a relative .. traversal that escapes the workspace', () => {
            fs.writeFileSync(path.join(outside, 's.md'), 'secret');
            const r = resolveSafePromptPath('../proj-secrets/s.md', false, ws, home);
            assert.strictEqual(r, null);
        });

        test('resolves a relative file even when the workspace root is itself a symlink', () => {
            fs.mkdirSync(path.join(ws, 'cfg'));
            fs.writeFileSync(path.join(ws, 'cfg', 'p.md'), '# x');
            const wsLink = path.join(path.dirname(ws), 'proj-link');
            fs.symlinkSync(ws, wsLink); // proj-link -> proj
            const r = resolveSafePromptPath('cfg/p.md', false, wsLink, home);
            assert.strictEqual(r, path.join(ws, 'cfg', 'p.md')); // realpath resolves to the real root
        });
    });

    suite('custom-prompts markdown scanning', () => {
        // A repository can ship .vscode/custom-prompts.md and have it parsed with no
        // further opt-in, so these run on untrusted input. The budget is deliberately
        // loose (it only has to fail on quadratic behaviour): the regexes these
        // replaced needed 8.5s / 54s / 43s on the same inputs.
        const BUDGET_MS = 2000;

        function timed(label: string, run: () => void): void {
            const started = Date.now();
            run();
            const elapsed = Date.now() - started;
            assert.ok(elapsed < BUDGET_MS, `${label} took ${elapsed}ms (budget ${BUDGET_MS}ms)`);
        }

        test('cleanMarkdownContent stays linear on unterminated comments', () => {
            const hostile = '<!--'.repeat(MAX_PROMPT_FILE_SIZE / 4);
            timed('cleanMarkdownContent', () => {
                assert.strictEqual(cleanMarkdownContent(hostile), hostile);
            });
        });

        test('cleanMarkdownContent stays linear on a wall of newlines', () => {
            const hostile = '\n'.repeat(MAX_PROMPT_FILE_SIZE);
            timed('cleanMarkdownContent', () => {
                assert.strictEqual(cleanMarkdownContent(hostile), '');
            });
        });

        test('cleanMarkdownContent strips comments and horizontal rules', () => {
            const input = 'A\n\n<!-- hidden -->\n\n---\n\nB';
            assert.strictEqual(cleanMarkdownContent(input), 'A\n\nB');
        });

        test('cleanMarkdownContent keeps rule-like text that is not alone on its line', () => {
            assert.strictEqual(cleanMarkdownContent('a --- b'), 'a --- b');
        });

        test('cleanMarkdownContent treats mixed rule characters as a rule', () => {
            assert.strictEqual(cleanMarkdownContent('A\n  -*_  \nB'), 'A\n\nB');
        });
    });

    suite('getCommentFormat', () => {
        // The body is model output. With an attacker-supplied prompts file it is
        // fully attacker-chosen, so a comment terminator in it must not escape
        // into the user's source file.
        test('neutralizes --> in an HTML comment', () => {
            const out = getCommentFormat('a.html', 'x --> <script>alert(1)</script> <!-- y');
            assert.ok(!out.slice(4, -3).includes('-->'), out);
            assert.ok(out.startsWith('<!-- ') && out.endsWith(' -->'));
        });

        test('neutralizes the --!> comment terminator too', () => {
            const out = getCommentFormat('a.html', 'x --!> <script>alert(1)</script>');
            assert.ok(!out.includes('--!>'), out);
        });

        test('neutralizes */ in a PHP comment', () => {
            const out = getCommentFormat('a.php', 'x */ system($_GET[0]); /*');
            assert.ok(!out.slice(9, -5).includes('*/'), out);
            assert.ok(out.startsWith('<?php /* ') && out.endsWith(' */ ?>'));
        });

        test('neutralizes */ in a JSX comment', () => {
            const out = getCommentFormat('a.tsx', 'x */} alert(1) {/*');
            assert.ok(!out.slice(3, -3).includes('*/'), out);
            assert.ok(out.startsWith('{/* ') && out.endsWith(' */}'));
        });

        test('leaves ordinary text untouched', () => {
            assert.strictEqual(
                getCommentFormat('a.html', 'Video description: a desk by a window'),
                '<!-- Video description: a desk by a window -->'
            );
        });
    });

    suite('custom-prompts sections', () => {
        // The documented format is: a heading names the section, the text under it is
        // the prompt, and only what you write is overridden.
        const SECTIONS = ['SEO', 'A11Y', 'Video', 'Transcript'];

        test('all four documented headings are recognized', () => {
            for (const heading of SECTIONS) {
                const { prompts, problems } = parsePromptsFile(`# ${heading}\n\ninstruction\n`);
                assert.ok(prompts, `${heading} produced no prompts`);
                assert.deepStrictEqual(problems.unknownSections, [], heading);
            }
        });

        test('headings are case-insensitive', () => {
            const { prompts } = parsePromptsFile('# seo\n\ninstruction\n');
            assert.strictEqual(prompts?.imageAlt?.seo, 'instruction');
        });

        test('the heading is a label, not part of the prompt', () => {
            const { prompts } = parsePromptsFile('# SEO\n\ninstruction\n');
            assert.strictEqual(prompts?.imageAlt?.seo, 'instruction');
        });

        test('a section left unwritten is absent, so the built-in prompt stands', () => {
            const { prompts } = parsePromptsFile('# SEO\n\ninstruction\n');
            assert.strictEqual(prompts?.imageAlt?.a11y, undefined);
            assert.strictEqual(prompts?.videoDescription, undefined);
        });

        test('an unrecognized heading is reported, not swallowed', () => {
            const { problems } = parsePromptsFile('# SEO\n\nok\n\n# Sumary\n\noops\n');
            assert.deepStrictEqual(problems.unknownSections, ['Sumary']);
        });

        test('Context is not a section: the redundancy rule is not customizable', () => {
            const { problems } = parsePromptsFile('# SEO\n\nok\n\n# Context\n\nrules\n');
            assert.deepStrictEqual(problems.unknownSections, ['Context']);
        });

        test('an empty section is reported', () => {
            const { problems } = parsePromptsFile('# SEO\n\nok\n\n# A11Y\n\n');
            assert.deepStrictEqual(problems.emptySections, ['A11Y']);
        });

        test('a Model heading is now just an unknown section', () => {
            const { problems } = parsePromptsFile('# SEO\n\nok\n\n# Model\n\ngemini-2.5-pro\n');
            assert.deepStrictEqual(problems.unknownSections, ['Model']);
        });

        test('a MODE: comment no longer identifies a section', () => {
            // The only thing that names a section now is the H1 text itself.
            const withMode = '<!-- MODE: seo -->\n# Notes\n\ninstruction\n';
            const { prompts, problems } = parsePromptsFile(withMode);
            assert.strictEqual(prompts, null);
            assert.deepStrictEqual(problems.unknownSections, ['Notes']);
        });
    });

    suite('documented custom-prompts example', () => {
        // docs/custom-prompts.example.md is what users are told to copy, and the README
        // tables describe it. Parse the real file so the docs cannot drift away from
        // the parser: a renamed MODE or a dropped placeholder fails here.
        const examplePath = path.resolve(__dirname, '../../../docs/custom-prompts.example.md');
        const parsed = parseMarkdownPrompts(fs.readFileSync(examplePath, 'utf8'));

        test('every documented section is recognized', () => {
            assert.ok(parsed, 'example file failed to parse');
            assert.ok(parsed.imageAlt?.seo, 'MODE: seo missing');
            assert.ok(parsed.imageAlt?.a11y, 'MODE: a11y missing');
            assert.ok(parsed.videoDescription?.summary, 'MODE: video missing');
            assert.ok(parsed.videoDescription?.transcript, 'MODE: transcript missing');
        });

        test('the example teaches no placeholder syntax', () => {
            const everySection = JSON.stringify(parsed);
            for (const token of ['{context}', '{surroundingText}', '{languageConstraint}', '{charConstraint}', '{mediaType}']) {
                assert.ok(!everySection.includes(token), `example still uses ${token}`);
            }
        });

        test('the heading is not part of the prompt, and notes-to-self are not sent', () => {
            assert.ok(parsed?.imageAlt?.seo?.startsWith('You are an SEO expert'), parsed?.imageAlt?.seo);
            assert.ok(!parsed?.imageAlt?.seo?.includes('#'));
            assert.ok(!parsed?.imageAlt?.seo?.includes('<!--'));
        });
    });
});
