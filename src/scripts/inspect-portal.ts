import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { userStore } from '../store/user.store.js';

async function waitForAspNetPostback(page: Page, minWaitMs = 4000): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 90000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Wait for ASP.NET UpdateProgress (#cphContent_CafeFoodOrderUC_ctl03) to hide
  const updateProgress = page.locator('#cphContent_CafeFoodOrderUC_ctl03');
  if ((await updateProgress.count()) > 0) {
    await updateProgress.waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(minWaitMs);
}

async function dumpPageDetails(page: Page, stageName: string): Promise<void> {
  const structure = (await page.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const parent = el.closest('.form-group, .field, .row, div');
      const parentText = (parent ? (parent.innerText || parent.textContent || '') : '').replace(/\\s+/g, ' ').trim();
      return {
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        className: el.className || '',
        checked: Boolean(el.checked),
        value: el.type === 'password' ? '***' : (el.value || ''),
        contextText: parentText.slice(0, 120),
      };
    });

    const selects = Array.from(document.querySelectorAll('select')).map((el) => ({
      tag: 'select',
      name: el.name || '',
      id: el.id || '',
      className: el.className || '',
      options: Array.from(el.options).map((o) => ({
        text: (o.text || '').trim(),
        value: o.value,
        selected: o.selected,
      })),
    }));

    const buttons = Array.from(
      document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, [role="button"]')
    ).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      id: el.id || '',
      name: el.name || '',
      className: el.className || '',
      text: ((el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim()).slice(0, 100),
      onclick: el.getAttribute('onclick'),
      disabled: Boolean(el.disabled),
    }));

    const tables = Array.from(document.querySelectorAll('table')).map(
      (table, idx) => ({
        index: idx,
        id: table.id || '',
        className: table.className || '',
        rows: Array.from(table.querySelectorAll('tr')).map((tr) => ({
          text: ((tr.innerText || tr.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 200),
          onclick: tr.getAttribute('onclick'),
        })),
      })
    );

    return {
      url: window.location.href,
      title: document.title,
      inputs: inputs.filter(i => i.type !== 'hidden'),
      selects,
      buttons,
      tables,
    };
  })()`)) as Record<string, unknown>;

  const jsonPath = path.join(config.paths.debugDir, `${stageName}.json`);
  const htmlPath = path.join(config.paths.debugDir, `${stageName}.html`);
  const pngPath = path.join(config.paths.debugDir, `${stageName}.png`);

  fs.writeFileSync(jsonPath, JSON.stringify(structure, null, 2), 'utf8');
  fs.writeFileSync(htmlPath, await page.content(), 'utf8');
  await page.screenshot({ path: pngPath, fullPage: true });

  logger.info({ stageName, url: structure.url }, `Saved diagnostic dump for stage: ${stageName}`);
}

async function runInspect(): Promise<void> {
  fs.mkdirSync(config.paths.debugDir, { recursive: true });

  let username = config.cliFallbackCredentials.username;
  let password = config.cliFallbackCredentials.password;

  if (!username || !password) {
    const firstUser = userStore.getAllUsers()[0];
    if (firstUser) {
      const creds = userStore.getCredentials(firstUser.telegramId);
      if (creds) {
        username = creds.username;
        password = creds.password;
      }
    }
  }

  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(90000);

  try {
    logger.info('1. Navigating to BrainxHR Cafe Order URL...');
    await page.goto(config.brainxhrUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitForAspNetPostback(page, 4000);

    const passwordLocator = page.locator('#txtiSignInPassword');
    if (await passwordLocator.isVisible()) {
      logger.info({ username }, '2. Logging in via #txtiSignInEmail & #txtiSignInPassword...');
      await page.locator('#txtiSignInEmail').fill(username);
      await passwordLocator.fill(password);
      await page.locator('#btnLogin').click();
      await waitForAspNetPostback(page, 6000);
    }

    await dumpPageDetails(page, 'current-page-state');

    const locationDropdown = page.locator('#cphContent_CafeFoodOrderUC_ddCafeLocation');
    if ((await locationDropdown.count()) > 0 && (await locationDropdown.isVisible())) {
      // Stage A: Select Location = ICC Techno Hub (value="3") to see populated Food Types
      logger.info('3. Selecting Location = ICC Techno Hub to inspect dynamic Food Type options...');
      await locationDropdown.selectOption({ label: 'ICC Techno Hub' });
      await waitForAspNetPostback(page, 5000);
      await dumpPageDetails(page, '3-after-location-select');

      // Stage B: Select Food Type = Chicken
      logger.info('4. Selecting Food Type = Chicken to inspect any secondary fields (e.g. Rice Type)...');
      const foodSelect = page.locator('#cphContent_CafeFoodOrderUC_ddFoodType');
      const foodOptions = await foodSelect.locator('option').allInnerTexts();
      logger.info({ foodOptions }, 'Available Food Type options after selecting Location');
      const chickenOpt = foodOptions.find((t) => t.toLowerCase().includes('chicken'));
      if (chickenOpt) {
        await foodSelect.selectOption({ label: chickenOpt.trim() });
        await waitForAspNetPostback(page, 5000);
        await dumpPageDetails(page, '4-after-foodtype-select');
      }

      // Stage C: Click the existing order row in #gridOrderedFood to inspect the Edit/Delete buttons
      const orderRow = page.locator('#gridOrderedFood tr[onclick*="Select$0"]').first();
      if ((await orderRow.count()) > 0 && (await orderRow.isVisible())) {
        logger.info('5. Clicking existing row in #gridOrderedFood to inspect Edit/Delete buttons...');
        await orderRow.click();
        await waitForAspNetPostback(page, 5000);
        await dumpPageDetails(page, '5-after-row-select');
      }
    } else {
      logger.info('Ordering form (#cphContent_CafeFoodOrderUC_ddCafeLocation) is not visible — captured closed/unavailable view in debug-dump/current-page-state.json');
    }

    logger.info('Portal inspection completed successfully!');
  } finally {
    await browser.close();
  }
}

runInspect().catch((err) => {
  logger.error({ err }, 'Portal inspection failed');
  process.exit(1);
});
