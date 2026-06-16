import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

/**
 * Recursively collect compiled test files (*.test.js) under a directory.
 */
function findTestFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findTestFiles(full));
        } else if (entry.name.endsWith('.test.js')) {
            results.push(full);
        }
    }
    return results;
}

/**
 * Called by @vscode/test-electron inside the extension host.
 */
export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000 });
    const testsRoot = path.resolve(__dirname, '..');

    return new Promise((resolve, reject) => {
        try {
            for (const file of findTestFiles(testsRoot)) {
                mocha.addFile(file);
            }

            mocha.run((failures) => {
                if (failures > 0) {
                    reject(new Error(`${failures} test(s) failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}
