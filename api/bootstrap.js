/**
 * Process bootstrap / local crash guard.
 */

process.on('uncaughtException', (err) => {
    console.error('[Bootstrap] uncaughtException:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('[Bootstrap] unhandledRejection:', reason);
    process.exit(1);
});

try {
    await import('./server.js');
} catch (err) {
    console.error('[Bootstrap] Server failed to start:', err);
    process.exit(1);
}
