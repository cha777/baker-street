import fs from 'node:fs';
import { Bot, type Context, InlineKeyboard, InputFile } from 'grammy';
import { brainxhrService } from '../automation/brainxhr.service.js';
import {
  getOrderingWindowStatus,
  isScheduleTimeWithinOrderingWindow,
} from '../automation/selectors.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { userStore } from '../store/user.store.js';
import type { OrderRequest } from '../types.js';

interface InteractiveSession {
  step:
    | 'idle'
    | 'awaiting_username'
    | 'awaiting_password'
    | 'awaiting_custom_schedule_time';
  tempUsername?: string;
  draftOrder: OrderRequest;
}

const sessions = new Map<number, InteractiveSession>();

function getSession(telegramId: number): InteractiveSession {
  const existing = sessions.get(telegramId);
  if (existing) return existing;

  const user = userStore.getUser(telegramId);
  const initialDraft: OrderRequest = user?.defaults
    ? { ...user.defaults }
    : { ...config.defaults };

  const created: InteractiveSession = {
    step: 'idle',
    draftOrder: initialDraft,
  };
  sessions.set(telegramId, created);
  return created;
}

/**
 * Runs a slow Playwright task in the background without blocking grammY's update loop,
 * so commands like /start, /login, /menu always respond instantaneously.
 */
function runNonBlocking(taskName: string, fn: () => Promise<void>): void {
  void (async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, taskName }, 'Error in background bot task');
    }
  })();
}

function formatDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const key = sorted.join(',');
  if (key === '1,2,3,4,5') return 'Mon–Fri (Weekdays)';
  if (key === '1,2,3,4,5,6') return 'Mon–Sat';
  if (key === '0,1,2,3,4,5,6') return 'Every Day';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return sorted.map((d) => names[d] ?? d).join(', ');
}

function buildMainMenuKeyboard(isLoggedIn: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!isLoggedIn) {
    kb.text('🔐 Link BrainxHR Account (/login)', 'auth:start_login');
    return kb;
  }

  kb.text('⚡ Quick Order (My Defaults)', 'order:quick')
    .row()
    .text('🍽️ Custom Order', 'order:custom_start')
    .text('🗑️ View / Delete Order', 'order:list_or_delete')
    .row()
    .text('⚙️ My Defaults', 'settings:defaults')
    .text('⏰ Auto-Order Schedule', 'settings:schedule')
    .row()
    .text('📸 Portal Screenshot', 'portal:status')
    .text('🔓 Logout', 'auth:logout');

  return kb;
}

function buildMainMenuText(telegramId: number): string {
  const windowStatus = getOrderingWindowStatus(config.timezone);
  const user = userStore.getUser(telegramId);
  if (!user) {
    return [
      '👋 *Welcome to the BrainxHR Cafe Food Order Bot!*',
      '',
      `🏪 *Counter Status:* ${windowStatus.statusBanner}`,
      '',
      'To get started, tap the button below or send /login to link your BrainxHR credentials. Your password message is automatically deleted from the chat and stored encrypted.',
    ].join('\n');
  }

  const schedStatus = user.schedule.enabled
    ? `🟢 Enabled (${user.schedule.time} • ${formatDays(user.schedule.daysOfWeek)})`
    : '🔴 Disabled';

  return [
    '🍽️ *BrainxHR Baker Street Food Order Automator*',
    '',
    `👤 *Account:* \`${user.brainxhrUsername}\``,
    `🏪 *Counter:* ${windowStatus.statusBanner}`,
    '',
    '*⚙️ Your Default Order Preferences:*',
    `• *Location:* ${user.defaults.location}`,
    `• *Order For:* ${user.defaults.orderFor}`,
    `• *Food Type:* ${user.defaults.foodType}`,
    '',
    `*⏰ Scheduled Auto-Order:* ${schedStatus}`,
    '',
    'Select an action below:',
  ].join('\n');
}

