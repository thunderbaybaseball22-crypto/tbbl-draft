// Regenerates docs/DEMO-RESULTS.md by running the demo scenario on the sample files.
//   node tools/make-demo-results.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { runScenario } from '../public/js/lib/scenario.js';

const read = (f) => readFileSync(new URL('../public/sample/' + f, import.meta.url), 'utf8');
const r = runScenario({ scheduleCsv: read('SAMPLE-DraftOrder.csv'), playersCsv: read('SAMPLE-players.csv'), ownersCsv: read('SAMPLE-owners.csv') });
const md = `# Demo results

Produced by \`node tools/make-demo-results.mjs\` (the same script is asserted by \`tests/demo-scenario.test.js\`).
Data: the fake files in \`public/sample/\`. The clock is simulated; Monday 7 June 2027 starts at 11:00 AM Eastern.
The same walkthrough runs in a browser at \`demo.html\` (open it through the deployed site).

## Step log

\`\`\`
${r.log.join('\n')}
\`\`\`

## Audit log

\`\`\`
${r.audit.map((a) => JSON.stringify(a)).join('\n')}
\`\`\`
`;
writeFileSync(new URL('../docs/DEMO-RESULTS.md', import.meta.url), md);
console.log('wrote docs/DEMO-RESULTS.md');
