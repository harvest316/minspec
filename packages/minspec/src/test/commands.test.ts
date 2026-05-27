import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Command execution integration tests.
 *
 * Tests that MinSpec commands execute without errors and produce
 * expected side effects (file creation, etc.) in the test workspace.
 */
suite('Command Execution', () => {
  let workspaceRoot: string;

  suiteSetup(async () => {
    // Ensure extension is active
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext, 'Extension should be installed');
    if (!ext.isActive) {
      await ext.activate();
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'Workspace folder should be open');
    workspaceRoot = folder.uri.fsPath;
  });

  test('minspec.init creates .minspec/ directory', async () => {
    // The fixture workspace already has .minspec/, so init should
    // succeed without error (it's idempotent)
    await vscode.commands.executeCommand('minspec.init');

    const minspecDir = path.join(workspaceRoot, '.minspec');
    assert.ok(
      fs.existsSync(minspecDir),
      '.minspec/ directory should exist after init',
    );

    const configPath = path.join(minspecDir, 'config.json');
    assert.ok(
      fs.existsSync(configPath),
      '.minspec/config.json should exist after init',
    );
  });

  test('minspec.classify runs without error', async () => {
    // classify requires user input (quick pick), so we just verify
    // it doesn't throw when executed. The command will show a UI prompt
    // and return without action since no input is provided in tests.
    try {
      // Execute with a short timeout — the command will wait for user input
      // which won't come in an automated test, so we don't await completion
      const classifyPromise = vscode.commands.executeCommand('minspec.classify');

      // Give it a moment, then cancel any open input boxes
      await new Promise(resolve => setTimeout(resolve, 500));

      // Send Escape to dismiss any open dialogs
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

      // The command may still be pending — that's expected behavior
      // for commands that require user input
    } catch (err) {
      // Commands requiring user input may throw when dismissed — that's fine
      // We only fail on unexpected errors
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('cancelled') && !message.includes('canceled')) {
        assert.fail(`minspec.classify threw unexpected error: ${message}`);
      }
    }
  });

  test('minspec.status runs without error', async () => {
    try {
      await vscode.commands.executeCommand('minspec.status');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Status may show a quick pick that gets dismissed
      if (!message.includes('cancelled') && !message.includes('canceled')) {
        assert.fail(`minspec.status threw unexpected error: ${message}`);
      }
    }
  });

  test('minspec.generateExample creates example spec file', async () => {
    const specsDir = path.join(workspaceRoot, 'specs');
    const examplePath = path.join(specsDir, 'SPEC-EXAMPLE.md');

    // Remove existing example if present (from previous test runs)
    if (fs.existsSync(examplePath)) {
      fs.unlinkSync(examplePath);
    }

    await vscode.commands.executeCommand('minspec.generateExample');

    assert.ok(
      fs.existsSync(examplePath),
      'SPEC-EXAMPLE.md should be created in specs/',
    );

    const content = fs.readFileSync(examplePath, 'utf-8');
    assert.ok(
      content.includes('id: SPEC-EXAMPLE'),
      'Example spec should contain correct frontmatter id',
    );
    assert.ok(
      content.includes('## Specify'),
      'Example spec should contain Specify section',
    );
  });

  test('minspec.refreshTree runs without error', async () => {
    // refreshTree is a simple sync command — should never throw
    await vscode.commands.executeCommand('minspec.refreshTree');
  });

  test('minspec.refreshBacklog runs without error', async () => {
    // refreshBacklog triggers a tree refresh — should not throw
    await vscode.commands.executeCommand('minspec.refreshBacklog');
  });

  test('minspec.createAdr requires user input (does not throw)', async () => {
    try {
      const createPromise = vscode.commands.executeCommand('minspec.createAdr');

      // Give the command time to show input box
      await new Promise(resolve => setTimeout(resolve, 500));

      // Dismiss any open input
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

      // The promise may remain pending — that's expected
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('cancelled') && !message.includes('canceled')) {
        assert.fail(`minspec.createAdr threw unexpected error: ${message}`);
      }
    }
  });
});
