'use strict';

const C = require('./gameConstants');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GameRoom {
  constructor(id) {
    this.id = id;
    this.players = []; // ordered array, order = seating/draft order
    this.phase = 'lobby'; // lobby | draft | placement | trial | finished
    this.round = 0;
    this.hostId = null;
    this.log = [];
    this.draftSubStep = 0; // 0,1 = pick steps, packets size 3->2->1
    this.customerDeck = [];
    this.revealedCustomers = [];
    this.generalDeck = [];
    this.trialResults = [];
    this.trialStarted = false; // 試運転フェイズの二重実行防止ガード
    this.settings = { ...C.DEFAULT_SETTINGS };
    this.rounds = this.settings.railSize / 2;
    this.activeRecords = [];
    this.recordResults = [];
  }

  addLog(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 300) this.log.shift();
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  addPlayer(id, name) {
    if (this.phase !== 'lobby') throw new Error('ゲームはすでに開始されています');
    if (this.players.length >= 4) throw new Error('満員です（最大4人）');
    const player = {
      id,
      name,
      connected: true,
      rail: new Array(this.settings.railSize).fill(null),
      hand: [],
      draftPacket: [],
      pendingPick: null,
      placedThisRound: false,
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = id;
    this.addLog(`${name} が参加しました`);
    return player;
  }

  removePlayer(id) {
    const p = this.getPlayer(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((pl) => pl.id !== id);
      if (this.hostId === id) this.hostId = this.players[0] ? this.players[0].id : null;
    } else {
      p.connected = false;
    }
  }

  canStart() {
    return this.phase === 'lobby' && this.players.length >= 2 && this.players.length <= 4;
  }

  // ---------- ルール設定（ロビーでホストのみ変更可） ----------
  updateSettings(playerId, patch) {
    if (this.hostId !== playerId) throw new Error('ホストのみ設定を変更できます');
    if (this.phase !== 'lobby') throw new Error('ロビーでのみ設定を変更できます');
    patch = patch || {};
    const next = { ...this.settings };
    if (patch.railSize !== undefined) {
      const v = Number(patch.railSize);
      if (!C.RAIL_SIZE_OPTIONS.includes(v)) throw new Error('レール設置枚数は8か16のみ指定できます');
      next.railSize = v;
    }
    if (patch.endAltitudeZeroBonus !== undefined) next.endAltitudeZeroBonus = !!patch.endAltitudeZeroBonus;
    if (patch.recordsEnabled !== undefined) next.recordsEnabled = !!patch.recordsEnabled;
    this.settings = next;
    // レール枚数が変わったら、ロビー中のプレイヤーのレール配列も合わせておく
    for (const p of this.players) {
      p.rail = new Array(this.settings.railSize).fill(null);
    }
    this.addLog(`ルール設定を変更しました（レール${this.settings.railSize}マス／着地ボーナス${this.settings.endAltitudeZeroBonus ? '有' : '無'}／記録更新${this.settings.recordsEnabled ? '有' : '無'}）`);
  }

  startGame() {
    if (!this.canStart()) throw new Error('開始条件を満たしていません（2〜4人必要）');
    this.trialStarted = false;
    this.trialResults = [];
    this.winners = null;
    this.round = 0;
    this.rounds = this.settings.railSize / 2;
    this.revealedCustomers = [];
    this.customerDeck = C.buildCustomerDeck();
    this.activeRecords = this.settings.recordsEnabled ? C.pickRecords(2) : [];
    this.recordResults = [];
    // レールが長いほど必要な札数も増えるため、レール16マス設定時は山札を2セット分用意する
    const deckMultiplier = this.settings.railSize / C.RAIL_SIZE;
    let generalDeck = [];
    for (let i = 0; i < deckMultiplier; i++) {
      generalDeck = generalDeck.concat(C.buildGeneralDeck(), C.buildClimbDeck(), C.buildDropDeck());
    }
    // 巻上・落下も一般パーツと同じ山札に混ぜてドラフトする（毎ラウンド確定で1枚ずつ引く仕組みは廃止）
    this.generalDeck = C.shuffle(generalDeck);
    for (const p of this.players) {
      p.rail = new Array(this.settings.railSize).fill(null);
      p.hand = [];
      p.draftPacket = [];
      p.pendingPick = null;
      p.placedThisRound = false;
    }
    this.addLog('ゲーム開始！');
    this.startRound();
  }

  // ---------- もう一度プレイ ----------
  resetToLobby(playerId) {
    if (this.hostId !== playerId) throw new Error('ホストのみ操作できます');
    this.phase = 'lobby';
    this.round = 0;
    this.revealedCustomers = [];
    this.trialResults = [];
    this.winners = null;
    this.trialStarted = false;
    this.customerDeck = [];
    this.generalDeck = [];
    this.draftSubStep = 0;
    this.activeRecords = [];
    this.recordResults = [];
    for (const p of this.players) {
      p.rail = new Array(this.settings.railSize).fill(null);
      p.hand = [];
      p.draftPacket = [];
      p.pendingPick = null;
      p.placedThisRound = false;
    }
    this.addLog('ロビーに戻りました。ホストがゲームを再開できます');
  }

  startRound() {
    this.round += 1;
    this.phase = 'draft';
    this.draftSubStep = 0;
    for (const p of this.players) {
      p.pendingPick = null;
      p.placedThisRound = false;
      p.hand = [];
    }
    // ① 客層公開
    const cust = this.customerDeck.shift();
    cust.satisfaction = 0;
    cust.everReset = false;
    this.revealedCustomers.push(cust);
    this.addLog(`ラウンド${this.round}：客層「${cust.name}」(スリル耐性${cust.durability}) が公開されました`);

    // ドラフト開始：各3枚配布（巻上・落下も一般パーツと同じ山札から出てくる）
    for (const p of this.players) {
      p.draftPacket = [];
      for (let i = 0; i < 3 && this.generalDeck.length; i++) {
        p.draftPacket.push(this.generalDeck.shift());
      }
    }
    this.addLog('一般パーツがドラフトに配られました');
  }

  allSubmittedDraft() {
    return this.players.every((p) => p.pendingPick || p.draftPacket.length === 0);
  }

  handleDraftPick(playerId, cardId) {
    if (this.phase !== 'draft') throw new Error('ドラフト中ではありません');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('プレイヤーが見つかりません');
    if (p.pendingPick) throw new Error('すでに選択済みです');
    const idx = p.draftPacket.findIndex((c) => c.id === cardId);
    if (idx === -1) throw new Error('そのカードは選べません');
    p.pendingPick = cardId;
    if (this.allSubmittedDraft()) {
      this.resolveDraftStep();
    }
  }

  resolveDraftStep() {
    const n = this.players.length;
    const passed = new Array(n).fill(null); // remaining packet to pass left

    this.players.forEach((p, i) => {
      if (p.pendingPick) {
        const idx = p.draftPacket.findIndex((c) => c.id === p.pendingPick);
        const [card] = p.draftPacket.splice(idx, 1);
        p.hand.push(card);
      }
      passed[i] = p.draftPacket; // remaining cards (could be empty on final auto step)
      p.pendingPick = null;
    });

    // pass to left neighbor: player i receives packet from player i-1 (i.e. player i-1's leftover goes to player i)
    // "left" = next player in turn order receives it
    this.players.forEach((p, i) => {
      const fromIdx = (i - 1 + n) % n;
      p.draftPacket = passed[fromIdx];
    });

    this.draftSubStep += 1;

    if (this.draftSubStep === 2) {
      // final step: everyone just auto-receives the single remaining card, no pick needed
      this.players.forEach((p) => {
        if (p.draftPacket.length === 1) {
          p.hand.push(p.draftPacket.shift());
        }
      });
      this.finishDraft();
    } else if (this.draftSubStep > 2) {
      this.finishDraft();
    }
    // otherwise wait for next round of picks (packet size 2, then size1->auto handled above at step2)
  }

  finishDraft() {
    this.phase = 'placement';
    this.addLog(`ラウンド${this.round}：ドラフト終了。配置フェイズです`);
  }

  playerOptions(p) {
    return p.hand.slice();
  }

  validatePlacement(p, card, slot) {
    if (slot < 0 || slot >= this.settings.railSize) return '無効なマスです';
    if (p.rail[slot]) return 'そのマスはすでに埋まっています';
    return null;
  }

  handleSubmitPlacement(playerId, placements) {
    if (this.phase !== 'placement') throw new Error('配置フェイズではありません');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('プレイヤーが見つかりません');
    if (p.placedThisRound) throw new Error('すでに配置済みです');
    if (!Array.isArray(placements) || placements.length !== 2) throw new Error('2枚配置してください');

    const options = this.playerOptions(p);
    const usedSlots = new Set();
    const chosenCards = [];
    for (const pl of placements) {
      const card = options.find((c) => c.id === pl.cardId);
      if (!card) throw new Error('手元にないカードです');
      if (usedSlots.has(pl.slot)) throw new Error('同じマスに2枚は置けません');
      const err = this.validatePlacement(p, card, pl.slot, chosenCards);
      if (err) throw new Error(err);
      if (card.kind === 'part' && card.type === 'brake') {
        const raw = Number(pl.brakeReduce);
        card.brakeReduce = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
      }
      usedSlots.add(pl.slot);
      chosenCards.push(card);
    }

    // commit
    placements.forEach((pl, i) => {
      p.rail[pl.slot] = chosenCards[i];
    });

    const placedIds = new Set(chosenCards.map((c) => c.id));

    // どのラウンドでも、配置しなかったカードはすべて捨札になる（持ち越し不可）
    const leftover = p.hand.filter((c) => !placedIds.has(c.id));
    if (leftover.length) {
      this.addLog(`${p.name} は使わなかったカード${leftover.length}枚を捨てました`);
    }
    p.hand = [];

    p.placedThisRound = true;
    this.addLog(`${p.name} が配置を完了しました`);

    if (this.players.every((pl) => pl.placedThisRound)) {
      this.finishRound();
    }
  }

  finishRound() {
    if (this.round < this.rounds) {
      this.startRound();
    } else {
      // ここでは startTrialPhase() を直接呼ばない。
      // emitStep（結果通知）を渡せる server.js 側の runTrial() だけが
      // 試運転フェイズを開始できるように、フェイズ変更の合図だけを出す。
      // （直接呼ぶと二重実行防止ガードに阻まれ、誰にも結果が通知されないまま
      //   計算だけが行われてしまうバグの原因になっていた）
      this.phase = 'trial';
      this.addLog('全員のレールが完成しました。試運転フェイズに入ります');
    }
  }

  // ---------- 試運転フェイズ ----------
  async startTrialPhase(emitStep) {
    if (this.trialStarted) return; // 二重実行防止（同じゲームで2回結果が出るバグ対策）
    this.trialStarted = true;
    this.phase = 'trial';
    this.trialResults = [];
    for (const p of this.players) {
      const result = await this.runTrialForPlayer(p, emitStep);
      this.trialResults.push(result);
      await wait(400);
    }
    this.applyRecords();
    this.finalizeScores();
    this.phase = 'finished';
  }

  async runTrialForPlayer(p, emitStep) {
    let altitude = 2;
    let speed = 2;
    const customers = this.revealedCustomers.map((c) => ({
      id: c.id,
      typeKey: c.typeKey,
      name: c.name,
      durability: c.durability,
      satisfaction: 0,
      everReset: false,
    }));
    const thrillHistory = [];
    const partTypesSeen = new Set();
    const history = []; // per-slot score deltas, used for the result-reveal animation
    let tunnelCount = 0;
    let totalDropHeight = 0; // 成功した落下カードの高低差の合計（記録更新「落下高低差記録」用）
    let runFrozen = false; // 安全装置が一度でも作動したら、以降スコアは固定される
    let maxSpeed = speed;
    let maxAltitude = altitude;
    let frozenAltitude = altitude; // 安全装置作動時点（なければ最終マス時点）の高度。終了時高度0ボーナスの判定に使う
    const railSize = this.settings.railSize;

    for (let slot = 0; slot < railSize; slot++) {
      const card = p.rail[slot];
      if (!card) {
        if (!runFrozen) thrillHistory.push(0);
        history.push({ slot, cardLabel: null, perCustomer: [], totalDelta: 0 });
        if (emitStep) emitStep(p.id, { slot, card: null, altitude, speed, thrill: 0, safety: false, customers: customers.map((c) => ({ ...c })) });
        continue;
      }
      const isClimb = card.kind === 'climb';
      const isDrop = card.kind === 'drop';
      const type = isClimb ? 'climb' : isDrop ? 'drop' : card.type;
      const isBrake = type === 'brake';

      // 進入時の速度（このマス自体の減速が起こる前の値）
      const entrySpeed = speed;

      // 巻上・落下・ブレーキ以外は、このマスで速度-1
      // （ブレーキは「下げる量」を自分で完全に指定するため、隠れた自動減速は発生しない）
      if (!isClimb && !isDrop && !isBrake) {
        speed = Math.max(0, speed - 1);
      }

      // パーツ効果
      let thrill = 0;
      let safety = false;

      if (isClimb) {
        altitude += card.value;
        speed = 0;
        thrill = 0;
      } else if (isDrop) {
        if (altitude >= card.value) {
          altitude -= card.value;
          speed += card.value;
          thrill = card.value;
        } else {
          // 高度不足：安全装置作動
          safety = true;
        }
      } else if (type === 'loop') {
        if (entrySpeed === 4) { thrill = 4; } else { safety = true; }
      } else if (type === 'airtime') {
        if (entrySpeed === 3) { thrill = 3; } else { safety = true; }
      } else if (type === 'twist') {
        if (entrySpeed === 2) { thrill = 2; } else { safety = true; }
      } else if (type === 'curve') {
        thrill = 1;
      } else if (type === 'tunnel') {
        // トンネルも速度-1。進入時の速度がそのままスリル値になる（速いほど高スリル）
        thrill = entrySpeed;
      } else if (type === 'brake') {
        // 配置時にあらかじめ決めた「下げる量」を、進入時の速度からそのまま引く
        const desired = Number.isFinite(card.brakeReduce) ? card.brakeReduce : 0;
        const actualReduce = Math.max(0, Math.min(entrySpeed, desired));
        thrill = actualReduce; // 下げた分がそのままスリル値
        speed = entrySpeed - actualReduce;
      }

      if (safety) {
        thrill = 0;
        speed = 0;
      }

      // Step3: satisfaction judgment（安全装置が作動した時点で、以降は全員スコア固定）
      // 客層のボーナス条件（記録更新も含む）は、安全装置作動より前のマスだけを対象に計算する
      const skipScoring = runFrozen || safety;
      if (!skipScoring) {
        thrillHistory.push(thrill);
        partTypesSeen.add(type);
        if (type === 'tunnel') tunnelCount++;
        if (isDrop) totalDropHeight += card.value;
        maxSpeed = Math.max(maxSpeed, entrySpeed, speed);
        maxAltitude = Math.max(maxAltitude, altitude);
      }
      const perCustomer = [];
      let totalDelta = 0;
      for (const cust of customers) {
        if (skipScoring) {
          perCustomer.push({ customerId: cust.id, name: cust.name, delta: 0, satisfactionAfter: cust.satisfaction });
          continue;
        }
        const before = cust.satisfaction;
        if (thrill === cust.durability) {
          cust.satisfaction += thrill + C.JUST_MATCH_BONUS;
        } else if (thrill < cust.durability) {
          cust.satisfaction += thrill;
        } else {
          cust.satisfaction = Math.max(0, cust.satisfaction - C.OVER_MATCH_PENALTY);
        }
        const delta = cust.satisfaction - before;
        totalDelta += delta;
        perCustomer.push({ customerId: cust.id, name: cust.name, delta, satisfactionAfter: cust.satisfaction });
      }
      if (safety) {
        runFrozen = true;
        frozenAltitude = altitude;
        for (const cust of customers) cust.everReset = true;
      } else if (!runFrozen) {
        frozenAltitude = altitude;
      }
      history.push({ slot, cardLabel: card.label || null, perCustomer, totalDelta });

      if (emitStep) {
        emitStep(p.id, {
          slot,
          card,
          altitude,
          speed,
          thrill,
          safety,
          customers: customers.map((c) => ({ ...c })),
        });
      }
    }

    // skills（安全装置作動より前のマスだけを対象に集計したthrillHistory等を使う）
    const skills = [];
    let skillTotal = 0;
    const maxThrill = thrillHistory.length ? Math.max(...thrillHistory) : 0;
    let has3Consecutive = false;
    for (let i = 0; i + 2 < thrillHistory.length; i++) {
      if (thrillHistory[i] < thrillHistory[i + 1] && thrillHistory[i + 1] < thrillHistory[i + 2]) has3Consecutive = true;
    }
    const thrill4PlusCount = thrillHistory.filter((t) => t >= 4).length;
    const allThrillAtMost1 = thrillHistory.length > 0 && thrillHistory.every((t) => t <= 1);

    for (const cust of customers) {
      let achieved = false;
      let bonus = 0;
      switch (cust.typeKey) {
        case 'elder':
          achieved = allThrillAtMost1;
          bonus = achieved ? 15 : 0;
          break;
        case 'family':
          achieved = partTypesSeen.size >= 5;
          bonus = achieved ? 10 : 0;
          break;
        case 'schoolTrip':
          achieved = has3Consecutive;
          bonus = achieved ? 10 : 0;
          break;
        case 'streamer':
          achieved = thrillHistory.length > 0 && thrillHistory[thrillHistory.length - 1] === maxThrill;
          bonus = achieved ? 12 : 0;
          break;
        case 'couple':
          achieved = tunnelCount > 0;
          bonus = tunnelCount * 4;
          break;
        case 'thrillSeeker':
          achieved = thrill4PlusCount >= 3;
          bonus = achieved ? 12 : 0;
          break;
      }
      skills.push({ customerId: cust.id, name: cust.name, typeKey: cust.typeKey, achieved, bonus });
      skillTotal += bonus;
    }

    // 終了時高度0ボーナス（設定でONの場合のみ）：安全装置作動時点（なければ最終マス時点）の高度が0なら加算
    let endAltitudeBonus = 0;
    if (this.settings.endAltitudeZeroBonus && frozenAltitude === 0) {
      endAltitudeBonus = C.END_ALTITUDE_ZERO_BONUS_POINTS;
      skillTotal += endAltitudeBonus;
    }

    const satisfactionTotal = customers.reduce((s, c) => s + c.satisfaction, 0);
    const neverResetCount = customers.filter((c) => !c.everReset).length;
    // 記録更新「満足度記録」：自分の客のうち最も満足度が高い1人だけを使う（客4人の合計ではない）
    const maxCustomerSatisfaction = customers.length ? Math.max(...customers.map((c) => c.satisfaction)) : 0;

    return {
      playerId: p.id,
      name: p.name,
      customers,
      satisfactionTotal,
      skills,
      skillTotal,
      total: satisfactionTotal + skillTotal,
      neverResetCount,
      history,
      endAltitudeBonus,
      // 記録更新（最高速度／最高高度／満足度／落下高低差）判定用の生データ
      maxSpeed,
      maxAltitude,
      maxCustomerSatisfaction,
      totalDropHeight,
      records: [],
    };
  }

  // ---------- 記録更新（毎ゲームランダムに2項目、全プレイヤー中の最高記録を更新した人にボーナス） ----------
  applyRecords() {
    this.recordResults = [];
    for (const rec of this.activeRecords) {
      const values = this.trialResults.map((r) => ({ playerId: r.playerId, name: r.name, value: r[rec.key] || 0 }));
      const maxVal = values.length ? Math.max(...values.map((v) => v.value)) : 0;
      if (maxVal <= 0) {
        this.recordResults.push({ key: rec.key, label: rec.label, bonus: rec.bonus, value: 0, winners: [] });
        continue;
      }
      const winners = values.filter((v) => v.value === maxVal);
      winners.forEach((w) => {
        const result = this.trialResults.find((r) => r.playerId === w.playerId);
        result.skillTotal += rec.bonus;
        result.total += rec.bonus;
        result.records.push({ key: rec.key, label: rec.label, value: maxVal, bonus: rec.bonus });
      });
      this.recordResults.push({ key: rec.key, label: rec.label, bonus: rec.bonus, value: maxVal, winners: winners.map((w) => w.name) });
      this.addLog(`🏅 ${rec.label}（${maxVal}${rec.unit}）：${winners.map((w) => w.name).join('・')} が記録更新！ +${rec.bonus}`);
    }
  }

  finalizeScores() {
    const sorted = [...this.trialResults].sort((a, b) => b.total - a.total || b.neverResetCount - a.neverResetCount);
    if (sorted.length) {
      const top = sorted[0];
      const winners = sorted.filter((r) => r.total === top.total && r.neverResetCount === top.neverResetCount);
      this.winners = winners.map((w) => w.name);
    }
    this.addLog(`満足度計算完了。勝者：${(this.winners || []).join(' / ')}`);
  }

  // ---------- state serialization ----------
  publicPlayerView(p) {
    return {
      id: p.id,
      name: p.name,
      connected: p.connected,
      rail: p.rail,
      hand: p.hand,
      placedThisRound: p.placedThisRound,
      hasPendingPick: !!p.pendingPick,
      draftPacketCount: p.draftPacket.length,
    };
  }

  stateFor(playerId) {
    const me = this.getPlayer(playerId);
    return {
      roomId: this.id,
      phase: this.phase,
      round: this.round,
      rounds: this.rounds,
      hostId: this.hostId,
      settings: this.settings,
      activeRecords: this.activeRecords,
      recordResults: this.recordResults,
      players: this.players.map((p) => this.publicPlayerView(p)),
      revealedCustomers: this.revealedCustomers,
      customerDeckCount: this.customerDeck.length,
      generalDeckCount: this.generalDeck.length,
      myDraftPacket: me ? me.draftPacket : [],
      myId: playerId,
      log: this.log.slice(-50),
      winners: this.winners || null,
      trialResults: this.trialResults,
    };
  }
}

module.exports = GameRoom;
