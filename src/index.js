/**
 * src/index.js
 * Boot: env → db → migrate → gateway + scheduler
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { connect, setMessageHandler, fetchGroups } from './gateway/socket.js';
import { processIncoming } from './gateway/ingress.js';
import { route, setOwnerChatJid } from './router/router.js';
import { startScheduler } from './scheduler/tick.js';
import { upsertGroup } from './db/repos/groups.js';
import { addOwnerJid } from './db/repos/people.js';

const log = logger.child({ module: 'index' });

async function boot() {
  log.info('🚀 Not Your Type (Chintu) starting...');

  // Run database migrations
  try {
    await runMigrations();
    log.info('✅ Database ready');
  } catch (err) {
    log.error({ err }, '❌ Migration failed');
    process.exit(1);
  }

  // Auto-seed owner JID from OWNER_NUMBER so !claim is never needed
  try {
    const ownerJid = `${config.OWNER_NUMBER}@s.whatsapp.net`;
    await addOwnerJid(ownerJid);
    // The owner may not send a message after a restart. Keep a usable
    // destination in memory so first-contact DM approval cards are not lost.
    setOwnerChatJid(ownerJid);
    log.info({ ownerJid }, '✅ Owner JID auto-seeded');
  } catch (err) {
    log.warn({ err }, 'Owner JID seed failed (non-fatal)');
  }

  // Set up message handler
  setMessageHandler(async (rawMsg, sock) => {
    await processIncoming(rawMsg, sock, route);
  });

  // Connect to WhatsApp
  await connect({
    onConnect: async (sock) => {
      log.info('✅ WhatsApp connected');

      // Discover groups
      setTimeout(async () => {
        try {
          const groups = await fetchGroups();
          if (groups) {
            for (const g of groups) {
              await upsertGroup({
                jid: g.id,
                subject: g.subject || g.id,
                member_count: g.participants?.length || 0,
                last_activity_at: new Date(),
              });
            }
            log.info({ count: groups.length }, 'Groups discovered');
          }
        } catch (err) {
          log.warn({ err }, 'Group discovery failed');
        }
      }, 5000);
    },
    onDisconnect: (reason) => {
      if (reason !== 'loggedOut') {
        log.warn({ reason }, 'WhatsApp disconnected, reconnecting...');
      }
    },
  });

  // Start scheduler
  startScheduler();

  log.info('✅ Chintu is live 🎉');
}

// Global error handlers
process.on('uncaughtException', (err) => {
  log.error({ err }, 'Uncaught exception');
});
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled rejection');
});

boot().catch((err) => {
  logger.error({ err }, 'Boot failed');
  process.exit(1);
});
