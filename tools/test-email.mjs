// Sends ONE test email to check the Gmail app-password setup. Separate from the real pick batches:
// it touches nothing in Firestore and does not need the service-account key.
// Usage: tools\test-email.cmd            -> sends to the league group (TBBL@groups.io)
//        tools\test-email.cmd you@x.com  -> sends only to that address (try this first)
import { loadMailConfig, createTransport } from './mail-config.mjs';

try {
  const cfg = loadMailConfig();
  const to = process.argv[2] || cfg.to;
  const transport = await createTransport(cfg);
  await transport.sendMail({
    from: cfg.from, to, subject: 'TBBL Draft: TEST email (ignore)',
    text: 'This is a test of the TBBL draft group email setup. No picks are in this message. You can ignore it.\n',
  });
  console.log(`Test email sent from ${cfg.from} to ${to}. If it is for the group, check that it arrived and was not held for moderation (docs/TICKER.md).`);
} catch (e) {
  console.error('Test email FAILED: ' + String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300));
  process.exit(1);
}
