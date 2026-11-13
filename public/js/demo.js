import { runScenario } from './lib/scenario.js';

const get = (f) => fetch('sample/' + f).then((r) => { if (!r.ok) throw new Error(`Could not load sample/${f}`); return r.text(); });

document.getElementById('run').addEventListener('click', async () => {
  const log = document.getElementById('log'), audit = document.getElementById('audit');
  try {
    const [scheduleCsv, playersCsv, ownersCsv] = await Promise.all([get('SAMPLE-DraftOrder.csv'), get('SAMPLE-players.csv'), get('SAMPLE-owners.csv')]);
    const r = runScenario({ scheduleCsv, playersCsv, ownersCsv });
    log.textContent = r.log.join('\n');
    audit.textContent = r.audit.map((a) => JSON.stringify(a)).join('\n');
  } catch (e) {
    log.textContent = 'Error: ' + e.message;
  }
});
