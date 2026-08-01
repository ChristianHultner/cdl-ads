// scripts/notify.mjs
// Watchdog alert transport — bite 2.
//
// sendAlert(text) → boolean (true = delivered, false = failed)
//   Never throws; notification failure must never kill the watchdog.
//
// Transport: openclaw message send --channel whatsapp
// Target:    resolved at runtime via 'openclaw directory self --channel whatsapp --json'
//            → reads from gateway config; number is NOT hardcoded in this repo.
//
// Usage as module:  import { sendAlert } from './notify.mjs';
// Self-test:        node scripts/notify.mjs --test

import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// resolveTarget — call gateway to discover the configured WhatsApp self-id.
// Throws on failure so sendAlert can catch + log.
// ---------------------------------------------------------------------------
function resolveTarget() {
  const raw = execSync('openclaw directory self --channel whatsapp --json', {
    encoding: 'utf8',
    timeout:  10_000,
  });
  const parsed = JSON.parse(raw.trim());
  const id = parsed?.id;
  if (!id || typeof id !== 'string') {
    throw new Error(`unexpected directory self response: ${raw.slice(0, 200)}`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// sendAlert(text) — main export
// ---------------------------------------------------------------------------
export async function sendAlert(text) {
  try {
    const target = resolveTarget();

    execSync(
      `openclaw message send --channel whatsapp --target ${JSON.stringify(target)} --message ${JSON.stringify(text)}`,
      {
        encoding: 'utf8',
        timeout:  20_000,
        stdio:    ['ignore', 'pipe', 'pipe'],
      },
    );

    console.error(`[notify] sent to ${target}: ${text}`);
    return true;
  } catch (err) {
    console.error(`[notify] FAILED to send alert — ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Self-test — node scripts/notify.mjs --test
// ---------------------------------------------------------------------------
if (process.argv.includes('--test')) {
  console.log('[notify] running self-test…');
  const ok = await sendAlert('cdl-ads watchdog: test ping');
  if (ok) {
    console.log('[notify] self-test: message delivered — check WhatsApp');
    process.exit(0);
  } else {
    console.error('[notify] self-test: delivery FAILED (see stderr above)');
    process.exit(1);
  }
}
