import fs from 'node:fs';
import path from 'node:path';
import { createTelegramBot } from './bot/telegram.bot.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { OrderScheduler } from './scheduler/order.scheduler.js';

const PID_FILE = path.resolve(process.cwd(), '.bot.pid');

function ensureSingleInstance(): void {
  if (fs.existsSync(PID_FILE)) {
    try {
      const oldPid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
      if (oldPid && oldPid !== process.pid) {
        logger.info({ oldPid }, 'Terminating previous bot instance...');
        process.kill(oldPid, 'SIGKILL');
      }
    } catch {
      // Process already exited
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

async function main(): Promise<void> {
  ensureSingleInstance();

  logger.info(
    {
      pid: process.pid,
      brainxhrUrl: config.brainxhrUrl,
      timezone: config.timezone,
      defaultLocation: config.defaults.location,
      defaultOrderFor: config.defaults.orderFor,
      defaultFoodType: config.defaults.foodType,
    },
    'Starting Baker Street — BrainxHR Cafe Food Order Automator'
  );

  const bot = createTelegramBot();
  const scheduler = new OrderScheduler(bot);

  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});

  await bot.api.setMyCommands([
    { command: 'start', description: 'Open the main Cafe Order menu' },
    { command: 'quickorder', description: '1-tap order with your saved defaults' },
    { command: 'order', description: 'Place a custom food order' },
    { command: 'delete', description: 'View and delete your placed food order' },
    { command: 'defaults', description: 'Configure your default Location, Order For & Food Type' },
    { command: 'schedule', description: 'Configure automatic daily scheduled ordering' },
    { command: 'status', description: 'Get a live screenshot of the BrainxHR Cafe Order page' },
    { command: 'login', description: 'Link or update your BrainxHR credentials' },
    { command: 'logout', description: 'Remove your saved BrainxHR credentials' },
  ]);

  scheduler.start();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down gracefully...');
    scheduler.stop();
    bot.stop();
    try {
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await bot.start({
    onStart: (botInfo) => {
      logger.info(
        { botUsername: `@${botInfo.username}`, id: botInfo.id, pid: process.pid },
        'Telegram Bot is online and listening for commands!'
      );
    },
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
