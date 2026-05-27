import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

/**
 * CodeLens integration tests.
 *
 * Tests that the MinSpec CodeLens providers return lenses for source files
 * (mapped via traceability.json) and for spec files.
 */
suite('CodeLens Providers', () => {
  let workspaceRoot: string;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext, 'Extension should be installed');
    if (!ext.isActive) {
      await ext.activate();
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'Workspace folder should be open');
    workspaceRoot = folder.uri.fsPath;
  });

  test('Source file CodeLens: returns lenses for mapped file', async () => {
    // Open the example.ts file that is mapped in traceability.json
    const filePath = path.join(workspaceRoot, 'src', 'example.ts');
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    // Give CodeLens providers time to compute
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Request CodeLenses from VS Code
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      doc.uri,
    );

    // The traceability.json maps src/example.ts:5-10 to SPEC-001/user-login
    // so we should get at least one lens
    assert.ok(lenses, 'CodeLens provider should return results');
    assert.ok(lenses.length > 0, 'Should have at least one CodeLens for mapped source file');

    // Verify at least one lens references SPEC-001
    const specLens = lenses.find(
      (l) => l.command?.title?.includes('SPEC-001'),
    );
    assert.ok(
      specLens,
      'Should have a CodeLens referencing SPEC-001',
    );
  });

  test('Spec file CodeLens: returns lenses for spec with traced requirements', async () => {
    // Open the SPEC-001 file which has requirements mapped in traceability.json
    const filePath = path.join(workspaceRoot, 'specs', 'SPEC-001-user-auth.md');
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    // Give CodeLens providers time to compute
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Request CodeLenses
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      doc.uri,
    );

    // The spec file has the requirement key "user-login" which has a code mapping
    // The SpecFileLensProvider should show a "code locations" lens
    assert.ok(lenses, 'CodeLens provider should return results for spec file');
    assert.ok(
      lenses.length > 0,
      'Should have at least one CodeLens for spec file with traced requirements',
    );

    // Verify a lens shows code location count
    const codeLens = lenses.find(
      (l) => l.command?.title?.includes('code location'),
    );
    assert.ok(
      codeLens,
      'Should have a CodeLens showing code location count',
    );
  });

  test('Spec file without traceability: no code location lenses', async () => {
    // Open SPEC-002 which has no traceability mappings
    const filePath = path.join(workspaceRoot, 'specs', 'SPEC-002-dashboard.md');
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    await new Promise(resolve => setTimeout(resolve, 1500));

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      doc.uri,
    );

    // SPEC-002 has no traceability entries, so no "code location" lenses
    const codeLocationLenses = (lenses ?? []).filter(
      (l) => l.command?.title?.includes('code location'),
    );
    assert.strictEqual(
      codeLocationLenses.length,
      0,
      'SPEC-002 should have no code location lenses (no traceability mappings)',
    );
  });

  test('CodeLens disabled via setting returns no lenses', async () => {
    // Disable CodeLens via configuration
    const config = vscode.workspace.getConfiguration('minspec');
    await config.update('codelens.enabled', false, vscode.ConfigurationTarget.Workspace);

    try {
      const filePath = path.join(workspaceRoot, 'src', 'example.ts');
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);

      await new Promise(resolve => setTimeout(resolve, 1500));

      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        doc.uri,
      );

      // With CodeLens disabled, our provider should return empty arrays.
      // Note: other extensions may still contribute lenses to this file.
      // We check that no SPEC-related lenses exist.
      const specLenses = (lenses ?? []).filter(
        (l) => l.command?.title?.includes('SPEC-'),
      );
      assert.strictEqual(
        specLenses.length,
        0,
        'No SPEC lenses should appear when codelens.enabled is false',
      );
    } finally {
      // Re-enable CodeLens for other tests
      await config.update('codelens.enabled', true, vscode.ConfigurationTarget.Workspace);
    }
  });
});
