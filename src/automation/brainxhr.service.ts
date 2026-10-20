import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { userStore } from '../store/user.store.js';
import type {
  AutomationResult,
  OrderRequest,
  PlacedOrder,
  UserCredentials,
} from '../types.js';
import {
  getCandidateVariants,
  getOrderingWindowStatus,
  SELECTORS,
} from './selectors.js';

export class BrainxHRService {
  constructor() {
    fs.mkdirSync(config.paths.authDir, { recursive: true });
    fs.mkdirSync(config.paths.debugDir, { recursive: true });
  }

  /**
   * Executes a callback inside an isolated per-user browser context, automatically
   * handling login, network delays, and storage state persistence.
   */
  private async withUserPage<T>(
    telegramId: number,
    credentials: UserCredentials,
    taskName: string,
    fn: (page: Page) => Promise<T>
  ): Promise<T> {
    const storageStatePath = userStore.getStorageStatePath(telegramId);
    const hasSavedState = fs.existsSync(storageStatePath);

    const browser = await chromium.launch({
      headless: config.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({
        storageState: hasSavedState ? storageStatePath : undefined,
        viewport: { width: 1366, height: 900 },
        ignoreHTTPSErrors: true,
      });

      const page = await context.newPage();
      page.setDefaultTimeout(60000);
      page.setDefaultNavigationTimeout(90000);

      // Automatically accept native browser confirm() / alert() dialogs
      page.on('dialog', async (dialog) => {
        logger.info(
          { message: dialog.message(), type: dialog.type() },
          'Auto-accepting browser dialog'
        );
        await dialog.accept().catch(() => {});
      });

      await this.ensureAuthenticatedAndOnCafePage(page, context, storageStatePath, credentials);
      return await fn(page);
    } catch (err) {
      logger.error({ err, telegramId, taskName }, 'Error during Playwright automation task');
      throw err;
    } finally {
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  /**
   * Waits for ASP.NET WebForms UpdatePanel postbacks and network delays to settle.
   */
  private async waitForAspNetPostback(page: Page, settleMs = 3500): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 90000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(800);

    const progress = page.locator(SELECTORS.cafeOrder.updateProgressIndicator);
    if ((await progress.count()) > 0) {
      await progress.waitFor({ state: 'hidden', timeout: 45000 }).catch(() => {});
    }

    await page.waitForTimeout(settleMs);
  }

  /**
   * Detects if the BrainxHR Baker Street page is showing the "Sorry WE'RE CLOSED" view
   * ("You cant place orders now! Contact Respective Person for late orders.") or if
   * the Submit button (#cphContent_CafeFoodOrderUC_btnSave) is hidden/absent after 10:30 AM.
   */
  private async isCounterClosedOnPage(page: Page): Promise<{
    closed: boolean;
    portalNotice?: string;
  }> {
    const closedImgCount = await page.locator(SELECTORS.cafeOrder.closedSignImage).count();
    const closedTextLoc = page.locator(SELECTORS.cafeOrder.closedMessageText).first();
    const hasClosedText = (await closedTextLoc.count()) > 0;
    const submitBtnCount = await page.locator(SELECTORS.cafeOrder.submitButton).count();

    if (closedImgCount > 0 || hasClosedText || submitBtnCount === 0) {
      const notice = hasClosedText
        ? (await closedTextLoc.innerText().catch(() => '')).trim()
        : 'You cant place orders now! Contact Respective Person for late orders.';
      return {
        closed: true,
        portalNotice: notice || 'You cant place orders now! Contact Respective Person for late orders.',
      };
    }

    return { closed: false };
  }

  /**
   * Navigates to the Cafe Order Food URL and performs login if redirected to /login.
   */
  private async ensureAuthenticatedAndOnCafePage(
    page: Page,
    context: BrowserContext,
    storageStatePath: string,
    credentials: UserCredentials
  ): Promise<void> {
    logger.info({ url: config.brainxhrUrl }, 'Navigating to BrainxHR Cafe Order page');
    await page.goto(config.brainxhrUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await this.waitForAspNetPostback(page, 3500);

    const needsLogin = await this.isLoginPage(page);
    if (needsLogin) {
      logger.info(
        { username: credentials.username },
        'Session requires authentication; logging in via #txtiSignInEmail'
      );
      await this.performLogin(page, credentials);
      await context.storageState({ path: storageStatePath });
    } else {
      await context.storageState({ path: storageStatePath });
    }

    if (!page.url().includes('cafe-order-food')) {
      await page.goto(config.brainxhrUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.waitForAspNetPostback(page, 3500);
    }

    // Wait for either the Location dropdown or the Closed Sign image to be visible
    await Promise.race([
      page
        .locator(SELECTORS.cafeOrder.locationSelect)
        .waitFor({ state: 'visible', timeout: 45000 }),
      page
        .locator(SELECTORS.cafeOrder.closedSignImage)
        .waitFor({ state: 'visible', timeout: 45000 }),
    ]).catch(() => {});
  }

  private async isLoginPage(page: Page): Promise<boolean> {
    const currentUrl = page.url().toLowerCase();
    if (currentUrl.includes('/login')) {
      return true;
    }
    return await page.locator(SELECTORS.login.passwordInput).isVisible();
  }

  private async performLogin(page: Page, credentials: UserCredentials): Promise<void> {
    const emailInput = page.locator(SELECTORS.login.emailInput);
    const passwordInput = page.locator(SELECTORS.login.passwordInput);
    const rememberMe = page.locator(SELECTORS.login.rememberMeCheckbox);
    const submitBtn = page.locator(SELECTORS.login.submitButton);

    await emailInput.waitFor({ state: 'visible', timeout: 30000 });
    await emailInput.fill(credentials.username);
    await passwordInput.fill(credentials.password);

    if ((await rememberMe.count()) > 0 && !(await rememberMe.isChecked())) {
      await rememberMe.check().catch(() => {});
    }

    await submitBtn.click();
    await this.waitForAspNetPostback(page, 5000);

    if (await this.isLoginPage(page)) {
      throw new Error(
        'Login failed — still on the BrainxHR Sign In page. Please verify your Work Email and Password.'
      );
    }
  }

  /**
   * Selects an option inside a native ASP.NET <select> control and waits for the
   * AutoPostBack UpdatePanel refresh to finish.
   */
  private async selectAspNetDropdown(
    page: Page,
    selectSelector: string,
    desiredOption: string,
    fieldName: string
  ): Promise<string> {
    const selectLoc = page.locator(selectSelector);
    await selectLoc.waitFor({ state: 'visible', timeout: 30000 });

    const variants = getCandidateVariants(desiredOption);
    const options = await selectLoc.locator('option').evaluateAll((els) =>
      els.map((el) => {
        const opt = el as HTMLOptionElement;
        return {
          text: (opt.text || '').trim(),
          value: opt.value,
          selected: opt.selected,
        };
      })
    );

    const matched = options.find(
      (o) =>
        o.value !== '0' &&
        variants.some(
          (v) =>
            o.text.toLowerCase() === v.toLowerCase() ||
            o.text.toLowerCase().includes(v.toLowerCase())
        )
    );

    if (!matched) {
      const available = options
        .filter((o) => o.value !== '0')
        .map((o) => o.text)
        .join(', ');
      throw new Error(
        `Option "${desiredOption}" not found in ${fieldName}. Available options: [${available || 'None'}]`
      );
    }

    if (!matched.selected) {
      logger.info(
        { fieldName, selectedText: matched.text, selectedValue: matched.value },
        'Selecting dropdown option and waiting for ASP.NET AutoPostBack'
      );
      await selectLoc.selectOption(matched.value);
      await this.waitForAspNetPostback(page, 4000);
    } else {
      logger.info(
        { fieldName, selectedText: matched.text },
        'Dropdown option already selected; skipping redundant postback'
      );
    }

    return matched.text;
  }

  /**
   * Verifies a user's BrainxHR login credentials and captures a portal screenshot.
   */
  public async verifyLogin(
    telegramId: number,
    credentials: UserCredentials
  ): Promise<AutomationResult> {
    try {
      const storageStatePath = userStore.getStorageStatePath(telegramId);
      if (fs.existsSync(storageStatePath)) {
        fs.unlinkSync(storageStatePath);
      }
      return await this.withUserPage(telegramId, credentials, 'verifyLogin', async (page) => {
        const closedCheck = await this.isCounterClosedOnPage(page);
        const orders = await this.extractOrdersFromPage(page);
        const screenshotPath = await this.saveScreenshot(page, `login-verified-${telegramId}`);
        const windowStatus = getOrderingWindowStatus(config.timezone);

        return {
          success: true,
          message: [
            `✅ *Successfully authenticated into BrainxHR!*`,
            `👤 *Account:* \`${credentials.username}\``,
            `🏪 *Counter Status:* ${windowStatus.statusBanner}`,
            closedCheck.closed
              ? `ℹ️ _Portal Notice: "${closedCheck.portalNotice}"_`
              : `📋 *Today's Active Orders:* ${orders.length}`,
          ].join('\n'),
          screenshotPath,
          orders,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `❌ Authentication failed: ${msg}`,
      };
    }
  }

  /**
   * Places a food order on BrainxHR.
   * Checks both the Sri Lanka time window (12:00 AM - 10:30 AM) and the portal's "Sorry WE'RE CLOSED" view.
   */
  public async placeOrder(
    telegramId: number,
    credentials: UserCredentials,
    order: OrderRequest
  ): Promise<AutomationResult> {
    try {
      return await this.withUserPage(telegramId, credentials, 'placeOrder', async (page) => {
        // Check if the portal is showing the "Sorry WE'RE CLOSED" / order not available view
        const closedCheck = await this.isCounterClosedOnPage(page);
        const windowStatus = getOrderingWindowStatus(config.timezone);

        if (closedCheck.closed) {
          const screenshotPath = await this.saveScreenshot(page, `order-closed-${telegramId}`);
          return {
            success: false,
            message: [
              '🚫 *Order Placement Not Available (Counter Closed)*',
              '',
              `🕒 *Current SL Time:* \`${windowStatus.currentTimeSL}\``,
              '⏳ Orders and adjustments are permitted only between *12:00 AM (Midnight) and 10:30 AM* Sri Lanka Time.',
              '',
              `💬 *Portal Message:* _"${closedCheck.portalNotice}"_`,
              '💡 *Tip:* Use /schedule to set an automatic daily order (e.g. at `08:30`) so you never miss the 10:30 AM cutoff!',
            ].join('\n'),
            screenshotPath,
          };
        }

        // 1. Select Location first (populates Food Type options via AutoPostBack)
        const chosenLocation = await this.selectAspNetDropdown(
          page,
          SELECTORS.cafeOrder.locationSelect,
          order.location,
          'Location'
        );

        // 2. Select Order For
        const chosenOrderFor = await this.selectAspNetDropdown(
          page,
          SELECTORS.cafeOrder.orderForSelect,
          order.orderFor,
          'Order For'
        );

        // 3. Select Food Type
        const chosenFoodType = await this.selectAspNetDropdown(
          page,
          SELECTORS.cafeOrder.foodTypeSelect,
          order.foodType,
          'Food Type'
        );

        // 4. Click Submit Order (#cphContent_CafeFoodOrderUC_btnSave)
        const submitBtn = page.locator(SELECTORS.cafeOrder.submitButton);
        if ((await submitBtn.count()) === 0 || !(await submitBtn.isVisible())) {
          const screenshotPath = await this.saveScreenshot(page, `submit-unavailable-${telegramId}`);
          return {
            success: false,
            message:
              '🚫 *Submit Order button is not available!* The ordering window (12:00 AM – 10:30 AM SL Time) has closed.',
            screenshotPath,
          };
        }

        await submitBtn.click();
        await this.waitForAspNetPostback(page, 4500);

        const orders = await this.extractOrdersFromPage(page);
        const screenshotPath = await this.saveScreenshot(page, `order-placed-${telegramId}`);

        return {
          success: true,
          message: [
            '✅ *Food Order Submitted Successfully!*',
            `📍 *Location:* ${chosenLocation}`,
            `👤 *Order For:* ${chosenOrderFor}`,
            `🍱 *Food Type:* ${chosenFoodType}`,
            orders.length > 0 ? `\n📋 *Today's Orders:* ${orders[0].summary}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          screenshotPath,
          orders,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `❌ Failed to place order: ${msg}`,
      };
    }
  }

  /**
   * Scrapes Today's Placed Orders from `#gridOrderedFood` (and checks if counter is closed).
   */
  public async getPlacedOrders(
    telegramId: number,
    credentials: UserCredentials
  ): Promise<AutomationResult> {
    try {
      return await this.withUserPage(telegramId, credentials, 'getPlacedOrders', async (page) => {
        const closedCheck = await this.isCounterClosedOnPage(page);
        const windowStatus = getOrderingWindowStatus(config.timezone);
        const orders = await this.extractOrdersFromPage(page);
        const screenshotPath = await this.saveScreenshot(page, `orders-list-${telegramId}`);

        if (closedCheck.closed) {
          return {
            success: true,
            message: [
              '🚫 *Order Modification / Cancellation Window Closed*',
              '',
              `🕒 *Current SL Time:* \`${windowStatus.currentTimeSL}\``,
              '⏳ Adding or deleting orders is only permitted between *12:00 AM and 10:30 AM* Sri Lanka Time.',
              `💬 *Portal Message:* _"${closedCheck.portalNotice}"_`,
            ].join('\n'),
            screenshotPath,
            orders: [],
          };
        }

        if (orders.length === 0) {
          return {
            success: true,
            message: 'ℹ️ You currently have *no active placed orders* for today.',
            screenshotPath,
            orders: [],
          };
        }

        return {
          success: true,
          message: `📋 Found *${orders.length}* active order(s) for today:`,
          screenshotPath,
          orders,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `❌ Failed to fetch placed orders: ${msg}`,
      };
    }
  }

  /**
   * Deletes ("Cancel Order") a placed order in `#gridOrderedFood` using BrainxHR's 2-step flow.
   * Gracefully handles the closed window after 10:30 AM SL time.
   */
  public async deleteOrder(
    telegramId: number,
    credentials: UserCredentials,
    rowIndex = 0
  ): Promise<AutomationResult> {
    try {
      return await this.withUserPage(telegramId, credentials, 'deleteOrder', async (page) => {
        const closedCheck = await this.isCounterClosedOnPage(page);
        const windowStatus = getOrderingWindowStatus(config.timezone);

        if (closedCheck.closed) {
          const screenshotPath = await this.saveScreenshot(page, `delete-closed-${telegramId}`);
          return {
            success: false,
            message: [
              '🚫 *Order Cancellation Not Available (Counter Closed)*',
              '',
              `🕒 *Current SL Time:* \`${windowStatus.currentTimeSL}\``,
              '⏳ Order cancellations must be completed between *12:00 AM and 10:30 AM* Sri Lanka Time.',
              `💬 *Portal Message:* _"${closedCheck.portalNotice}"_`,
            ].join('\n'),
            screenshotPath,
          };
        }

        const ordersBefore = await this.extractOrdersFromPage(page);
        if (ordersBefore.length === 0) {
          const screenshotPath = await this.saveScreenshot(page, `no-orders-${telegramId}`);
          return {
            success: false,
            message: 'ℹ️ There are no active orders in Today Orders to delete.',
            screenshotPath,
          };
        }

        const targetOrder = ordersBefore[rowIndex] ?? ordersBefore[0];
        const rows = page.locator(SELECTORS.cafeOrder.selectableOrderRows);
        const rowCount = await rows.count();

        if (rowCount === 0) {
          const screenshotPath = await this.saveScreenshot(page, `no-selectable-row-${telegramId}`);
          return {
            success: false,
            message: '⚠️ Could not find a selectable order row in `#gridOrderedFood`.',
            screenshotPath,
          };
        }

        const targetRow = rows.nth(Math.min(rowIndex, rowCount - 1));
        logger.info(
          { rowIndex, summary: targetOrder?.summary },
          'Step 1/2: Clicking order row in #gridOrderedFood'
        );
        await targetRow.click();

        await this.waitForAspNetPostback(page, 4000);

        const deleteBtn = page.locator(SELECTORS.cafeOrder.deleteButton);
        const isDeleteVisible = await deleteBtn
          .waitFor({ state: 'visible', timeout: 20000 })
          .then(() => true)
          .catch(() => false);

        if (!isDeleteVisible) {
          const screenshotPath = await this.saveScreenshot(page, `delete-btn-missing-${telegramId}`);
          return {
            success: false,
            message:
              '⚠️ Selected the order row, but the "Cancel Order" button did not appear (cancellations are only permitted between 12:00 AM and 10:30 AM SL time).',
            screenshotPath,
          };
        }

        logger.info('Step 2/2: Clicking #cphContent_CafeFoodOrderUC_btnDelete ("Cancel Order")');
        await deleteBtn.click();

        await this.waitForAspNetPostback(page, 4500);

        const ordersAfter = await this.extractOrdersFromPage(page);
        const screenshotPath = await this.saveScreenshot(page, `order-deleted-${telegramId}`);

        return {
          success: true,
          message: [
            '🗑️ *Food Order Cancelled / Deleted Successfully!*',
            targetOrder ? `❌ *Removed:* \`${targetOrder.summary}\`` : '',
            `📋 *Remaining Today Orders:* ${ordersAfter.length}`,
          ]
            .filter(Boolean)
            .join('\n'),
          screenshotPath,
          orders: ordersAfter,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `❌ Failed to delete order: ${msg}`,
      };
    }
  }

  /**
   * Captures a live status screenshot of the Cafe Order page and reports whether the counter is Open or Closed.
   */
  public async captureStatusScreenshot(
    telegramId: number,
    credentials: UserCredentials
  ): Promise<AutomationResult> {
    try {
      return await this.withUserPage(telegramId, credentials, 'statusScreenshot', async (page) => {
        const closedCheck = await this.isCounterClosedOnPage(page);
        const windowStatus = getOrderingWindowStatus(config.timezone);
        const orders = await this.extractOrdersFromPage(page);
        const screenshotPath = await this.saveScreenshot(page, `status-${telegramId}`);

        const orderSummary = closedCheck.closed
          ? `• _Counter is closed (${closedCheck.portalNotice})_`
          : orders.length > 0
            ? orders.map((o, i) => `• *#${i + 1}:* \`${o.summary}\``).join('\n')
            : '• _No active orders for today_';

        return {
          success: true,
          message: [
            '📸 *Live BrainxHR Baker Street Status*',
            `🏪 *Counter:* ${windowStatus.statusBanner}`,
            '',
            '*📋 Today Orders:*',
            orderSummary,
          ].join('\n'),
          screenshotPath,
          orders,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `❌ Failed to capture portal screenshot: ${msg}`,
      };
    }
  }

  /**
   * Extracts structured order rows from `#gridOrderedFood`.
   */
  private async extractOrdersFromPage(page: Page): Promise<PlacedOrder[]> {
    const rows = page.locator(SELECTORS.cafeOrder.selectableOrderRows);
    const count = await rows.count();
    const orders: PlacedOrder[] = [];

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const cells = await row.locator('td').allInnerTexts();
      if (cells.length < 6) continue;

      const foodType = (cells[0] ?? '').trim();
      const riceType = (cells[1] ?? '').trim();
      const location = (cells[2] ?? '').trim();
      const orderFor = (cells[3] ?? '').trim() || 'My Self';
      const placedBy = (cells[4] ?? '').trim();
      const dateOfOrder = (cells[5] ?? '').trim();

      const summary = [foodType, riceType, location, dateOfOrder].filter(Boolean).join(' • ');

      orders.push({
        id: `Select$${i}`,
        rowIndex: i,
        date: dateOfOrder,
        location,
        orderFor: `${orderFor} (${placedBy})`,
        foodType: `${foodType} (${riceType})`,
        summary,
      });
    }

    return orders;
  }

  private async saveScreenshot(page: Page, prefix: string): Promise<string> {
    const filePath = path.join(config.paths.debugDir, `${prefix}-${Date.now()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  }
}

export const brainxhrService = new BrainxHRService();
