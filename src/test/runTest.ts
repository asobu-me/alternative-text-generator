import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Entry point for the integration test runner.
 * Downloads (if needed) and launches a VS Code instance with this extension
 * loaded, then runs the Mocha suite inside the extension host.
 */
async function main(): Promise<void> {
    try {
        // The folder containing the extension manifest (package.json)
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        // The compiled test suite entry (out/test/suite/index.js)
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        await runTests({ extensionDevelopmentPath, extensionTestsPath });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
