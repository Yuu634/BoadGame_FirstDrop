'use strict';

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const GameRoom = require('../src/GameRoom');
const path = require('node:path');
const fs = require('node:fs');
const output = process.env.TEST_OUTPUT || path.join(require('node:os').tmpdir(), 'first-drop-ui');
fs.mkdirSync(output, { recursive: true });
const curve = (id) => ({ id, kind: 'part', type: 'curve', thrill: 1, label: 'カーブ' });
const brake = { id: 'brake-test', kind: 'part', type: 'brake', thrill: 0, label: 'ブレーキ' };
const room = new GameRoom('TEST');
for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `プレイヤー${i + 1}`);
room.updateSettings('p0', { railSize: 16 });
room.startGame();
const base = room.stateFor('p0');
base.phase = 'placement';
base.myRequiredPlacementCount = 2;
base.players[0].hand = [brake, curve('c1'), curve('c2')];

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(process.env.TEST_URL || 'http://localhost:3100');
    await page.evaluate(() => socket.disconnect());
    async function setState(state) {
      await page.evaluate((s) => {
        latestState = s; pendingPlacements = []; selectedCardId = null; draftSelectedCardId = null;
        sabotageSelectedCardId = null; sabotagePlayParams = {}; recoveryChoiceState = {};
        el('lobbyScreen').classList.add('hidden'); el('gameScreen').classList.remove('hidden');
        render();
      }, state);
    }
    await setState(base);
    await page.locator('#myControls .card-option').first().click();
    await page.locator('.brake-setting input').fill('3');
    await page.locator('.player-panel.me .slot.selectable').nth(2).click();
    assert.equal(await page.evaluate(() => pendingPlacements[0].brakeReduce), 3);
    assert.equal(await page.locator('.player-panel:not(.me) .slot.selectable').count(), 0);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width}px / 16 slots / 4 players`);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#myControls .card-option.selectable').first().click();
    assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect.getTiming().duration > 1).length), 0);

    const event = structuredClone(base);
    event.phase = 'sabotage'; event.sabotageTurnPlayerId = 'p0';
    event.players[0].sabotageHand = [
      { id: 'unusable', type: 'partLevelDown', category: 'part', label: 'レベルダウン', desc: '巻上か落下のレベルを下げる' },
      { id: 'swap', type: 'partSwap', category: 'part', label: 'パーツ交換', desc: 'パーツを入れ替える' },
    ];
    event.players[0].rail[0] = curve('mine');
    event.players[1].rail[1] = curve('target-a');
    event.players[2].rail[7] = curve('target-b');
    await setState(event);
    assert.equal(await page.locator('.sabotage-card.disabled button').count(), 0);
    await page.locator('.sabotage-card.usable button').click();
    await page.getByLabel('対象プレイヤー：', { exact: true }).selectOption('p2');
    assert.equal(await page.getByLabel('相手のパーツ：', { exact: true }).inputValue(), '7', 'changing target discards the previous target slot');
    assert.equal(await page.evaluate(() => sabotagePlayParams.targetSlot), 7);
    await page.screenshot({ path: path.join(output, 'event-desktop.png'), fullPage: true, animations: 'disabled' });
    event.sabotageTurnPlayerId = 'p1';
    await setState(event);
    assert.equal(await page.locator('#myControls button').count(), 0, 'spectators cannot submit event cards');

    const recovery = structuredClone(base);
    recovery.phase = 'recovery'; recovery.recoveryTurnPlayerId = 'p0';
    recovery.players[0].recoveryTasks = [{ id: 'task', type: 'swapped', slot: 0, drawnCards: [curve('r1'), brake] }];
    await setState(recovery);
    await page.locator('#myControls .card-option').first().click();
    assert(await page.getByRole('button', { name: 'このパーツを設置する', exact: true }).isDisabled());
    await page.getByRole('button', { name: 'マス2に設置', exact: true }).click();
    assert(await page.getByRole('button', { name: 'このパーツを設置する', exact: true }).isEnabled());
    recovery.players[0].recoveryTasks[0].type = 'destroyed';
    await setState(recovery);
    assert.equal(await page.getByRole('button', { name: '設置しない（見送る）', exact: true }).count(), 0, 'destroyed slots require recovery');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'recovery-mobile.png'), fullPage: true, animations: 'disabled' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log('PASS: 4 players / 16 slots, 320–1280px, brake setting, reduced motion, event legality/target changes, recovery requirements.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
