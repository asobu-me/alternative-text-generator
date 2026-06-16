# Auto ALT Writer

Automatically generate ALT attributes for img tags, aria-label attributes for video tags, and transcript text using Gemini API.

![Demo](https://raw.githubusercontent.com/asobu-me/alternative-text-generator/main/images/readme.gif)

## Features

### 🎯 Basic Features (Available to All Users)

#### 🖼️ ALT Generation
- Automatically generate ALT attributes for `<img>` and `<Image>` tags
- Two generation modes: **SEO** (search engine optimized) and **A11Y** (accessibility optimized)
- Batch processing support
- Automatic decorative image detection by filename keywords (e.g., `icon-`, `bg-`)

#### 🎬 Video aria-label and Transcript Generation
- Generate aria-label attributes for `<video>` tags
- Two generation modes: **Summary** (short aria-label) and **Transcript** (transcript text as HTML comment)
- Supports `<source>` tags within `<video>` elements
- File-type aware comments (HTML, JSX/TSX, PHP)

##### ⚠️ Important Accessibility Notice

The `aria-label` attribute is **insufficient** as alternative text (like `alt` for images) to visually describe video content.

This is an alternative way to convey titles or brief functions to assistive technology users, and **lacks the information needed** to convey visual information or detailed content within the video.

**Recommended accessibility approaches:**

1. **Detailed Information**: Provide visual titles and detailed descriptions before/after the video
2. **Audio Descriptions**: Use `<track kind="descriptions">` to provide detailed audio descriptions of the video content

**Use this feature only as a last resort when `aria-label` is your only option.**

### 🚀 Advanced Features

#### 📝 Context-Aware Generation (Optional)

Enable context analysis to generate more accurate descriptions by analyzing surrounding HTML elements:

**How to Enable:**
1. Open Settings (`Cmd+,` or `Ctrl+,`)
2. Search for "Auto ALT Writer: Context Analysis Enabled"
3. Check the box to enable

**What it does:**
- Analyzes text in parent elements (div, section, article, etc.)
- Considers sibling elements before and after the image
- Detects redundant descriptions (returns `alt=""` when context already describes the image)

**When to use:**
- ✅ For better accuracy and context-aware descriptions
- ❌ When you need faster processing (context analysis adds overhead)

#### 🎨 Custom Prompts (Advanced)

Want even more control? Use **Custom Prompts** to unlock:

- **Fine-tuned AI Instructions**: Write your own prompts tailored to your needs
- **SEO Optimization**: Control keyword usage and description style
- **Advanced Context Rules**: Define custom redundancy detection logic
- **Model Selection**: Choose between `gemini-2.5-flash` (fast) and `gemini-2.5-pro` (accurate)

📚 **Learn how to set up Custom Prompts:** [https://note.com/akky709](https://note.com/akky709)

> **Note:** By default, this extension focuses on **direct image/video analysis** for simplicity and speed. Context analysis can be enabled via settings or through custom prompts configuration.

### 🔒 Security & Performance
- **No-key default**: Works out of the box via a shared proxy — no personal API key is bundled into or exposed by the extension
- **Secure API Key Storage (BYOK)**: When you bring your own key, it is stored in your OS keychain via VS Code SecretStorage — never in plain text, never synced, and sent only to Google (in a request header)
- **ReDoS Protection**: Regex patterns optimized to prevent catastrophic backtracking attacks
- **Memory Efficient**: Processes large batches in chunks (10 items per chunk) to minimize memory usage
- **Smart Caching**: Multiple caching strategies reduce redundant operations
  - Document text caching with version validation
  - Custom prompts caching
  - Surrounding text caching for nearby images (10-line proximity)
  - Regex pattern caching
- **Optimized Performance**: Pre-compiled regex patterns and memoized functions
- **Type-Safe API Responses**: Fully typed Gemini API response handling prevents runtime errors
- **Cancel Support**: Stop processing anytime during batch operations
## Quick Start

### Works out of the box

**No setup or API key required.** The extension ships with a shared free tier, so you can start generating ALT text immediately — place your cursor in a tag and press the shortcut (see [Usage](#usage)).

> The shared free tier is a convenience with limited capacity (Gemini free-tier rate limits, shared across all users). For heavy or batch use, bring your own key below.

### (Optional) Use your own Gemini API key

Bring your own key to get your own rate limits and quota, and to send image/video data **directly to Google** instead of through the shared service.

**1. Get a key**
1. Visit [Google AI Studio](https://aistudio.google.com/app/api-keys)
2. Click "Create API Key" and copy it

**2. Set the key**
1. Press `Cmd+Shift+P` (Windows: `Ctrl+Shift+P`) to open the Command Palette
2. Run **"Auto ALT Writer: Set your Gemini API key (use your own quota)"**
3. Paste your key in the secure input box and press Enter

When a personal key is set, all requests go **directly to Google** using your key. Otherwise the shared free tier is used.

**🔐 How your key is stored:**
- Stored in your OS keychain via VS Code SecretStorage (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- **Never** written to `settings.json` or any plain-text file, never synced by Settings Sync, and never sent through the shared proxy
- Sent only to Google, in a request header (never placed in the URL or logs)

**To stop using your key:**
- Run **"Auto ALT Writer: Remove your Gemini API key (use shared free tier)"** to delete it and revert to the shared free tier.

### Configure Extension (Optional)

Press `Cmd+,` (Windows: `Ctrl+,`) and search for "Auto ALT Writer". Settings are grouped by scope: `[Image]` → `[Video]` → `[Common]` → `[Advanced]`.

**Available Settings:**
- **ALT Generation Mode** `[Image]`: SEO or A11Y (default: SEO)
- **Decorative Keywords** `[Image]`: Customize keywords for decorative image detection
- **Video Description Mode** `[Video]`: Summary (aria-label) or Transcript (HTML comment) (default: Summary)
- **Output Language** `[Common]`: Auto, Japanese, or English (default: Auto)
- **Insertion Mode** `[Common]`: Auto or Manual (default: Manual - review before insertion)
- **Context Analysis Enabled** `[Common]`: Enable context-aware generation (default: false)
- **Custom File Path** `[Advanced]`: Path to custom prompts Markdown file

Or edit `settings.json`:
```json
{
  "autoAltWriter.altGenerationMode": "SEO",
  "autoAltWriter.insertionMode": "confirm",
  "autoAltWriter.outputLanguage": "auto",
  "autoAltWriter.contextAnalysisEnabled": false,
  "autoAltWriter.decorativeKeywords": ["icon-", "bg-", "deco-"],
  "autoAltWriter.videoDescriptionMode": "summary",
  "autoAltWriter.customFilePath": ".vscode/custom-prompts.md"
}
```


## Supported Files

- **HTML** (.html) - Full support
- **PHP** (.php) - Static paths only
- **JavaScript/JSX** (.js, .jsx) - Static paths only
- **TypeScript/TSX** (.ts, .tsx) - Static paths only

### Supported Image Formats

- **Raster images**: JPG, PNG, GIF, WebP, BMP
- **⚠️ SVG not supported**: SVG files must be manually converted to PNG/JPG before processing (Gemini API limitation)

### Supported Image Paths

**✅ Supported:**
```html
<!-- Relative paths (from current file location) -->
<img src="./images/photo.jpg">
<img src="images/banner.png">

<!-- Root paths (from workspace root or framework's public directory) -->
<img src="/static/hero.jpg">

<!-- Absolute URLs -->
<img src="https://example.com/image.jpg">
<img src="http://example.com/photo.png">

<!-- JSX/TSX with static paths -->
<Image src="/static/hero.jpg" width={500} height={300} />
```

**❌ Not Supported (Dynamic values):**
```jsx
<Image src={imageUrl} />
<Image src={`/uploads/${id}.jpg`} />
<img src="<?php echo $url; ?>">
```

### 🚀 Framework-Specific Path Resolution

The extension automatically detects modern React frameworks and resolves root paths (`/`) to their `public` directory:

**Supported Frameworks:**
- **Next.js** - `/image.png` → `public/image.png`
- **Create React App** - `/image.png` → `public/image.png`
- **Vite** - `/image.png` → `public/image.png`
- **Astro** - `/image.png` → `public/image.png`
- **Remix** - `/image.png` → `public/image.png`

**⚠️ Important:** For framework projects, **always use root paths (starting with `/`)** for public directory files:

```tsx
// ✅ Correct - Root path (framework automatically detects)
<Image src="/logo.png" alt="" />  // Resolves to: public/logo.png

// ❌ Wrong - Relative path (looks in src directory)
<Image src="logo.png" alt="" />   // Error: Image not found
```

## Usage

### Generate ALT for Images

**Single Image:**
1. Place cursor anywhere in an `<img>` or `<Image>` tag
2. Press `Cmd+Alt+A` (Windows: `Ctrl+Alt+A`)

**Multiple Images (Batch Processing):**
1. Select a range of text containing multiple `<img>` or `<Image>` tags
2. Press `Cmd+Alt+A` (Windows: `Ctrl+Alt+A`)
3. All images in the selection will be processed automatically

**Via Command Palette:**
1. Place cursor in a tag or select multiple tags
2. Press `Cmd+Shift+P` (Windows: `Ctrl+Shift+P`)
3. Select "Generate ALT attribute for img tags"

### Generate aria-label for Videos

**Single Video:**
1. Place cursor anywhere in a `<video>` tag
2. Press `Cmd+Alt+V` (Windows: `Ctrl+Alt+V`)

**Multiple Videos (Batch Processing):**
1. Select a range of text containing multiple `<video>` tags
2. Press `Cmd+Alt+V` (Windows: `Ctrl+Alt+V`)
3. All videos in the selection will be processed automatically

**Via Command Palette:**
1. Place cursor in a tag or select multiple tags
2. Press `Cmd+Shift+P` (Windows: `Ctrl+Shift+P`)
3. Select "Generate aria-label attribute for video tags"

### Insertion Modes

The extension supports two insertion modes for both **images (ALT)** and **videos (aria-label/transcript text)**:

**Manual Mode (Default):**
- Generated text is shown in a preview dialog before insertion
- You can review and edit the text before applying
- Allows you to accept, modify, or reject each suggestion
- Recommended for quality control and batch processing

**Auto Mode:**
- Generated text is inserted immediately into your code
- Best for quick workflows and when you trust the AI output
- No additional confirmation required

**To change the insertion mode:**
1. Press `Cmd+,` (Windows: `Ctrl+,`) to open Settings
2. Search for "Auto ALT Writer: Insertion Mode"
3. Choose "Auto" or "Manual"

### Video Description Modes

**Summary Mode (Default):**
- Generates a short aria-label (max 10 words) describing the video's purpose or function
- Inserted as `aria-label` attribute on the `<video>` tag
- Follows accessibility best practices

**Transcript Mode:**
- Generates comprehensive transcript with accurate transcription of all dialogue and narration, plus important visual information
- Inserted as an HTML comment near the video tag (not as aria-label)
- Comment format automatically adapts to file type:
  - HTML: `<!-- Video description: ... -->`
  - JSX/TSX: `{/* Video description: ... */}`
  - PHP: `<?php /* Video description: ... */ ?>`
- Useful for creating text manuscripts for audio descriptions

## Decorative Images

Images with these keywords in filename are automatically assigned `alt=""`:
- `icon-`
- `bg-`
- `deco-`

Customize keywords in settings to match your project's naming conventions.

## Troubleshooting

### "Image not found" Error
- **For framework projects (Next.js, Vite, etc.):** Use root paths starting with `/` for public directory files
  - ✅ Correct: `<Image src="/logo.png" />`
  - ❌ Wrong: `<Image src="logo.png" />`
- Verify image path is correct
- Check that workspace folder is opened in VSCode
- Ensure the correct project folder (not parent directory) is opened

### "429 Too Many Requests" Error
- Wait 1 minute before retrying
- Process fewer images at once
- Add decorative keywords to skip unnecessary images
- The shared free tier is rate-limited across all users — **set your own API key** (see Quick Start) to use your own quota

### Dynamic src Attributes Error
- Only static string paths are supported
- Variables, template literals, and function calls are not supported
- Use static paths like `"/images/photo.jpg"` instead

### "Content Blocked" Error
- Gemini API may block certain images due to safety filters
- This typically occurs with adult content, violence, or other sensitive material
- The API's safety policies cannot be overridden
- If an image is blocked, you'll need to manually write the alt text or use a different image

### Slow Performance with Large Files
- **Disable Context**: Turn off "Context Analysis Enabled" in settings for faster processing
- **Process in Smaller Batches**: Select fewer tags at once
- **Check File Size**: Large HTML files (>500KB) may slow down parsing

### Memory Issues
- The extension automatically processes batches in chunks of 10 items
- If you still experience issues, try processing fewer items at once
- Close other resource-intensive applications

## API Limits

The extension automatically manages API rate limits. For details about Gemini API limits and pricing, see the [official documentation](https://ai.google.dev/gemini-api/docs/quota).

## Performance & Best Practices

### Batch Processing
- **Chunk Size**: Large batches are automatically processed in chunks of 10 items
- **Memory Management**: Cache is cleared after each chunk to prevent memory buildup
- **Context Optimization**: Nearby tags (within 10 lines) share context extraction, reducing redundant analysis
- **Smart Prompts Loading**: Custom prompts are loaded once per operation instead of multiple times, reducing file I/O by 75-85%

### Context-Aware Generation
When **Context Analysis Enabled** is turned on in settings, the extension analyzes surrounding HTML elements to generate more accurate descriptions:
- Considers text in parent elements (div, section, article, etc.)
- Analyzes sibling elements before and after the image
- Intelligently detects redundant descriptions (returns `alt=""` when context already describes the image)

**Note:** Context analysis can also be enabled through custom prompts by including either `{context}` or `{surroundingText}` placeholder.

### Recommended Settings
- **For best accuracy**: Enable "Context Analysis Enabled"
- **For large batches**: Use "Manual" insertion mode to review before applying

### Custom Prompts (Advanced)

Want to customize how the AI generates descriptions? Create `.vscode/custom-prompts.md` in your workspace.

**Basic Format:**

```markdown
<!-- ==================== MODE: seo ==================== -->
# Your Instructions

Write custom instructions for the AI here...

## Output Format
{languageConstraint}
Output only the alt text.
```

**Available Modes:**
- `seo` - For SEO-optimized descriptions
- `a11y` - For accessibility-focused descriptions
- `video` - For short video aria-labels
- `transcript` - For detailed video transcripts
- `context` - For context analysis rules
- `model` - To select AI model (`gemini-2.5-flash` or `gemini-2.5-pro`)

**Optional Placeholders:**
- `{context}` - Includes surrounding text analysis (auto-enables context mode)
- `{surroundingText}` - Raw surrounding HTML/JSX text
- `{languageConstraint}` - Adds language constraint (e.g., "Respond only in Japanese")

**Tip:** Each MODE section is optional. The extension uses built-in defaults for any missing sections.

## Notes

- Internet connection required
- Video files: Recommended 10MB or less (max 20MB)
- Processing time depends on number of images and API model
- Free tier has usage limits - see Gemini API documentation
- By default, requests go through a shared proxy service (no personal API key required). When you set your own key, requests and image/video data go **directly to Google's Gemini API**, and your key is stored only in your OS keychain — never sent through the proxy

## License

MIT
