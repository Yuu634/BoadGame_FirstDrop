'use strict';

// Run against a local server: node tests/ui-smoke.cjs
// Install Playwright separately, or point PLAYWRIGHT_MODULE at an existing installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const baseURL = process.env.TEST_URL || 'http://localhost:3100';
const output = process.env.TEST_OUTPUT || path.join(require('node:os').tmpdir(), 'first-drop-ui');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const errors = [];
  try {
    const pages = await Promise.all([0, 1].map(async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('dialog', async (dialog) => { errors.push(`Unexpected dialog: ${dialog.message()}`); await dialog.dismiss(); });
      await page.goto(baseURL);
      return page;
    }));
    const [host, guest] = pages;
    await host.locator('#nameInput').fill('設計プレイヤー');
    await host.locator('#createBtn').click();
    await host.locator('#gameScreen').waitFor({ state: 'visible' });
    const room = await host.locator('#roomCodeLabel').textContent();
    await guest.locator('#nameInput').fill('ゲスト');
    await guest.locator('#roomCodeInput').fill(room);
    await guest.locator('#joinBtn').click();
    await host.locator('#settingSabotage [data-value="false"]').click();
    await host.locator('#startGameBtn').click();
    await host.waitForFunction(() => latestState.phase === 'draft');
    await host.screenshot({ path: path.join(output, 'draft-desktop.png'), fullPage: true, animations: 'disabled' });
    for (let round = 1; round <= 4; round++) {
      for (let pick = 0; pick < 2; pick++) {
        for (const page of pages) {
          await page.waitForFunction(() => latestState.phase === 'draft' && !latestState.players.find((p) => p.id === latestState.myId).hasPendingPick && !actionPending);
          const card = page.locator('#myControls .card-option.selectable').first();
          await card.focus();
          await page.keyboard.press('Enter');
          assert.equal(await page.locator('#myControls [aria-pressed="true"]').count(), 1);
          await page.locator('#myControls > button.primary').click();
        }
      }
      for (const page of pages) {
        await page.waitForFunction(() => latestState.phase === 'placement' && !actionPending);
        assert.equal(await page.locator('.player-panel.me #myControls').count(), 1);
        assert.equal(await page.locator('.slot.selectable').count(), 0, 'no slots highlighted before selecting a card');
        for (let i = 0; i < 2; i++) {
          await page.locator('#myControls .card-option.selectable').first().click();
          const emptySlots = await page.locator('.player-panel.me .slot.selectable').count();
          assert(emptySlots > 0);
          if (await page.locator('.brake-setting input').count()) await page.locator('.brake-setting input').fill('2');
          await page.locator('.player-panel.me .slot.selectable').first().click();
          if (round === 1 && i === 0) {
            await page.locator('.pending-slot').click();
            assert.equal(await page.locator('.pending-slot').count(), 0);
            await page.locator('#myControls .card-option.selectable').first().click();
            await page.locator('.player-panel.me .slot.selectable').first().click();
          }
        }
        assert.equal(await page.locator('#myControls .card-option.selectable').count(), 0, 'no further card selection after reaching the required count');
        assert.equal(await page.locator('.player-panel:not(.me) .slot[role="button"]').count(), 0);
        if (round === 1 && page === host) {
          await page.screenshot({ path: path.join(output, 'placement-desktop.png'), fullPage: true, animations: 'disabled' });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.screenshot({ path: path.join(output, 'placement-mobile.png'), fullPage: true, animations: 'disabled' });
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile page must not overflow horizontally');
          await page.setViewportSize({ width: 1280, height: 1000 });
        }
        await page.locator('#myControls > button.primary').click();
      }
    }
    await host.waitForFunction(() => latestState.phase === 'finished');
    await host.locator('#skipResultBtn').click();
    assert(await host.locator('.result-row').count() === 2);
    await host.locator('#playAgainBtn').click();
    await host.waitForFunction(() => latestState.phase === 'draft' && latestState.round === 1);
    assert.equal(await host.locator('.pending-slot').count(), 0);
    await host.waitForTimeout(1100); // ensure the cancelled results animation cannot alter the next game
    assert.equal(await host.locator('#myControls .card-option').count(), 3);
    assert.deepEqual(errors, []);
    console.log('PASS: two-player game, keyboard draft, placement/undo, legal highlights, mobile layout, results/skip, replay.');
    console.log(`Screenshots: ${output}`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
