/**
 * Context grouping utility for batch processing optimization
 * Groups nearby media tags to share surrounding text extraction
 */

import * as vscode from 'vscode';
import { extractSurroundingText } from './textUtils';

/**
 * Media tag with position information
 */
interface MediaTag {
    type: 'img' | 'video';
    range: vscode.Range;
    text: string;
    startOffset: number;
    endOffset: number;
}

/**
 * Group of nearby media tags that share context
 */
interface ContextGroup {
    groupId: number;
    tags: MediaTag[];
    startOffset: number;
    endOffset: number;
    surroundingText?: string;
}

/**
 * Context cache for batch processing
 */
class ContextCache {
    private groups: Map<number, ContextGroup> = new Map();
    private tagToGroupMap: Map<string, number> = new Map();
    private document: vscode.TextDocument;
    private contextRange: number;

    constructor(document: vscode.TextDocument, contextRange: number) {
        this.document = document;
        this.contextRange = contextRange;
    }

    /**
     * Analyze tags and create groups based on proximity
     * Tags within contextRange distance are grouped together
     */
    public analyzeTags(tags: Array<{type: 'img' | 'video', range: vscode.Range, text: string}>): void {
        // Convert ranges to offsets
        const mediaTags: MediaTag[] = tags.map(tag => ({
            ...tag,
            startOffset: this.document.offsetAt(tag.range.start),
            endOffset: this.document.offsetAt(tag.range.end)
        }));

        // Sort tags by position
        mediaTags.sort((a, b) => a.startOffset - b.startOffset);

        // Group nearby tags
        let currentGroup: ContextGroup | null = null;
        let groupId = 0;

        for (const tag of mediaTags) {
            const tagKey = this.getTagKey(tag.range);

            // If no current group, start new group
            if (!currentGroup) {
                currentGroup = {
                    groupId: groupId++,
                    tags: [tag],
                    startOffset: tag.startOffset,
                    endOffset: tag.endOffset
                };
                this.groups.set(currentGroup.groupId, currentGroup);
                this.tagToGroupMap.set(tagKey, currentGroup.groupId);
                continue;
            }

            // Calculate distance from end of current group to start of this tag
            const distance = tag.startOffset - currentGroup.endOffset;

            // If tag is within contextRange, add to current group
            if (distance <= this.contextRange) {
                currentGroup.tags.push(tag);
                currentGroup.endOffset = Math.max(currentGroup.endOffset, tag.endOffset);
                this.tagToGroupMap.set(tagKey, currentGroup.groupId);
            } else {
                // Start new group
                currentGroup = {
                    groupId: groupId++,
                    tags: [tag],
                    startOffset: tag.startOffset,
                    endOffset: tag.endOffset
                };
                this.groups.set(currentGroup.groupId, currentGroup);
                this.tagToGroupMap.set(tagKey, currentGroup.groupId);
            }
        }
    }

    /**
     * Pre-extract surrounding text for all groups
     * This is the key optimization - extract once per group instead of once per tag
     */
    public async preExtractContext(): Promise<void> {
        for (const group of this.groups.values()) {
            // Use the first tag's range as representative for the group
            const firstTag = group.tags[0];
            const range = new vscode.Range(
                this.document.positionAt(firstTag.startOffset),
                this.document.positionAt(firstTag.endOffset)
            );

            // Extract surrounding text once for the entire group
            group.surroundingText = extractSurroundingText(
                this.document,
                range,
                this.contextRange
            );
        }
    }

    /**
     * Get cached surrounding text for a specific tag
     */
    public getSurroundingText(tagRange: vscode.Range): string | undefined {
        const tagKey = this.getTagKey(tagRange);
        const groupId = this.tagToGroupMap.get(tagKey);

        if (groupId === undefined) {
            return undefined;
        }

        const group = this.groups.get(groupId);
        return group?.surroundingText;
    }

    /**
     * Get statistics about grouping efficiency
     */
    public getStats(): {
        totalTags: number;
        totalGroups: number;
        averageGroupSize: number;
        extractionsSaved: number;
    } {
        const totalTags = this.tagToGroupMap.size;
        const totalGroups = this.groups.size;
        const averageGroupSize = totalGroups === 0 ? 0 : totalTags / totalGroups;
        const extractionsSaved = totalTags - totalGroups;

        return {
            totalTags,
            totalGroups,
            averageGroupSize,
            extractionsSaved
        };
    }

    /**
     * Generate unique key for a tag range
     */
    private getTagKey(range: vscode.Range): string {
        return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
    }

    /**
     * Clear all cached data
     */
    public clear(): void {
        this.groups.clear();
        this.tagToGroupMap.clear();
    }
}

/**
 * Create and initialize context cache for batch processing
 */
export async function createContextCache(
    document: vscode.TextDocument,
    tags: Array<{type: 'img' | 'video', range: vscode.Range, text: string}>,
    contextRange: number,
    contextEnabled: boolean
): Promise<ContextCache | null> {
    if (!contextEnabled || tags.length === 0) {
        return null;
    }

    const cache = new ContextCache(document, contextRange);

    // Analyze and group tags
    cache.analyzeTags(tags);

    // Pre-extract context for all groups
    await cache.preExtractContext();

    // Log statistics for debugging
    const stats = cache.getStats();
    console.log(`[Context Optimization] Grouped ${stats.totalTags} tags into ${stats.totalGroups} groups`);
    console.log(`[Context Optimization] Saved ${stats.extractionsSaved} context extractions (${((stats.extractionsSaved / stats.totalTags) * 100).toFixed(1)}% reduction)`);

    return cache;
}
