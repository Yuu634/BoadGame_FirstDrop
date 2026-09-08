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
    this.sabotageDeck = [];
    this.sabotageTurnIndex = 0; // 妨害フェイズは全員同時ではなく、プレイヤーごとに順番に行う
    this.recoveryTurnIndex = 0; // 復旧フェイズも同様に順番に行う（タスクがあるプレイヤーだけ）
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
      customers: [], // 客層は妨害（交換・出禁）により内容がプレイヤーごとに異なりうるため、個別に保持する
      bannedCustomerTypes: new Set(),
      sabotageHand: [],
      sabotageSubmitted: false,
      pendingSabotageChoices: [], // 他プレイヤーから受けた妨害のうち、自分が対応（選択）する必要があるもの
      recoveryTasks: [], // 妨害で破壊・交換されたパーツの復旧待ちタスク
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
    this.sabotageDeck = C.buildSabotageDeck();
    for (const p of this.players) {
      p.rail = new Array(this.settings.railSize).fill(null);
      p.hand = [];
      p.draftPacket = [];
      p.pendingPick = null;
      p.placedThisRound = false;
      p.customers = [];
      p.bannedCustomerTypes = new Set();
      p.sabotageHand = [];
      p.sabotageSubmitted = false;
      p.pendingSabotageChoices = [];
      p.recoveryTasks = [];
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
    this.sabotageDeck = [];
    for (const p of this.players) {
      p.rail = new Array(this.settings.railSize).fill(null);
      p.hand = [];
      p.draftPacket = [];
      p.pendingPick = null;
      p.placedThisRound = false;
      p.customers = [];
      p.bannedCustomerTypes = new Set();
      p.sabotageHand = [];
      p.sabotageSubmitted = false;
      p.pendingSabotageChoices = [];
      p.recoveryTasks = [];
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
    // ① 客層公開（「客層出禁」の効果を受けているプレイヤーには、そのタイプの客層は公開されない＝その回はスキップ）
    const cust = this.customerDeck.shift();
    cust.satisfaction = 0;
    cust.everReset = false;
    this.revealedCustomers.push(cust);
    this.addLog(`ラウンド${this.round}：客層「${cust.name}」(スリル耐性${cust.durability}) が公開されました`);
    for (const p of this.players) {
      if (p.bannedCustomerTypes.has(cust.typeKey)) {
        this.addLog(`${p.name} は客層「${cust.name}」が出禁のため、今回は公開されません`);
        continue;
      }
      p.customers.push({ ...cust });
    }

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
    // パーツ設置フェイズの後は、（次ラウンドや試運転に進む前に）毎ラウンド必ず妨害フェイズに入る
    this.startSabotagePhase();
  }

  // ---------- 妨害フェイズ（全員同時ではなく、プレイヤーごとに順番に行う） ----------
  startSabotagePhase() {
    this.phase = 'sabotage';
    this.sabotageTurnIndex = 0;
    for (const p of this.players) {
      p.sabotageSubmitted = false;
      p.pendingSabotageChoices = [];
      p.sabotageHand = this.drawSabotageCards(2);
    }
    this.addLog(`ラウンド${this.round}：配置完了。妨害フェイズです（妨害カードが2枚ずつ配られました）。${this.players[0].name} の妨害ターンです`);
  }

  drawSabotageCards(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (this.sabotageDeck.length === 0) this.sabotageDeck = C.buildSabotageDeck();
      out.push(this.sabotageDeck.shift());
    }
    return out;
  }

  drawGeneralCards(n) {
    const out = [];
    for (let i = 0; i < n && this.generalDeck.length; i++) out.push(this.generalDeck.shift());
    return out;
  }

  drawReplacementCustomer() {
    if (this.customerDeck.length) return this.customerDeck.shift();
    const t = C.CUSTOMER_TYPES[Math.floor(Math.random() * C.CUSTOMER_TYPES.length)];
    return { id: C.nextId('cust'), typeKey: t.key, name: t.name, durability: t.durability, skillDesc: t.skillDesc };
  }

  submitSabotage(playerId, plays) {
    if (this.phase !== 'sabotage') throw new Error('妨害フェイズではありません');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('プレイヤーが見つかりません');
    const current = this.players[this.sabotageTurnIndex];
    if (!current || current.id !== playerId) throw new Error('あなたの妨害ターンではありません');
    if (p.sabotageSubmitted) throw new Error('すでに提出済みです');
    if (!Array.isArray(plays)) throw new Error('不正な入力です');
    if (plays.length > 1) throw new Error('妨害カードは1枚のみ使用できます');

    const usedCardIds = new Set();
    for (const play of plays) {
      if (usedCardIds.has(play.cardId)) throw new Error('同じカードを2回使うことはできません');
      usedCardIds.add(play.cardId);
      const card = p.sabotageHand.find((c) => c.id === play.cardId);
      if (!card) throw new Error('手元にない妨害カードです');
      const target = play.targetPlayerId ? this.getPlayer(play.targetPlayerId) : null;
      if (!target) throw new Error('対象プレイヤーを指定してください');
      if (target.id === p.id) throw new Error('自分自身を対象にはできません');
      // 1枚適用するたびに手札から取り除く：複数枚の同時提出中に片方が別方の状態を変えて
      // もう片方が無効になるケースがあっても、成功した分だけは確定させ、二重適用を防ぐ
      this.applySabotageCard(p, target, card, play);
      p.sabotageHand = p.sabotageHand.filter((c) => c.id !== card.id);
    }
    p.sabotageHand = [];
    p.sabotageSubmitted = true;
    this.addLog(`${p.name} が妨害カードを${plays.length}枚使用しました`);
    this.checkAdvanceSabotage();
  }

  applySabotageCard(caster, target, card, play) {
    switch (card.type) {
      case 'custRandomSwap':
        this.queueSabotageChoice(target, caster, card, 'custRandomSwap');
        break;
      case 'custMutualSwap': {
        const myIdx = Number(play.myIndex);
        const targetIdx = Number(play.targetIndex);
        if (!Number.isInteger(myIdx) || myIdx < 0 || myIdx >= caster.customers.length) throw new Error('自分の客層の指定が不正です');
        if (!Number.isInteger(targetIdx) || targetIdx < 0 || targetIdx >= target.customers.length) throw new Error('相手の客層の指定が不正です');
        const tmp = caster.customers[myIdx];
        caster.customers[myIdx] = target.customers[targetIdx];
        target.customers[targetIdx] = tmp;
        this.addLog(`${caster.name} が ${target.name} と客層を交換しました`);
        break;
      }
      case 'custBanType': {
        const typeKey = play.typeKey;
        const typeDef = C.CUSTOMER_TYPES.find((t) => t.key === typeKey);
        if (!typeDef) throw new Error('客層タイプの指定が不正です');
        target.bannedCustomerTypes.add(typeKey);
        this.addLog(`${caster.name} が ${target.name} に客層「${typeDef.name}」の出禁を宣告しました`);
        break;
      }
      case 'partDestroy':
        this.queueSabotageChoice(target, caster, card, 'partDestroy');
        break;
      case 'partSwap': {
        const mySlot = Number(play.mySlot);
        const targetSlot = Number(play.targetSlot);
        if (!Number.isInteger(mySlot) || mySlot < 0 || mySlot >= caster.rail.length || !caster.rail[mySlot]) throw new Error('自分のパーツの指定が不正です');
        if (!Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot >= target.rail.length || !target.rail[targetSlot]) throw new Error('相手のパーツの指定が不正です');
        const tmp = caster.rail[mySlot];
        caster.rail[mySlot] = target.rail[targetSlot];
        target.rail[targetSlot] = tmp;
        this.queueRecoveryTask(caster, 'swapped', mySlot);
        this.queueRecoveryTask(target, 'swapped', targetSlot);
        this.addLog(`${caster.name} が ${target.name} とパーツを交換しました`);
        break;
      }
      case 'partLevelDown': {
        const slot = Number(play.targetSlot);
        if (!Number.isInteger(slot) || slot < 0 || slot >= target.rail.length) throw new Error('マスの指定が不正です');
        const tCard = target.rail[slot];
        if (!tCard || (tCard.kind !== 'climb' && tCard.kind !== 'drop')) throw new Error('巻上または落下パーツを指定してください');
        if (tCard.value > 2) {
          tCard.value -= 1;
          tCard.label = `${tCard.kind === 'climb' ? '巻上' : '落下'}Lv${tCard.value}`;
          this.addLog(`${caster.name} が ${target.name} の${tCard.label}に下げました`);
        } else {
          target.rail[slot] = null;
          this.queueRecoveryTask(target, 'destroyed', slot);
          this.addLog(`${caster.name} が ${target.name} のパーツを破壊しました（これ以上レベルを下げられないため）`);
        }
        break;
      }
      default:
        throw new Error('不明な妨害カードです');
    }
  }

  queueSabotageChoice(target, caster, card, type) {
    target.pendingSabotageChoices.push({
      id: C.nextId('choice'),
      type,
      casterId: caster.id,
      casterName: caster.name,
      cardLabel: card.label,
    });
    this.addLog(`${caster.name} が ${target.name} に「${card.label}」を使用しました。${target.name} の対応待ちです`);
  }

  resolveSabotageChoice(playerId, payload) {
    if (this.phase !== 'sabotage') throw new Error('妨害フェイズではありません');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('プレイヤーが見つかりません');
    payload = payload || {};
    const idx = p.pendingSabotageChoices.findIndex((c) => c.id === payload.choiceId);
    if (idx === -1) throw new Error('対応すべき妨害がありません');
    const choice = p.pendingSabotageChoices[idx];

    if (choice.type === 'custRandomSwap') {
      const custIdx = Number(payload.customerIndex);
      if (!Number.isInteger(custIdx) || custIdx < 0 || custIdx >= p.customers.length) throw new Error('客層の指定が不正です');
      p.customers[custIdx] = this.drawReplacementCustomer();
      this.addLog(`${p.name} が客層を入れ替えました（${choice.casterName} の効果）`);
    } else if (choice.type === 'partDestroy') {
      const slot = Number(payload.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= p.rail.length || !p.rail[slot]) throw new Error('マスの指定が不正です');
      p.rail[slot] = null;
      this.queueRecoveryTask(p, 'destroyed', slot);
      this.addLog(`${p.name} のパーツが破壊されました（${choice.casterName} の効果）`);
    }

    p.pendingSabotageChoices.splice(idx, 1);
    this.checkAdvanceSabotage();
  }

  checkAdvanceSabotage() {
    if (this.phase !== 'sabotage') return;
    // 現在の手番プレイヤーが誰かを狙った妨害の「対象側の選択」が残っている間は、手番を進めない
    const anyPending = this.players.some((p) => p.pendingSabotageChoices.length > 0);
    if (anyPending) return;
    const current = this.players[this.sabotageTurnIndex];
    if (!current || !current.sabotageSubmitted) return; // 現在の手番プレイヤーがまだ提出していない
    this.sabotageTurnIndex += 1;
    if (this.sabotageTurnIndex >= this.players.length) {
      const anyRecovery = this.players.some((p) => p.recoveryTasks.length > 0);
      if (anyRecovery) {
        this.startRecoveryPhase();
      } else {
        this.afterSabotageAndRecoveryComplete();
      }
    } else {
      this.addLog(`${this.players[this.sabotageTurnIndex].name} の妨害ターンです`);
    }
  }

  // ---------- 復旧フェイズ（タスクがあるプレイヤーだけ、順番に行う） ----------
  startRecoveryPhase() {
    this.phase = 'recovery';
    this.recoveryTurnIndex = 0;
    this.addLog('妨害フェイズ終了。復旧フェイズに入ります');
    this.advanceToNextRecoveryPlayer();
  }

  advanceToNextRecoveryPlayer() {
    while (this.recoveryTurnIndex < this.players.length && this.players[this.recoveryTurnIndex].recoveryTasks.length === 0) {
      this.recoveryTurnIndex += 1;
    }
    if (this.recoveryTurnIndex >= this.players.length) {
      this.afterSabotageAndRecoveryComplete();
    } else {
      this.addLog(`${this.players[this.recoveryTurnIndex].name} の復旧ターンです`);
    }
  }

  queueRecoveryTask(player, type, slot) {
    let drawn = this.drawGeneralCards(3);
    if (type === 'destroyed') {
      // 3枚とも安全装置作動の場合のみもう3枚引く
      let attempts = 0;
      while (attempts < 5 && drawn.length && drawn.every((c) => this.wouldTriggerSafety(player.rail, slot, c))) {
        drawn = this.drawGeneralCards(3);
        attempts++;
      }
    }
    player.recoveryTasks.push({ id: C.nextId('recovery'), type, slot, drawnCards: drawn, resolved: false });
  }

  // 指定のマスにカードを置いたら安全装置が即座に作動するかどうかを、既に確定しているそれ以前のマスから簡易シミュレーションして判定する
  wouldTriggerSafety(rail, slot, card) {
    let altitude = 2;
    let speed = 2;
    for (let i = 0; i < slot; i++) {
      const c = rail[i];
      if (!c) continue;
      const isClimb = c.kind === 'climb';
      const isDrop = c.kind === 'drop';
      const type = isClimb ? 'climb' : isDrop ? 'drop' : c.type;
      const isBrake = type === 'brake';
      const entrySpeed = speed;
      if (!isClimb && !isDrop && !isBrake) speed = Math.max(0, speed - 1);
      if (isClimb) {
        altitude += c.value;
        speed = 0;
      } else if (isDrop) {
        if (altitude >= c.value) { altitude -= c.value; speed += c.value; } else { speed = 0; }
      } else if (type === 'loop') {
        if (!(entrySpeed === 3 || entrySpeed === 4)) speed = 0;
      } else if (type === 'airtime') {
        if (!(entrySpeed === 2 || entrySpeed === 3)) speed = 0;
      } else if (type === 'twist') {
        if (!(entrySpeed === 1 || entrySpeed === 2)) speed = 0;
      } else if (type === 'brake') {
        const desired = Number.isFinite(c.brakeReduce) ? c.brakeReduce : 0;
        const actualReduce = Math.max(0, Math.min(entrySpeed, desired));
        speed = entrySpeed - actualReduce;
      }
    }
    const isClimb = card.kind === 'climb';
    const isDrop = card.kind === 'drop';
    const type = isClimb ? 'climb' : isDrop ? 'drop' : card.type;
    const entrySpeed = speed;
    if (isClimb) return false;
    if (isDrop) return altitude < card.value;
    if (type === 'loop') return !(entrySpeed === 3 || entrySpeed === 4);
    if (type === 'airtime') return !(entrySpeed === 2 || entrySpeed === 3);
    if (type === 'twist') return !(entrySpeed === 1 || entrySpeed === 2);
    return false;
  }

  resolveRecovery(playerId, payload) {
    if (this.phase !== 'recovery') throw new Error('復旧フェイズではありません');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('プレイヤーが見つかりません');
    const current = this.players[this.recoveryTurnIndex];
    if (!current || current.id !== playerId) throw new Error('あなたの復旧ターンではありません');
    payload = payload || {};
    const idx = p.recoveryTasks.findIndex((t) => t.id === payload.taskId && !t.resolved);
    if (idx === -1) throw new Error('対象の復旧タスクが見つかりません');
    const task = p.recoveryTasks[idx];

    if (payload.cardId) {
      const card = task.drawnCards.find((c) => c.id === payload.cardId);
      if (!card) throw new Error('引いたカードの中にありません');
      let targetSlot;
      if (task.type === 'destroyed') {
        targetSlot = task.slot;
        if (p.rail[targetSlot]) throw new Error('そのマスはすでに埋まっています');
      } else {
        const pos = payload.position;
        if (pos !== 'before' && pos !== 'after') throw new Error('位置を指定してください（前 or 後）');
        targetSlot = pos === 'before' ? task.slot - 1 : task.slot + 1;
        if (targetSlot < 0 || targetSlot >= p.rail.length) throw new Error('その位置にはマスがありません');
        if (p.rail[targetSlot]) throw new Error('そのマスはすでに埋まっています');
      }
      if (card.kind === 'part' && card.type === 'brake') {
        const raw = Number(payload.brakeReduce);
        card.brakeReduce = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
      }
      p.rail[targetSlot] = card;
      this.addLog(`${p.name} が復旧フェイズでマス${targetSlot + 1}に${card.label}を設置しました`);
    } else {
      this.addLog(`${p.name} は復旧を見送りました`);
    }

    task.resolved = true;
    p.recoveryTasks.splice(idx, 1);
    if (p.recoveryTasks.length === 0) {
      this.recoveryTurnIndex += 1;
      this.advanceToNextRecoveryPlayer();
    }
  }

  afterSabotageAndRecoveryComplete() {
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
    // 客層は妨害（交換・出禁）によりプレイヤーごとに内容が異なりうるため、共有のrevealedCustomersではなく個別のp.customersを使う
    const customers = p.customers.map((c) => ({
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
        if (entrySpeed === 3 || entrySpeed === 4) { thrill = 4; } else { safety = true; }
      } else if (type === 'airtime') {
        if (entrySpeed === 2 || entrySpeed === 3) { thrill = 3; } else { safety = true; }
      } else if (type === 'twist') {
        if (entrySpeed === 1 || entrySpeed === 2) { thrill = 2; } else { safety = true; }
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
    const allThrillAtMost2 = thrillHistory.length > 0 && thrillHistory.every((t) => t <= 2);

    for (const cust of customers) {
      let achieved = false;
      let bonus = 0;
      switch (cust.typeKey) {
        case 'elder':
          achieved = allThrillAtMost2;
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
      customers: p.customers,
      bannedCustomerTypes: Array.from(p.bannedCustomerTypes),
      sabotageHand: p.sabotageHand,
      sabotageSubmitted: p.sabotageSubmitted,
      pendingSabotageChoices: p.pendingSabotageChoices,
      recoveryTasks: p.recoveryTasks,
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
      sabotageTurnPlayerId: this.phase === 'sabotage' && this.players[this.sabotageTurnIndex] ? this.players[this.sabotageTurnIndex].id : null,
      recoveryTurnPlayerId: this.phase === 'recovery' && this.players[this.recoveryTurnIndex] ? this.players[this.recoveryTurnIndex].id : null,
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
