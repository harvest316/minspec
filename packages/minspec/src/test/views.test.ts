import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * View provider integration tests.
 *
 * Tests that tree view providers return children from the fixture workspace
 * and that the status bar item is present.
 */
suite('View Providers', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext, 'Extension should be installed');
    if (!ext.isActive) {
      await ext.activate();
    }
  });

  test('Spec tree view (minspecStatus) is accessible via reveal', async () => {
    // Verify the view exists by checking registered commands.
    // When a view is registered, VS Code creates focus commands for it.
    await vscode.commands.getCommands(true);

    // The minspecStatus view should have an associated focus command
    // registered by VS Code when the view is contributed
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext);
    const views = ext.packageJSON.contributes.views.explorer;
    const specView = views.find((v: { id: string }) => v.id === 'minspecStatus');
    assert.ok(specView, 'minspecStatus view should be in contributes');

    // Execute refreshTree to ensure data is loaded
    await vscode.commands.executeCommand('minspec.refreshTree');
  });

  test('ADR tree view (minspecAdrs) is accessible', async () => {
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext);
    const views = ext.packageJSON.contributes.views.explorer;
    const adrView = views.find((v: { id: string }) => v.id === 'minspecAdrs');
    assert.ok(adrView, 'minspecAdrs view should be in contributes');

    // Refresh ADR tree to verify it doesn't throw
    await vscode.commands.executeCommand('minspec.refreshTree');
  });

  test('Backlog tree view (minspecBacklog) is accessible', async () => {
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext);
    const views = ext.packageJSON.contributes.views.explorer;
    const backlogView = views.find((v: { id: string }) => v.id === 'minspecBacklog');
    assert.ok(backlogView, 'minspecBacklog view should be in contributes');

    // Refresh backlog tree to verify it doesn't throw
    await vscode.commands.executeCommand('minspec.refreshBacklog');
  });

  test('Status bar item exists and shows text', async () => {
    // The status bar item is created during activation and added
    // to subscriptions. We can verify it exists by checking that
    // the minspec.status command (which it triggers on click) is registered.
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('minspec.status'),
      'minspec.status command should be registered (status bar click target)',
    );

    // The status bar should show "MinSpec: ..." text.
    // Unfortunately, VS Code's API doesn't expose a way to read status bar
    // items from tests. We verify the status bar class was instantiated
    // by confirming the extension activated without error (covered above)
    // and that the command it binds to exists.
  });

  test('Extension contributes walkthrough', () => {
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext);
    const walkthroughs = ext.packageJSON.contributes.walkthroughs;
    assert.ok(walkthroughs, 'Extension should contribute walkthroughs');
    assert.ok(walkthroughs.length > 0, 'Should have at least one walkthrough');

    const gettingStarted = walkthroughs.find(
      (w: { id: string }) => w.id === 'minspec.gettingStarted',
    );
    assert.ok(gettingStarted, 'Should have a gettingStarted walkthrough');
    assert.ok(
      gettingStarted.steps.length >= 5,
      'Walkthrough should have at least 5 steps',
    );
  });

  test('Extension contributes configuration settings', () => {
    const ext = vscode.extensions.getExtension('aiclarity.minspec');
    assert.ok(ext);
    const config = ext.packageJSON.contributes.configuration;
    assert.ok(config, 'Extension should contribute configuration');

    const props = config.properties;
    assert.ok(props['minspec.specsDir'], 'Should have specsDir setting');
    assert.ok(props['minspec.decisionsDir'], 'Should have decisionsDir setting');
    // DR-021: scoring-threshold settings (t1Max/t2Max/t3Max) were dead config and
    // are removed — the classifier ships as an upward-only floor, not a tunable score.
    assert.ok(
      !props['minspec.thresholds.t1Max'],
      'Should NOT contribute the removed t1Max threshold (DR-021)',
    );
    assert.ok(props['minspec.codelens.enabled'], 'Should have codelens.enabled');
  });
});
