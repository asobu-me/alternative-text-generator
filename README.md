# Auto ALT Text Writer

A VS Code extension that generates and inserts `alt` for images, and `aria-label` (or a transcript comment) for videos, using the Gemini API.

![Demo](https://raw.githubusercontent.com/asobu-me/auto-alt-text-writer/main/images/readme.gif)

[日本語](README.ja.md)

## Usage

No API key needed. A shared free tier is built in, so it works right after installing.

Data you send through the free tier may be used by Google to improve its AI, including for training. See [Google's terms](https://ai.google.dev/gemini-api/terms) for details. Don't send sensitive or private images through it.

1. Put the cursor inside an `<img>` tag (or select a range to do several at once)
2. Press `Cmd+Alt+A` (Windows/Linux: `Ctrl+K Ctrl+A`)
3. Review the generated `alt` and insert it

For videos, `Cmd+Alt+V` (Windows/Linux: `Ctrl+K Ctrl+V`) generates an `aria-label`. Both commands are also in the right-click menu and the Command Palette.

By default you confirm each result before it is inserted. To skip that, set Insertion Mode to "Insert automatically".

### About video alternative text

`aria-label` is not a substitute for the kind of description `alt` gives an image. It conveys a title or a function to assistive technology; it is not a way to convey what happens in the video.

Prefer a description before or after the video, or audio descriptions via `<track kind="descriptions">`. Use this feature when `aria-label` is your only option.

## Settings

Press `Cmd+,` (Windows: `Ctrl+,`) and search for "Auto ALT Text Writer". Settings are grouped into Images, Videos, General and Advanced.

| Setting | Default | What it does |
|---|---|---|
| Alt Generation Mode | Search engines | Write for search engines (SEO) or for screen readers (A11Y) |
| Decorative Keywords | `icon-` `bg-` `deco-` | Filenames containing these are treated as decoration and get `alt=""` |
| Video Description Mode | Summary | A short label (aria-label) or a transcript (comment) |
| Output Language | Auto | Auto follows the VS Code display language |
| Insertion Mode | Confirm before inserting | Whether to review each result first |
| Context Analysis Enabled | Off | Read the surrounding text and use `alt=""` when it already describes the image |
| Custom File Path | `.vscode/custom-prompts.md` | Where the custom prompts file lives |

Decorative Keywords is a case-insensitive substring match on the filename. Keep the trailing hyphen (`bg-`) so that `background.jpg` is not caught as decoration.

## Custom prompts

You can replace the instructions sent to the AI with a Markdown file you write.

Run **Auto ALT Text Writer: Create a custom prompts file** from the Command Palette. It writes a working file and opens it.

The whole format is two rules.

1. A `# heading` names a section. **Only the sections you write are overridden**
2. Whatever you write under a heading is the instruction sent to the AI

```markdown
# SEO

You are an SEO expert. Describe the subject using the words people
would search for. Include the product name when it is legible.
```

That replaces the SEO instruction and nothing else. Headings you leave out keep the built-in prompt.

### Headings you can use

| Heading | What it overrides |
|---|---|
| `SEO` | Image alt, written for search engines |
| `A11Y` | Image alt, written for screen readers |
| `Video` | Video aria-label |
| `Transcript` | Video transcript |

Case does not matter. If a heading is none of these four, you get a notification.

The model is fixed at `gemini-3.5-flash-lite` and cannot be changed.

The output language and the surrounding-text rules are added by the extension. You never write them into the prompt — the settings are what decide them.

A file using all four is at [docs/custom-prompts.example.md](docs/custom-prompts.example.md).

### Where the file can live

| Value | Where you may set it | Resolved from |
|---|---|---|
| `.vscode/custom-prompts.md` (default) | nothing to configure | workspace root |
| a relative path like `prompts/my.md` | any settings scope | workspace root |
| an absolute path or `~/alt-prompts.md` | User settings only | as written — shared across projects |

An absolute path in Workspace or Folder settings is ignored. The file's contents are sent to the Gemini API, so a repository must not be able to read files outside the workspace. The file must be 256KB or smaller.

## Supported files

HTML (.html), PHP (.php), JavaScript/JSX (.js .jsx), TypeScript/TSX (.ts .tsx). **Everything except HTML supports static paths only** (a path built from a variable or template literal cannot be detected — see "How paths are written" below).

Images: JPG, PNG, GIF, WebP, BMP. SVG is not supported by the Gemini API — convert to PNG or JPG first. Videos up to 20MB (10MB or less recommended).

### Writing paths

```html
<!-- Supported -->
<img src="./images/photo.jpg">
<img src="/static/hero.jpg">
<img src="https://example.com/image.jpg">
<Image src="/static/hero.jpg" width={500} height={300} />

<!-- Not supported: the value is only known at runtime -->
<Image src={imageUrl} />
<Image src={`/uploads/${id}.jpg`} />
<img src="<?php echo $url; ?>">
```

Next.js, Vite, Create React App, Astro and Remix are detected automatically, and paths starting with `/` resolve to the `public` directory (`/logo.png` → `public/logo.png`). In a framework project, always write files in `public` with a leading `/`. A relative path looks inside `src` and will not be found.

## When something does not work

**Image not found**
Check the path. In a framework project, start it with `/`. If you opened a single file rather than a folder, relative paths cannot be resolved.

**429 Too Many Requests**
The shared free tier allows 15 requests per minute. Wait a minute, or set your own API key.

**A dynamic src cannot be processed**
A path like `src={variable}` is only known at runtime. A file picker opens so you can choose the image yourself.

**Content Blocked**
Gemini's safety filter triggered. Write the `alt` for that image manually.

**Large batches are slow**
Work is chunked into groups of 10. Context analysis adds time per item — turn it off when you are in a hurry.

## Using your own API key (optional)

Your own key gives you your own rate limits, and sends images and videos directly to Google rather than through the shared service. A free key doesn't change whether your data can be used for training, though — enable billing on the key if you want to opt out of that.

1. Create a key at [Google AI Studio](https://aistudio.google.com/app/api-keys)
2. Run "Auto ALT Text Writer: Set your Gemini API key" from the Command Palette
3. Paste the key

Run "Auto ALT Text Writer: Remove your Gemini API key" to go back to the shared free tier.

<details>
<summary>Where the key is stored, and where it is sent</summary>

The key is stored in your OS keychain through VS Code SecretStorage (macOS Keychain, Windows Credential Manager, Linux Secret Service). It is never written to `settings.json` or any plain-text file, never synced by Settings Sync, and never sent through the shared proxy. It goes to Google only, in a request header — never in the URL or in logs.

</details>

<details>
<summary>How it works, and the security model</summary>

**Default path**: so it works with no API key, requests go through a Cloudflare Worker proxy. The real Gemini key exists only on the proxy and is not part of the extension. The proxy allow-lists model names and rate-limits by IP.

**With your own key**: requests go straight to Google, bypassing the proxy. The model name is restricted to an allowed character set and the host is a fixed constant.

**Fetching images**: remote images cannot reach private IP ranges (SSRF protection), and the connection is pinned to the address that was validated. Local images are confined to the workspace, and realpath prevents escaping it through a symlink.

**Custom prompts**: the file may be supplied by a repository, so Workspace Trust is required. The parser uses no regular expressions and stays linear on adversarial input. When a transcript is written as a comment, comment terminators in it are neutralized first.

**Regular expressions**: the tag-detection patterns are checked against ReDoS.

**Memory**: batches are processed in chunks of 10, and caches are dropped after each chunk.

</details>

## License

MIT
