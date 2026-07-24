# Changelog

All notable changes to Auto ALT Text Writer are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-24

First release.

### Added

- Generate `alt` for `<img>` / `<Image>` tags with `Cmd+Alt+A` (Windows/Linux: `Ctrl+K Ctrl+A`), from the right-click menu, or from the Command Palette.
- Generate `aria-label` for `<video>` tags with `Cmd+Alt+V` (Windows/Linux: `Ctrl+K Ctrl+V`), or insert a transcript as a comment above the tag.
- Batch processing: select a range to handle every tag in it, in chunks of 10.
- Works with no API key. A shared free tier is built in; the key lives on a proxy, not in the extension. The first generation asks for consent before anything is sent to Google.
- Bring your own Gemini API key for your own rate limits and a direct connection to Google. The key is stored in the OS keychain via VS Code SecretStorage, never in `settings.json`.
- Two writing modes for images: for search engines (SEO) or for screen readers (A11Y).
- Decorative images are given `alt=""` based on filename keywords (`icon-`, `bg-`, `deco-` by default).
- Optional context analysis: reads the text around the tag and uses `alt=""` when that text already describes the image.
- Custom prompts via a Markdown file (`.vscode/custom-prompts.md` by default). Four headings — `SEO`, `A11Y`, `Video`, `Transcript` — each override one built-in prompt; unwritten sections keep the default. Unknown or empty headings raise a notification instead of failing silently.
- Path resolution for Next.js, Vite, Create React App, Astro and Remix: a path starting with `/` resolves to `public`.
- A file picker for images whose `src` is only known at runtime (a variable or template literal), and for static paths that do not exist. Identical expressions are asked about once per session.
- Confirm each result before insertion, or insert automatically.
- Japanese and English interface, following the VS Code display language. Output language follows the display language by default and can be pinned in settings.
- Supported files: HTML, PHP, JS/JSX, TS/TSX. Images: JPG, PNG, GIF, WebP, BMP. Videos up to 20MB.

### Security

- The Gemini key on the default path exists only on the Cloudflare Worker proxy, which allow-lists the model name, requires inline media, caps the request body and rate-limits by IP.
- Remote images cannot reach private IP ranges (SSRF protection), and the connection is pinned to the address that was validated.
- Local files are confined to the workspace, with `realpath` checks so a symlink cannot escape it. An absolute custom-prompts path is honoured only from User settings, never from a repository's settings.
- The custom-prompts file is treated as untrusted input: Workspace Trust is required, the parser uses no regular expressions and stays linear on adversarial input, and the file is capped at 256KB.
- Generated text is escaped before it is written into an attribute, and comment terminators (`-->`, `*/`) in a transcript are neutralized before it becomes a comment.

[1.0.0]: https://github.com/asobu-me/auto-alt-text-writer/releases/tag/v1.0.0
