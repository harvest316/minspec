/**
 * Print the resolved autonomy state and its stop list, for the session banner.
 *
 * WHY THIS EXISTS. DR-086's stop list is only load-bearing if the agent actually
 * has it in mind at the moment it is about to act. Left as prose in a DR, it is
 * recalled — and a rule recalled is a rule that drifts (constitution: "enforce,
 * don't trust the model"). Printing it every session, DERIVED FROM THE RESOLVER
 * rather than restated, makes it arrive deterministically and makes it
 * impossible for the banner to disagree with the code.
 *
 * WHAT THIS IS NOT. It is surfacing, not enforcement. Nothing here can stop an
 * agent that decides to act anyway; there is no gate around a conversational
 * choice. Enforcement exists only where a consumer calls `mayProceed()` before
 * doing something. This closes the "I remembered it" gap, not the "it is
 * impossible to violate" gap — and the difference is worth being honest about,
 * because a banner that felt like a gate would be a false signpost.
 */
import * as path from 'path';
import { readAutonomy, STOP_CLASSES } from './lib/autonomy';

const repoRoot = process.argv[2] ?? path.resolve(__dirname, '..');
const autonomy = readAutonomy(repoRoot);
const ids = STOP_CLASSES.map((s) => s.id).join(' · ');

if (autonomy === 'act') {
  console.log(`⚙️  Autonomy: act — proceed on your own recommendation without asking, EXCEPT:`);
  console.log(`    ${ids}`);
  console.log(`    Record the alternatives you rejected in the durable artifact (DR-086 §4) —`);
  console.log(`    under 'act' nobody sees them live, so that record is the only review path.`);
} else {
  console.log(`⚙️  Autonomy: ask (default) — put analysed choices to the human before acting.`);
  console.log(`    Always-stop classes (these hold under 'act' too): ${ids}`);
}
