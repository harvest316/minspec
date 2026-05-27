import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Extension activation integration tests.
 *
 * Verifies the MinSpec extension activates correctly and registers
 * all expected commands and tree views in the VS Code extension host.
 */
suite('Extension Activation', () => {
  // All command IDs declared in package.json contributes.commands
  const EXPECTED_COMMANDS = [
    'minspec.init',
    'minspec.initRefresh',
    'minspec.classify',
    'minspec.status',
    'minspec.refreshTree',
    'minspec.declareScope',
    'minspec.park',
    'minspec.injectContext',
    'minspec.removeContext',
    'minspec.showSpecPanel',
    'minspec.generateExample',
    'minspec.createAdr',
    'minspec.scoreWsjf',
    'minspec.triageIssue',
    'minspec.refreshBacklog',
    'minspec.goToSpec',
    'minspec.goToCode',
    'minspec.linkToSpec',
  ];

  // Tree view IDs declared in package.json contributes.views
  const EXPECTED_VIEW_IDS = [
    'minspecStatus',
    'minspecAdrs',
    'minspecBacklog',
  ];

  let registeredCommands: string[];

  suiteSetup(async () => {
    // Ensure the extension is activated by executing one of its commands.
    // The extension uses onStartupFinished or explicit activation events,
    // so we trigger activation by executing a lightweight command.
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext, 'Extension aiclarity.minspec should be installed');

    if (!ext.isActive) {
      await ext.activate();
    }

    // Fetch all registered commands once for the suite
    registeredCommands = await vscode.commands.getCommands(true);
  });

  test('Extension is active', () => {
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext, 'Extension should be found');
    assert.strictEqual(ext.isActive, true, 'Extension should be active');
  });

  for (const commandId of EXPECTED_COMMANDS) {
    test(`Command registered: ${commandId}`, () => {
      assert.ok(
        registeredCommands.includes(commandId),
        `Command "${commandId}" should be registered`,
      );
    });
  }

  // Verify tree view registration by checking if the view-related commands exist.
  // VS Code registers internal commands like "workbench.view.extension.<id>" when
  // tree views are contributed. We verify by checking the view exists in the
  // contributes metadata, since the extension host doesn't expose a direct
  // "list views" API.
  test('Extension contributes expected tree views', () => {
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext, 'Extension should be found');

    const contributes = ext.packageJSON?.contributes;
    assert.ok(contributes, 'Extension should have contributes');
    assert.ok(contributes.views, 'Extension should contribute views');

    const explorerViews: { id: string }[] = contributes.views.explorer ?? [];
    const viewIds = explorerViews.map((v: { id: string }) => v.id);

    for (const expectedId of EXPECTED_VIEW_IDS) {
      assert.ok(
        viewIds.includes(expectedId),
        `Tree view "${expectedId}" should be contributed`,
      );
    }
  });
});
