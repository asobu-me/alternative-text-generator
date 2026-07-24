/**
 * Framework detection service
 * Detects modern web frameworks and returns their static file directory
 */

import * as fs from 'fs';
import * as path from 'path';

// Memoize detection per workspace path: package.json does not change mid-batch,
// so this avoids re-reading and re-parsing it for every absolute-path image/video.
const staticDirCache = new Map<string, string | null>();

/**
 * Detect static file directory based on framework
 * Returns 'public' for supported frameworks, or null if not detected
 * Result is cached per workspace path for the session.
 */
export function detectStaticFileDirectory(workspacePath: string): string | null {
    const cached = staticDirCache.get(workspacePath);
    if (cached !== undefined) {
        return cached;
    }
    const result = computeStaticFileDirectory(workspacePath);
    staticDirCache.set(workspacePath, result);
    return result;
}

/**
 * Read package.json and determine the framework's static file directory
 */
function computeStaticFileDirectory(workspacePath: string): string | null {
    try {
        const packageJsonPath = path.join(workspacePath, 'package.json');

        if (!fs.existsSync(packageJsonPath)) {
            return null;
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

        // Next.js - publicディレクトリ
        if (dependencies['next']) {
            return 'public';
        }

        // Astro - publicディレクトリ
        if (dependencies['astro']) {
            return 'public';
        }

        // Remix - publicディレクトリ
        if (dependencies['@remix-run/react'] || dependencies['remix']) {
            return 'public';
        }

        // Vite (一般的にはpublicディレクトリ)
        if (dependencies['vite']) {
            return 'public';
        }

        // Create React App - publicディレクトリ
        if (dependencies['react-scripts']) {
            return 'public';
        }

        return null;
    } catch (error) {
        console.error('Failed to detect framework:', error);
        return null;
    }
}
