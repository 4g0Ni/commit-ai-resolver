/**
 * Standalone scheduled commit refresh.
 *
 * Usage:
 *   node scripts/scheduled-refresh.js              — Run once
 *   node scripts/scheduled-refresh.js --loop 60    — Run every 60 minutes
 */

import { refreshAllCommits, startScheduledRefresh } from '../src/services/scheduled-refresh.js';

const args = process.argv.slice(2);
const loopIdx = args.indexOf('--loop');

if (loopIdx !== -1) {
    const minutes = parseInt(args[loopIdx + 1], 10) || 60;
    // Start immediately (no 10s delay) then loop
    await refreshAllCommits();
    console.log(`Looping every ${minutes} minutes. Press Ctrl+C to stop.`);
    setInterval(refreshAllCommits, minutes * 60 * 1000);
} else {
    await refreshAllCommits();
}
