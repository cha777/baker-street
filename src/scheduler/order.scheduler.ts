import fs from 'node:fs';
import { type Bot, InlineKeyboard, InputFile } from 'grammy';
import cron from 'node-cron';
import { brainxhrService } from '../automation/brainxhr.service.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { userStore } from '../store/user.store.js';

const DAY_INDEX_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getNowInTimezone(tz: string): {
  dateStr: string;
  timeStr: string;
  dayOfWeek: number;
} {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const weekday = get('weekday');
  // Handle "24" hour edge case in some Intl implementations
  const rawHour = get('hour');
  const hour = rawHour === '24' ? '00' : rawHour;
  const minute = get('minute');

  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${hour}:${minute}`,
    dayOfWeek: DAY_INDEX_MAP[weekday] ?? now.getDay(),
  };
}

export class OrderScheduler {
  private task: cron.ScheduledTask | null = null;
  private readonly bot: Bot;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  public start(): void {
    if (this.task) return;

    logger.info({ timezone: config.timezone }, 'Starting scheduled order engine (checks every minute)');
    this.task = cron.schedule(
      '* * * * *',
      async () => {
        await this.tick();
      },
      {
        timezone: config.timezone,
      }
    );
  }

  public stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
  }

  private async tick(): Promise<void> {
    const { dateStr, timeStr, dayOfWeek } = getNowInTimezone(config.timezone);
    const users = userStore.getAllUsers();

    for (const user of users) {
      const sched = user.schedule;
      if (!sched?.enabled) continue;
      if (!sched.daysOfWeek.includes(dayOfWeek)) continue;
      if (sched.time !== timeStr) continue;
      if (sched.lastRunDate === dateStr) continue;

      const credentials = userStore.getCredentials(user.telegramId);
      if (!credentials) continue;

      // Mark lastRunDate immediately so we don't trigger twice
      userStore.updateSchedule(user.telegramId, { lastRunDate: dateStr });

      logger.info(
        {
          telegramId: user.telegramId,
          brainxhrUsername: user.brainxhrUsername,
          defaults: user.defaults,
          timeStr,
        },
        'Triggering scheduled automatic food order'
      );

      // Run asynchronously per user so multiple users scheduled at the same minute don't block the loop
      void this.executeScheduledOrderForUser(user.telegramId, credentials, user.defaults);
    }
  }

  private async executeScheduledOrderForUser(
    telegramId: number,
    credentials: { username: string; password: string },
    defaults: { location: string; orderFor: string; foodType: string }
  ): Promise<void> {
    try {
      await this.bot.api.sendMessage(
        telegramId,
        [
          '⏰ *Running Scheduled Food Order...*',
          `📍 *Location:* ${defaults.location}`,
          `👤 *Order For:* ${defaults.orderFor}`,
          `🍱 *Food Type:* ${defaults.foodType}`,
        ].join('\n'),
        { parse_mode: 'Markdown' }
      );

      const result = await brainxhrService.placeOrder(telegramId, credentials, defaults);

      const actionKeyboard = new InlineKeyboard()
        .text('🗑️ Delete This Order', 'del_order:0')
        .row()
        .text('🏠 Main Menu', 'menu:main');

      if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
        await this.bot.api.sendPhoto(telegramId, new InputFile(result.screenshotPath), {
          caption: `⏰ *Scheduled Auto-Order Result*\n\n${result.message}`,
          parse_mode: 'Markdown',
          reply_markup: actionKeyboard,
        });
      } else {
        await this.bot.api.sendMessage(
          telegramId,
          `⏰ *Scheduled Auto-Order Result*\n\n${result.message}`,
          {
            parse_mode: 'Markdown',
            reply_markup: actionKeyboard,
          }
        );
      }
    } catch (err) {
      logger.error({ err, telegramId }, 'Failed to execute scheduled order for user');
    }
  }
}