export function createTelegramBot(): Bot {
  if (!config.telegramBotToken || config.telegramBotToken === 'your_bot_token_from_botfather') {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is missing or not configured in .env. Please set a valid BotFather token.'
    );
  }

  const bot = new Bot(config.telegramBotToken, {
    client: {
      timeoutSeconds: 40,
    },
  });

  // Log incoming updates and check optional allowlist
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    logger.info(
      {
        userId,
        username: ctx.from?.username,
        text: ctx.message?.text
          ? ctx.message.text.startsWith('/')
            ? ctx.message.text
            : '<user_input>'
          : undefined,
        callbackData: ctx.callbackQuery?.data,
      },
      'Incoming Telegram update'
    );

    if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
      logger.warn({ userId, username: ctx.from?.username }, 'Unauthorized Telegram user blocked');
      await ctx.reply(
        `⛔ Unauthorized access. Your Telegram User ID (\`${userId}\`) is not in TELEGRAM_ALLOWED_USER_IDS.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    await next();
  });

  async function replyWithResult(
    ctx: Context,
    result: { message: string; screenshotPath?: string },
    keyboard?: InlineKeyboard
  ): Promise<void> {
    const replyMarkup =
      keyboard ?? buildMainMenuKeyboard(Boolean(ctx.from && userStore.getUser(ctx.from.id)));

    if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
      await ctx.replyWithPhoto(new InputFile(result.screenshotPath), {
        caption: result.message,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      });
    } else {
      await ctx.reply(result.message, {
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      });
    }
  }

  // /start and /menu
  bot.command(['start', 'menu'], async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    session.step = 'idle';

    const isLoggedIn = Boolean(userStore.getUser(userId));
    await ctx.reply(buildMainMenuText(userId), {
      parse_mode: 'Markdown',
      reply_markup: buildMainMenuKeyboard(isLoggedIn),
    });
  });

  // /login command
  bot.command('login', async (ctx) => {
    const userId = ctx.from!.id;
    const session = getSession(userId);
    session.step = 'awaiting_username';
    await ctx.reply('🔐 *Step 1/2:* Please reply with your *BrainxHR Work Email / Username*:', {
      parse_mode: 'Markdown',
    });
  });

  // /logout command
  bot.command('logout', async (ctx) => {
    const userId = ctx.from!.id;
    userStore.removeUser(userId);
    sessions.delete(userId);
    await ctx.reply('🔓 Your BrainxHR credentials and session have been removed.', {
      reply_markup: buildMainMenuKeyboard(false),
    });
  });

  // /quickorder command
  bot.command('quickorder', async (ctx) => {
    runNonBlocking('quickorder', () => handleQuickOrder(ctx));
  });

  // /order command
  bot.command('order', async (ctx) => {
    await startCustomOrderFlow(ctx);
  });

  // /delete command
  bot.command(['delete', 'orders'], async (ctx) => {
    runNonBlocking('listOrDelete', () => handleListOrDeleteOrders(ctx));
  });

  // /defaults command
  bot.command('defaults', async (ctx) => {
    await showDefaultsMenu(ctx, false);
  });

  // /schedule command
  bot.command('schedule', async (ctx) => {
    await showScheduleMenu(ctx, false);
  });

  // /status command
  bot.command('status', async (ctx) => {
    const userId = ctx.from!.id;
    const creds = userStore.getCredentials(userId);
    if (!creds) {
      await ctx.reply('⚠️ Please link your BrainxHR account first using /login.', {
        reply_markup: buildMainMenuKeyboard(false),
      });
      return;
    }
    await ctx.reply('📸 Connecting to BrainxHR to capture live page status...');
    runNonBlocking('status', async () => {
      const res = await brainxhrService.captureStatusScreenshot(userId, creds);
      await replyWithResult(ctx, res);
    });
  });

  // Handle text inputs for interactive steps (login username, password, custom schedule time)
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    const text = ctx.message.text.trim();

    if (session.step === 'awaiting_username') {
      session.tempUsername = text;
      session.step = 'awaiting_password';
      await ctx.reply(
        '🔑 *Step 2/2:* Please reply with your *BrainxHR Password*.\n_(Your password message will be automatically deleted from this chat immediately.)_',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (session.step === 'awaiting_password') {
      const password = text;
      const username = session.tempUsername ?? '';
      session.step = 'idle';
      session.tempUsername = undefined;

      // Immediately delete the user's password message from Telegram chat for privacy
      await ctx.deleteMessage().catch(() => {});

      const statusMsg = await ctx.reply(
        `🔄 Verifying BrainxHR credentials for \`${username}\`...`,
        { parse_mode: 'Markdown' }
      );

      runNonBlocking('verifyLogin', async () => {
        const verifyResult = await brainxhrService.verifyLogin(userId, { username, password });
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

        if (!verifyResult.success) {
          userStore.removeUser(userId);
          session.step = 'awaiting_username';
          await ctx.reply(
            [
              verifyResult.message,
              '',
              '🔐 *Please try again — Step 1/2:* Reply with your *BrainxHR Work Email / Username*:',
            ].join('\n'),
            {
              parse_mode: 'Markdown',
            }
          );
          return;
        }

        userStore.saveCredentials(
          userId,
          { username, password },
          {
            telegramUsername: ctx.from.username,
            firstName: ctx.from.first_name,
          }
        );

        await replyWithResult(ctx, verifyResult, buildMainMenuKeyboard(true));
      });
      return;
    }

    if (session.step === 'awaiting_custom_schedule_time') {
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(text)) {
        await ctx.reply(
          '⚠️ Invalid time format. Please enter time in 24-hour `HH:mm` format (e.g. `08:30` or `09:15`):',
          { parse_mode: 'Markdown' }
        );
        return;
      }
      if (!isScheduleTimeWithinOrderingWindow(text)) {
        await ctx.reply(
          '🚫 *Outside Ordering Window!*\nThe Baker Street counter only accepts orders between *12:00 AM (`00:00`) and 10:30 AM (`10:30`)* Sri Lanka Time.\n\nPlease enter a time between `00:00` and `10:25` (e.g. `08:30`):',
          { parse_mode: 'Markdown' }
        );
        return;
      }
      session.step = 'idle';
      userStore.updateSchedule(userId, { time: text, enabled: true, lastRunDate: undefined });
      await showScheduleMenu(ctx, false);
      return;
    }

    const isLoggedIn = Boolean(userStore.getUser(userId));
    await ctx.reply(buildMainMenuText(userId), {
      parse_mode: 'Markdown',
      reply_markup: buildMainMenuKeyboard(isLoggedIn),
    });
  });

  // Callback Query Handlers for Inline Keyboards
  bot.on('callback_query:data', async (ctx) => {
    const userId = ctx.from.id;
    const data = ctx.callbackQuery.data;
    const session = getSession(userId);

    await ctx.answerCallbackQuery().catch(() => {});

    // 1. Navigation & Auth
    if (data === 'menu:main') {
      session.step = 'idle';
      const isLoggedIn = Boolean(userStore.getUser(userId));
      await ctx
        .editMessageText(buildMainMenuText(userId), {
          parse_mode: 'Markdown',
          reply_markup: buildMainMenuKeyboard(isLoggedIn),
        })
        .catch(async () => {
          await ctx.reply(buildMainMenuText(userId), {
            parse_mode: 'Markdown',
            reply_markup: buildMainMenuKeyboard(isLoggedIn),
          });
        });
      return;
    }

    if (data === 'auth:start_login') {
      session.step = 'awaiting_username';
      await ctx.reply('🔐 *Step 1/2:* Please reply with your *BrainxHR Work Email / Username*:', {
        parse_mode: 'Markdown',
      });
      return;
    }

    if (data === 'auth:logout') {
      userStore.removeUser(userId);
      sessions.delete(userId);
      await ctx.reply('🔓 Your BrainxHR credentials and session have been deleted.', {
        reply_markup: buildMainMenuKeyboard(false),
      });
      return;
    }

    // Ensure user is logged in for all below actions
    const user = userStore.getUser(userId);
    const creds = userStore.getCredentials(userId);
    if (!user || !creds) {
      await ctx.reply('⚠️ Please link your BrainxHR account first using /login.', {
        reply_markup: buildMainMenuKeyboard(false),
      });
      return;
    }

    // 2. Quick Order
    if (data === 'order:quick') {
      runNonBlocking('quickOrder', () => handleQuickOrder(ctx));
      return;
    }

    // 3. Custom Order Multi-Step Wizard
    if (data === 'order:custom_start') {
      session.draftOrder = { ...user.defaults };
      await renderLocationStep(ctx, session.draftOrder, true);
      return;
    }

    if (data.startsWith('co_loc:')) {
      const idx = Number(data.split(':')[1]);
      session.draftOrder.location = config.options.locations[idx] ?? user.defaults.location;
      await renderOrderForStep(ctx, session.draftOrder);
      return;
    }

    if (data.startsWith('co_for:')) {
      const idx = Number(data.split(':')[1]);
      session.draftOrder.orderFor = config.options.orderFor[idx] ?? user.defaults.orderFor;
      await renderFoodTypeStep(ctx, session.draftOrder);
      return;
    }

    if (data.startsWith('co_food:')) {
      const idx = Number(data.split(':')[1]);
      session.draftOrder.foodType = config.options.foodTypes[idx] ?? user.defaults.foodType;
      await renderOrderConfirmStep(ctx, session.draftOrder);
      return;
    }

    if (data === 'co_submit') {
      const order = { ...session.draftOrder };
      await ctx.reply(
        [
          '🔄 *Submitting your order to BrainxHR...*',
          `📍 *Location:* ${order.location}`,
          `👤 *Order For:* ${order.orderFor}`,
          `🍱 *Food Type:* ${order.foodType}`,
        ].join('\n'),
        { parse_mode: 'Markdown' }
      );
      runNonBlocking('customOrderSubmit', async () => {
        const res = await brainxhrService.placeOrder(userId, creds, order);
        const afterOrderKb = res.success
          ? new InlineKeyboard()
              .text('🗑️ Delete This Order', 'del_order:0')
              .row()
              .text('🏠 Main Menu', 'menu:main')
          : new InlineKeyboard()
              .text('⏰ Schedule Auto-Order for Morning', 'settings:schedule')
              .row()
              .text('🏠 Main Menu', 'menu:main');
        await replyWithResult(ctx, res, afterOrderKb);
      });
      return;
    }

    // 4. List & Delete Placed Orders
    if (data === 'order:list_or_delete') {
      runNonBlocking('listOrDelete', () => handleListOrDeleteOrders(ctx));
      return;
    }

    if (data.startsWith('del_order:')) {
      const rowIndex = Number(data.split(':')[1] ?? '0');
      await ctx.reply('🗑️ Connecting to BrainxHR to cancel/delete the placed order...');
      runNonBlocking('deleteOrder', async () => {
        const res = await brainxhrService.deleteOrder(userId, creds, rowIndex);
        await replyWithResult(ctx, res);
      });
      return;
    }

    // 5. Portal Status Screenshot
    if (data === 'portal:status') {
      await ctx.reply('📸 Capturing live BrainxHR Cafe Order page screenshot...');
      runNonBlocking('portalStatus', async () => {
        const res = await brainxhrService.captureStatusScreenshot(userId, creds);
        await replyWithResult(ctx, res);
      });
      return;
    }

    // 6. Configure User Defaults (/defaults)
    if (data === 'settings:defaults') {
      await showDefaultsMenu(ctx, true);
      return;
    }

    if (data.startsWith('def_loc:')) {
      const idx = Number(data.split(':')[1]);
      const location = config.options.locations[idx];
      if (location) userStore.updateDefaults(userId, { location });
      await showDefaultsMenu(ctx, true);
      return;
    }

    if (data.startsWith('def_for:')) {
      const idx = Number(data.split(':')[1]);
      const orderFor = config.options.orderFor[idx];
      if (orderFor) userStore.updateDefaults(userId, { orderFor });
      await showDefaultsMenu(ctx, true);
      return;
    }

    if (data.startsWith('def_food:')) {
      const idx = Number(data.split(':')[1]);
      const foodType = config.options.foodTypes[idx];
      if (foodType) userStore.updateDefaults(userId, { foodType });
      await showDefaultsMenu(ctx, true);
      return;
    }

    // 7. Configure Auto-Order Schedule (/schedule)
    if (data === 'settings:schedule') {
      await showScheduleMenu(ctx, true);
      return;
    }

    if (data === 'sched:toggle') {
      const current = user.schedule.enabled;
      userStore.updateSchedule(userId, { enabled: !current, lastRunDate: undefined });
      await showScheduleMenu(ctx, true);
      return;
    }

    if (data.startsWith('sched:time:')) {
      const time = data.replace('sched:time:', '');
      userStore.updateSchedule(userId, { time, enabled: true, lastRunDate: undefined });
      await showScheduleMenu(ctx, true);
      return;
    }

    if (data === 'sched:custom_time') {
      session.step = 'awaiting_custom_schedule_time';
      await ctx.reply(
        `⌨️ Please reply with your desired daily order time in 24-hour \`HH:mm\` format between \`00:00\` and \`10:25\` (${config.timezone}), e.g. \`08:30\` or \`09:15\`:`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (data === 'sched:days:weekdays') {
      userStore.updateSchedule(userId, { daysOfWeek: [1, 2, 3, 4, 5], lastRunDate: undefined });
      await showScheduleMenu(ctx, true);
      return;
    }

    if (data === 'sched:days:everyday') {
      userStore.updateSchedule(userId, {
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        lastRunDate: undefined,
      });
      await showScheduleMenu(ctx, true);
      return;
    }
  });

  // Helper flows
  async function handleQuickOrder(ctx: Context): Promise<void> {
    const userId = ctx.from!.id;
    const user = userStore.getUser(userId);
    const creds = userStore.getCredentials(userId);
    if (!user || !creds) {
      await ctx.reply('⚠️ Please link your BrainxHR account first using /login.', {
        reply_markup: buildMainMenuKeyboard(false),
      });
      return;
    }

    await ctx.reply(
      [
        '⚡ *Placing Quick Order with your Default Preferences...*',
        `📍 *Location:* ${user.defaults.location}`,
        `👤 *Order For:* ${user.defaults.orderFor}`,
        `🍱 *Food Type:* ${user.defaults.foodType}`,
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );

    const res = await brainxhrService.placeOrder(userId, creds, user.defaults);
    const kb = res.success
      ? new InlineKeyboard()
          .text('🗑️ Delete This Order', 'del_order:0')
          .row()
          .text('🏠 Main Menu', 'menu:main')
      : new InlineKeyboard()
          .text('⏰ Schedule Auto-Order for Morning', 'settings:schedule')
          .row()
          .text('🏠 Main Menu', 'menu:main');
    await replyWithResult(ctx, res, kb);
  }

  async function startCustomOrderFlow(ctx: Context): Promise<void> {
    const userId = ctx.from!.id;
    const user = userStore.getUser(userId);
    if (!user) {
      await ctx.reply('⚠️ Please link your BrainxHR account first using /login.', {
        reply_markup: buildMainMenuKeyboard(false),
      });
      return;
    }
    const session = getSession(userId);
    session.draftOrder = { ...user.defaults };
    await renderLocationStep(ctx, session.draftOrder, false);
  }

  async function renderLocationStep(
    ctx: Context,
    draft: OrderRequest,
    edit: boolean
  ): Promise<void> {
    const windowStatus = getOrderingWindowStatus(config.timezone);
    const kb = new InlineKeyboard();
    config.options.locations.forEach((loc, idx) => {
      const prefix = loc === draft.location ? '✅ ' : '';
      kb.text(`${prefix}${loc}`, `co_loc:${idx}`).row();
    });
    kb.text('🔙 Back to Menu', 'menu:main');

    const closedWarning = !windowStatus.isOpen
      ? `\n⚠️ _Note: Counter is currently closed (${windowStatus.currentTimeSL} SL Time). Orders are only accepted 12:00 AM – 10:30 AM._\n`
      : '';

    const text = `🍽️ *Custom Order — Step 1/3*${closedWarning}\nSelect *Location*:`;
    if (edit) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }).catch(async () => {
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
      });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    }
  }

  async function renderOrderForStep(ctx: Context, draft: OrderRequest): Promise<void> {
    const kb = new InlineKeyboard();
    config.options.orderFor.forEach((opt, idx) => {
      const prefix = opt === draft.orderFor ? '✅ ' : '';
      kb.text(`${prefix}${opt}`, `co_for:${idx}`).row();
    });
    kb.text('🔙 Back', 'order:custom_start');

    const text = [
      '🍽️ *Custom Order — Step 2/3*',
      `📍 *Location:* ${draft.location}`,
      '',
      'Select *Order For*:',
    ].join('\n');

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    });
  }

  async function renderFoodTypeStep(ctx: Context, draft: OrderRequest): Promise<void> {
    const kb = new InlineKeyboard();
    config.options.foodTypes.forEach((food, idx) => {
      const prefix = food === draft.foodType ? '✅ ' : '';
      kb.text(`${prefix}${food}`, `co_food:${idx}`).row();
    });
    kb.text('🔙 Start Over', 'order:custom_start');

    const text = [
      '🍽️ *Custom Order — Step 3/3*',
      `📍 *Location:* ${draft.location}`,
      `👤 *Order For:* ${draft.orderFor}`,
      '',
      'Select *Food Type*:',
    ].join('\n');

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    });
  }

  async function renderOrderConfirmStep(ctx: Context, draft: OrderRequest): Promise<void> {
    const kb = new InlineKeyboard()
      .text('✅ Submit Order Now', 'co_submit')
      .row()
      .text('🔄 Change Selection', 'order:custom_start')
      .text('❌ Cancel', 'menu:main');

    const text = [
      '📝 *Confirm Your Food Order*',
      '',
      `📍 *Location:* ${draft.location}`,
      `👤 *Order For:* ${draft.orderFor}`,
      `🍱 *Food Type:* ${draft.foodType}`,
      '',
      'Tap *Submit Order Now* to place this order on BrainxHR:',
    ].join('\n');

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    });
  }

  async function handleListOrDeleteOrders(ctx: Context): Promise<void> {
    const userId = ctx.from!.id;
    const creds = userStore.getCredentials(userId);
    if (!creds) {
      await ctx.reply('⚠️ Please link your BrainxHR account first using /login.', {
        reply_markup: buildMainMenuKeyboard(false),
      });
      return;
    }

    await ctx.reply('🔍 Checking Today Orders on BrainxHR...');
    const res = await brainxhrService.getPlacedOrders(userId, creds);

    const kb = new InlineKeyboard();
    if (res.orders && res.orders.length > 0) {
      res.orders.forEach((order, i) => {
        kb.text(`🗑️ Cancel Order #${i + 1}: ${order.summary.slice(0, 28)}`, `del_order:${order.rowIndex}`).row();
      });
    }
    kb.text('🏠 Main Menu', 'menu:main');

    const detailLines =
      res.orders && res.orders.length > 0
        ? [
            res.message,
            '',
            ...res.orders.map((o, i) => `*#${i + 1}:* \`${o.summary}\``),
            '',
            'Tap a button below to cancel/delete an order:',
          ].join('\n')
        : res.message;

    await replyWithResult(
      ctx,
      { message: detailLines, screenshotPath: res.screenshotPath },
      kb
    );
  }

  async function showDefaultsMenu(ctx: Context, edit: boolean): Promise<void> {
    const userId = ctx.from!.id;
    const user = userStore.getUser(userId);
    if (!user) {
      await ctx.reply('⚠️ Please link your BrainxHR account first using /login.');
      return;
    }

    const kb = new InlineKeyboard();
    config.options.locations.forEach((loc, idx) => {
      const active = user.defaults.location === loc ? '✅ ' : '';
      kb.text(`📍 ${active}${loc}`, `def_loc:${idx}`);
    });
    kb.row();

    config.options.orderFor.forEach((opt, idx) => {
      const active = user.defaults.orderFor === opt ? '✅ ' : '';
      kb.text(`👤 ${active}${opt}`, `def_for:${idx}`);
      if (idx === 1) kb.row();
    });
    kb.row();

    config.options.foodTypes.forEach((food, idx) => {
      const active = user.defaults.foodType === food ? '✅ ' : '';
      kb.text(`🍱 ${active}${food}`, `def_food:${idx}`);
      if (idx === 1) kb.row();
    });
    kb.row();

    kb.text('⚡ Place Quick Order Now', 'order:quick')
      .row()
      .text('🏠 Back to Main Menu', 'menu:main');

    const text = [
      '⚙️ *Configure Your Default Order Preferences*',
      '_These defaults are used for 1-Tap Quick Orders and Scheduled Auto-Orders._',
      '',
      `📍 *Default Location:* ${user.defaults.location}`,
      `👤 *Default Order For:* ${user.defaults.orderFor}`,
      `🍱 *Default Food Type:* ${user.defaults.foodType}`,
      '',
      'Tap any option below to update your saved defaults:',
    ].join('\n');

    if (edit) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }).catch(async () => {
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
      });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    }
  }

  async function showScheduleMenu(ctx: Context, edit: boolean): Promise<void> {
    const userId = ctx.from!.id;
    const user = userStore.getUser(userId);
    if (!user) {
      await ctx.reply('⚠️ Please link your BrainxHR account first using /login.');
      return;
    }

    const sched = user.schedule;
    const statusText = sched.enabled ? '🟢 *ENABLED*' : '🔴 *DISABLED*';
    const toggleLabel = sched.enabled ? '⏸️ Disable Auto-Order' : '▶️ Enable Auto-Order';

    const presetTimes = ['07:30', '08:00', '08:30', '09:00', '09:30', '10:00'];
    const kb = new InlineKeyboard()
      .text(toggleLabel, 'sched:toggle')
      .row();

    presetTimes.forEach((t, idx) => {
      const prefix = sched.time === t ? '✅ ' : '🕒 ';
      kb.text(`${prefix}${t}`, `sched:time:${t}`);
      if (idx === 2) kb.row();
    });
    kb.row()
      .text('⌨️ Set Custom Time (00:00 – 10:25)', 'sched:custom_time')
      .row()
      .text(
        sched.daysOfWeek.length === 5 ? '✅ Mon–Fri (Weekdays)' : '📅 Mon–Fri (Weekdays)',
        'sched:days:weekdays'
      )
      .text(
        sched.daysOfWeek.length === 7 ? '✅ Every Day' : '📅 Every Day',
        'sched:days:everyday'
      )
      .row()
      .text('⚙️ Edit Default Food/Location', 'settings:defaults')
      .row()
      .text('🏠 Back to Main Menu', 'menu:main');

    const text = [
      '⏰ *Scheduled Automatic Food Order*',
      '_Counter is open 12:00 AM – 10:30 AM SL Time._',
      '',
      `*Status:* ${statusText}`,
      `*Scheduled Time:* \`${sched.time}\` (${config.timezone})`,
      `*Active Days:* ${formatDays(sched.daysOfWeek)}`,
      '',
      '*Order Values that will be submitted:*',
      `• *Location:* ${user.defaults.location}`,
      `• *Order For:* ${user.defaults.orderFor}`,
      `• *Food Type:* ${user.defaults.foodType}`,
      '',
      'Choose a time or toggle your schedule below:',
    ].join('\n');

    if (edit) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }).catch(async () => {
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
      });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    }
  }

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx.update }, 'Unhandled Telegram Bot error');
  });

  return bot;
}
