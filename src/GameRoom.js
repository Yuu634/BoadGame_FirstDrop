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
    this.sabotageOrder = [];
    this.sabotageTurnIndex = 0; // イベントフェイズは全員同時ではなく、プレイヤーごとに順番に行う
    this.sabotageEvents = []; // イベントフェイズで「誰が誰に何をしたか」を画面中央に数秒表示するための通知
    this.sabotageOrder = []; // そのラウンドのイベントフェイズの実行順（レール配置位置の合計値が小さい人から順）
    this.recoveryTurnIndex = 0; // 復旧フェイズも同様に順番に行う（タスクがあるプレイヤーだけ）
  }

  addLog(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 300) this.log.shift();
  }

  // イベントフェイズの行為内容を記録する。
  // 見逃しを防ぐため、ポップアップ（画面中央に数秒）とログの両方に同じ内容を出す。
  // ここで両方まとめて処理することで、二つの文言がずれないようにする。
  pushSabotageEvent(text) {
    this.sabotageEvents.push({ id: C.nextId('sabevent'), t: Date.now(), text });
    if (this.sabotageEvents.length > 30) this.sabotageEvents.shift();
    this.addLog(`🎭 ${text}`);
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
      customers: [], // 客層は補助（交換・出禁）により内容がプレイヤーごとに異なりうるため、個別に保持する
      bannedCustomerTypes: new Set(),
      sabotageHand: [],
      sabotageSubmitted: false,
      pendingSabotageChoices: [], // 他プレイヤーから受けた補助のうち、自分が対応（選択）する必要があるもの
      recoveryTasks: [], // 補助で破壊・交換されたパーツの復旧待ちタスク
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
    if (patch.sabotageEnabled !== undefined) next.sabotageEnabled = !!patch.sabotageEnabled;
    this.settings = next;
    // レール枚数が変わったら、ロビー中のプレイヤーのレール配列も合わせておく
    for (const p of this.players) {
      p.rail = new Array(this.settings.railSize).fill(null);
    }
    this.addLog(`ルール設定を変更しました（レール${this.settings.railSize}マス／着地ボーナス${this.settings.endAltitudeZeroBonus ? '有' : '無'}／記録更新${this.settings.recordsEnabled ? '有' : '無'}／イベントモード${this.settings.sabotageEnabled ? '有' : '無'}）`);
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
    this.sabotageOrder = [];
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
    // ① 客層配布：全プレイヤー共通の1人ではなく、プレイヤーごとに別々の客層を配る。
    // （「客層出禁」の効果を受けているタイプはそのプレイヤーには配られず、その回はスキップされる）
    for (const p of this.players) {
      const cust = this.drawCustomerFor(p);
      if (!cust) {
        this.addLog(`${p.name} は出禁のため、今回は客層が配られませんでした`);
        continue;
      }
      cust.satisfaction = 0;
      cust.everReset = false;
      this.revealedCustomers.push(cust);
      p.customers.push(cust);
      this.addLog(`ラウンド${this.round}：${p.name} に客層「${cust.name}」(スリル耐性${cust.durability}) が配られました`);
    }

    // ドラフト開始：各3枚配布（巻上・落下も一般パーツと同じ山札から出てくる。同じプレイヤーの3枚内に重複が出ないようにする）
    for (const p of this.players) {
      p.draftPacket = this.drawUniqueCards(this.generalDeck, 3, this.generalCardSignature);
    }
    this.addLog('一般パーツがドラフトに配られました');
  }

  // 山札の先頭から順にcount枚引くが、同じ見た目（signatureFn）のカードが1回の配布内で重複しないようにする。
  // 重複としてスキップしたカードは山の底に戻すため、デッキ全体のカード総数は減らない。
  drawUniqueCards(deck, count, signatureFn) {
    const drawn = [];
    const skipped = [];
    const seen = new Set();
    while (drawn.length < count && deck.length) {
      const card = deck.shift();
      const sig = signatureFn(card);
      if (seen.has(sig)) {
        skipped.push(card);
      } else {
        seen.add(sig);
        drawn.push(card);
      }
    }
    if (skipped.length) deck.push(...skipped);
    return drawn;
  }

  generalCardSignature(card) {
    return `${card.kind}:${card.type || ''}:${card.value || ''}`;
  }

  sabotageCardSignature(card) {
    return card.type;
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
    // 補助カードでパーツを破壊されたプレイヤーは、本来置くべき枚数（ラウンド数×2）に追いつくのに
    // ドラフトの3枚では足りないことがある。その分だけ山札から補充し、
    // 全員が同じ設置枚数で試運転を迎えられるようにする。
    for (const p of this.players) {
      const alreadyPlaced = p.rail.filter((c) => c).length;
      const emptySlots = p.rail.length - alreadyPlaced;
      const want = Math.min(Math.max(0, this.requiredPlacedTotal() - alreadyPlaced), emptySlots);
      if (p.hand.length < want) {
        const extra = this.drawGeneralCards(want - p.hand.length);
        p.hand.push(...extra);
        if (extra.length) {
          this.addLog(`${p.name} はパーツが不足していたため、山札から${extra.length}枚補充されました`);
        }
      }
    }
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

  // そのラウンド終了時にレール上にあるべきパーツの総数（ラウンド数×2枚）。
  // 「毎ラウンド2枚置く」ではなく「累計でラウンド数×2枚になるまで置く」とすることで、
  // 補助のパーツ破壊・交換で枚数がずれても、全員の設置枚数が揃うようにする。
  requiredPlacedTotal() {
    return Math.min(this.round * 2, this.settings.railSize);
  }

  // このラウンドでそのプレイヤーが実際に置くべき枚数。
  // 既にレールにある枚数と、手札の枚数の小さい方で頭打ちする。
  requiredPlacementCount(p) {
    const alreadyPlaced = p.rail.filter((c) => c).length;
    const need = Math.max(0, this.requiredPlacedTotal() - alreadyPlaced);
    const emptySlots = p.rail.filter((c) => !c).length;
    return Math.min(need, p.hand.length, emptySlots);
  }

  handleSubmitPlacement(playerId, placements) {
    if (this.phase !== 'placement') throw new Error('配置フェイズではありません');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('プレイヤーが見つかりません');
    if (p.placedThisRound) throw new Error('すでに配置済みです');
    const required = this.requiredPlacementCount(p);
    if (!Array.isArray(placements) || placements.length !== required) {
      throw new Error(`${required}枚配置してください`);
    }

    const options = this.playerOptions(p);
    const usedSlots = new Set();
    const chosenCards = [];
    for (const pl of placements) {
      const card = options.find((c) => c.id === pl.cardId);
      if (!card) throw new Error('手元にないカードです');
      if (usedSlots.has(pl.slot)) throw new Error('同じマスに複数枚は置けません');
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
    // パーツ設置フェイズの後は、設定でイベントモードが有効な場合のみ毎ラウンドイベントフェイズに入る
    if (this.settings.sabotageEnabled) {
      this.startSabotagePhase();
    } else {
      this.afterSabotageAndRecoveryComplete();
    }
  }

  // ---------- イベントフェイズ（全員同時ではなく、プレイヤーごとに順番に行う） ----------
  // レールに配置した位置（マス番号）の合計値。小さいほどコースの前方に寄っている。
  railPositionSum(p) {
    let sum = 0;
    p.rail.forEach((c, i) => { if (c) sum += i + 1; });
    return sum;
  }

  // イベントフェイズの実行順を決める：配置位置の合計値が小さい人から順番に行う。
  // 同値の場合は席順（playersの並び）をそのまま使う。
  computeSabotageOrder() {
    return this.players
      .map((p, i) => ({ id: p.id, sum: this.railPositionSum(p), seat: i }))
      .sort((a, b) => a.sum - b.sum || a.seat - b.seat)
      .map((e) => e.id);
  }

  startSabotagePhase() {
    this.phase = 'sabotage';
    this.sabotageTurnIndex = 0;
    this.sabotageOrder = this.computeSabotageOrder();
    this.sabotageEvents = [];
    for (const p of this.players) {
      p.sabotageSubmitted = false;
      p.pendingSabotageChoices = [];
      p.sabotageHand = this.drawSabotageCards(2);
    }
    const orderNames = this.sabotageOrder
      .map((id, i) => `${i + 1}. ${this.getPlayer(id).name}(合計${this.railPositionSum(this.getPlayer(id))})`)
      .join(' → ');
    this.addLog(`ラウンド${this.round}：配置完了。イベントフェイズです（補助カードが2枚ずつ配られました）`);
    // 実行順は画面上部のバーだけでなく、ログにも残して後から見返せるようにする
    this.addLog(`🔄 イベントフェイズの実行順（レール配置位置の合計値が小さい人から）：${orderNames}`);
    this.addLog(`▶ ${this.currentSabotagePlayer().name} のイベントターンです（1人目／全${this.sabotageOrder.length}人）`);
  }

  // 現在のイベントターンのプレイヤー（席順ではなく sabotageOrder に従う）
  currentSabotagePlayer() {
    const id = this.sabotageOrder[this.sabotageTurnIndex];
    return id ? this.getPlayer(id) : null;
  }

  drawSabotageCards(n) {
    // 種類重複を避けて引くため、n枚引くのにn枚以上のカードを消費することがある。
    // 引き前の枚数だけ見ていると途中で山札が尽きてn枚に満たないことがあるため、
    // 揃うまで繰り返し継ぎ足す。
    const out = [];
    const seen = new Set();
    let guard = 0;
    while (out.length < n && guard < 100) {
      guard++;
      if (!this.sabotageDeck.length) this.sabotageDeck = C.buildSabotageDeck();
      const got = this.drawUniqueCards(this.sabotageDeck, n - out.length, this.sabotageCardSignature);
      let added = false;
      for (const card of got) {
        const sig = this.sabotageCardSignature(card);
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(card);
        added = true;
      }
      // これ以上新しい種類が出てこなければ継ぎ足して再挑戦する
      if (!added) this.sabotageDeck = this.sabotageDeck.concat(C.buildSabotageDeck());
    }
    return out;
  }

  drawGeneralCards(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      // 山札が尽きたら新しい山札を継ぎ足す。
      // （尽きたままだと復旧フェイズで引けるカードが0枚になり、
      //   破壊されたマスを埋め直せず、そのプレイヤーだけ設置枚数が減ってしまう）
      if (!this.generalDeck.length) {
        this.generalDeck = C.shuffle(C.buildGeneralDeck().concat(C.buildClimbDeck(), C.buildDropDeck()));
      }
      out.push(this.generalDeck.shift());
    }
    return out;
  }

  // 各プレイヤーに個別の客層を配る。山札が尽きたら新しい山札を継ぎ足す。
  // 出禁タイプは山札の底に戻して飛ばし、引けるカードがなければ null を返す（その回はスキップ）。
  drawCustomerFor(player) {
    const skipped = [];
    let found = null;
    // 出禁でないカードを探す。山札1周分見ても見つからなければ諦める。
    let guard = 0;
    while (guard < 200) {
      if (!this.customerDeck.length) {
        // プレイヤー人数×ラウンド数分を配るため、基本の12枚では足りなくなる。尽きたら継ぎ足す。
        this.customerDeck = C.buildCustomerDeck();
      }
      const card = this.customerDeck.shift();
      if (player.bannedCustomerTypes.has(card.typeKey)) {
        skipped.push(card);
        guard++;
        // 出禁タイプだけになってしまった場合の無限ループ防止
        if (skipped.length >= 24) break;
        continue;
      }
      found = card;
      break;
    }
    if (skipped.length) this.customerDeck.push(...skipped);
    return found;
  }

  // 見た目（種類・レベル）が重複しない一般パーツをn枚引く。
  // クライアント側は同じ見た目のカードをまとめて１つしか表示しないため、
  // 普通に引くと「3枚引きました」と表示されても選択肢が2つしか出ないことがある。
  // ここで重複を除いておくことで、枚数の表示と実際の選択肢の数を一致させる。
  drawUniqueGeneralCards(n) {
    const out = [];
    const seen = new Set();
    const skipped = [];
    let guard = 0;
    while (out.length < n && guard < 500) {
      guard++;
      const card = this.drawGeneralCards(1)[0];
      if (!card) break;
      const sig = this.generalCardSignature(card);
      if (seen.has(sig)) {
        skipped.push(card);
        continue;
      }
      seen.add(sig);
      out.push(card);
    }
    // 重複で除いたカードは山の底に戻す（山札の総数を減らさない）
    if (skipped.length) this.generalDeck.push(...skipped);
    return out;
  }

  drawReplacementCustomer() {
    if (this.customerDeck.length) return this.customerDeck.shift();
    const t = C.CUSTOMER_TYPES[Math.floor(Math.random() * C.CUSTOMER_TYPES.length)];
    return { id: C.nextId('cust'), typeKey: t.key, name: t.name, durability: t.durability, skillDesc: t.skillDesc };
  }

  submitSabotage(playerId, plays) {
    if (this.phase !== 'sabotage') throw new Error('イベントフェイズではありません');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('プレイヤーが見つかりません');
    const current = this.currentSabotagePlayer();
    if (!current || current.id !== playerId) throw new Error('あなたのイベントターンではありません');
    if (p.sabotageSubmitted) throw new Error('すでに提出済みです');
    if (!Array.isArray(plays)) throw new Error('不正な入力です');
    if (plays.length > 1) throw new Error('補助カードは1枚のみ使用できます');

    const usedCardIds = new Set();
    for (const play of plays) {
      if (usedCardIds.has(play.cardId)) throw new Error('同じカードを2回使うことはできません');
      usedCardIds.add(play.cardId);
      const card = p.sabotageHand.find((c) => c.id === play.cardId);
      if (!card) throw new Error('手元にない補助カードです');
      const target = play.targetPlayerId ? this.getPlayer(play.targetPlayerId) : null;
      if (!target) throw new Error('対象プレイヤーを指定してください');
      // 「補助カード」なので自分自身も対象に選べる。
      // ただし「相互交換」系は自分と自分で交換しても意味がない（何も起きない）ため除外する。
      if (target.id === p.id && (card.type === 'custMutualSwap' || card.type === 'partSwap')) {
        throw new Error('このカードは自分自身を対象にはできません');
      }
      // 1枚適用するたびに手札から取り除く：複数枚の同時提出中に片方が別方の状態を変えて
      // もう片方が無効になるケースがあっても、成功した分だけは確定させ、二重適用を防ぐ
      this.applySabotageCard(p, target, card, play);
      p.sabotageHand = p.sabotageHand.filter((c) => c.id !== card.id);
    }
    p.sabotageHand = [];
    p.sabotageSubmitted = true;
    this.addLog(`${p.name} が補助カードを${plays.length}枚使用しました`);
    this.checkAdvanceSabotage();
  }

  applySabotageCard(caster, target, card, play) {
    switch (card.type) {
      case 'custRandomSwap': {
        // 対象のランダムな客層一人を、別のランダムな新しい客層と入れ替える。
        // （以前は対象が入れ替える客層を選んでいたが、全てランダムに変更）
        if (!target.customers.length) {
          this.addLog(`${target.name} には入れ替えられる客層がいませんでした`);
          break;
        }
        const idx = Math.floor(Math.random() * target.customers.length);
        const before = target.customers[idx];
        const replacement = this.drawReplacementCustomer();
        replacement.satisfaction = 0;
        replacement.everReset = false;
        target.customers[idx] = replacement;
        this.pushSabotageEvent(`${caster.name} → ${target.name}：客層ランダム交換（${before.name} → ${replacement.name}）`);
        break;
      }
      case 'custMutualSwap': {
        const myIdx = Number(play.myIndex);
        const targetIdx = Number(play.targetIndex);
        if (!Number.isInteger(myIdx) || myIdx < 0 || myIdx >= caster.customers.length) throw new Error('自分の客層の指定が不正です');
        if (!Number.isInteger(targetIdx) || targetIdx < 0 || targetIdx >= target.customers.length) throw new Error('相手の客層の指定が不正です');
        const tmp = caster.customers[myIdx];
        const targetCustName = target.customers[targetIdx].name;
        caster.customers[myIdx] = target.customers[targetIdx];
        target.customers[targetIdx] = tmp;
        this.pushSabotageEvent(`${caster.name} → ${target.name}：客層相互交換（${tmp.name} ↔ ${targetCustName}）`);
        break;
      }
      case 'custBanType': {
        const typeKey = play.typeKey;
        const typeDef = C.CUSTOMER_TYPES.find((t) => t.key === typeKey);
        if (!typeDef) throw new Error('客層タイプの指定が不正です');
        target.bannedCustomerTypes.add(typeKey);
        this.pushSabotageEvent(`${caster.name} → ${target.name}：客層出禁（${typeDef.name}）`);
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
        const targetPartLabel = target.rail[targetSlot].label;
        caster.rail[mySlot] = target.rail[targetSlot];
        target.rail[targetSlot] = tmp;
        this.queueRecoveryTask(caster, 'swapped', mySlot);
        this.queueRecoveryTask(target, 'swapped', targetSlot);
        this.pushSabotageEvent(`${caster.name} → ${target.name}：パーツ交換（マス${mySlot + 1}の${tmp.label} ↔ マス${targetSlot + 1}の${targetPartLabel}）`);
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
          this.pushSabotageEvent(`${caster.name} → ${target.name}：レベルダウン（マス${slot + 1} → ${tCard.label}）`);
        } else {
          target.rail[slot] = null;
          this.queueRecoveryTask(target, 'destroyed', slot);
          this.pushSabotageEvent(`${caster.name} → ${target.name}：レベルダウンでパーツ破壊（マス${slot + 1}）`);
        }
        break;
      }
      default:
        throw new Error('不明な補助カードです');
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
    if (this.phase !== 'sabotage') throw new Error('イベントフェイズではありません');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('プレイヤーが見つかりません');
    payload = payload || {};
    const idx = p.pendingSabotageChoices.findIndex((c) => c.id === payload.choiceId);
    if (idx === -1) throw new Error('対応すべき補助がありません');
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
      this.pushSabotageEvent(`${choice.casterName} → ${p.name}：パーツ破壊（マス${slot + 1}）`);
    }

    p.pendingSabotageChoices.splice(idx, 1);
    this.checkAdvanceSabotage();
  }

  checkAdvanceSabotage() {
    if (this.phase !== 'sabotage') return;
    // 現在の手番プレイヤーが誰かを狙った補助の「対象側の選択」が残っている間は、手番を進めない
    const anyPending = this.players.some((p) => p.pendingSabotageChoices.length > 0);
    if (anyPending) return;
    const current = this.currentSabotagePlayer();
    if (!current || !current.sabotageSubmitted) return; // 現在の手番プレイヤーがまだ提出していない
    this.sabotageTurnIndex += 1;
    if (this.sabotageTurnIndex >= this.sabotageOrder.length) {
      const anyRecovery = this.players.some((p) => p.recoveryTasks.length > 0);
      if (anyRecovery) {
        this.startRecoveryPhase();
      } else {
        this.afterSabotageAndRecoveryComplete();
      }
    } else {
      this.addLog(`▶ ${this.currentSabotagePlayer().name} のイベントターンです（${this.sabotageTurnIndex + 1}人目／全${this.sabotageOrder.length}人）`);
    }
  }

  // ---------- 復旧フェイズ（タスクがあるプレイヤーだけ、順番に行う） ----------
  startRecoveryPhase() {
    this.phase = 'recovery';
    this.recoveryTurnIndex = 0;
    this.addLog('イベントフェイズ終了。復旧フェイズに入ります');
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
    let drawn = this.drawUniqueGeneralCards(3);
    if (type === 'destroyed') {
      // 3枚とも安全装置作動の場合のみもう3枚引く
      let attempts = 0;
      while (attempts < 5 && drawn.length && drawn.every((c) => this.wouldTriggerSafety(player.rail, slot, c))) {
        drawn = this.drawUniqueGeneralCards(3);
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
        if (p.rail[targetSlot]) {
          // 同じラウンドに複数の補助を受けると、先に処理した復旧（パーツ交換の前後設置など）で
          // 破壊されたマスが埋まってしまうことがある。
          // その場合は復旧不能にするのではなく、代わりの空きマスに設置させる。
          // （さもないとそのプレイヤーだけ設置枚数が減ったまま進行不能になる）
          const requested = Number(payload.slot);
          if (Number.isInteger(requested) && requested >= 0 && requested < p.rail.length && !p.rail[requested]) {
            targetSlot = requested;
          } else {
            const fallback = p.rail.findIndex((c) => !c);
            if (fallback === -1) {
              // レールに空きがない＝先の復旧ですでに枚数が戻っているので、
              // このタスクは何もせずに完了させる（進行不能にしない）。
              this.addLog(`${p.name} はすでにレールが埋まっているため、復旧は不要でした`);
              task.resolved = true;
              p.recoveryTasks.splice(idx, 1);
              if (p.recoveryTasks.length === 0) {
                this.recoveryTurnIndex += 1;
                this.advanceToNextRecoveryPlayer();
              }
              return;
            }
            targetSlot = fallback;
          }
        }
      } else {
        // パーツ交換の復旧：交換されたマスそのもの、またはその前後1マスに設置できる。
        // すでにパーツが置かれていても、そこへ上書き（入れ替え）できる。
        const pos = payload.position;
        if (pos !== 'self' && pos !== 'before' && pos !== 'after') throw new Error('位置を指定してください（そのマス／前／後）');
        targetSlot = pos === 'self' ? task.slot : pos === 'before' ? task.slot - 1 : task.slot + 1;
        if (targetSlot < 0 || targetSlot >= p.rail.length) throw new Error('その位置にはマスがありません');
        // パーツ交換の復旧は「入れ替え」なので、設置枚数は増やさない。
        // 空きマスに置く場合は、交換されたマスのカードをそこへ移す形にして総数を維持する。
        if (targetSlot !== task.slot && !p.rail[targetSlot]) {
          p.rail[task.slot] = null;
        }
      }
      if (card.kind === 'part' && card.type === 'brake') {
        const raw = Number(payload.brakeReduce);
        card.brakeReduce = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
      }
      p.rail[targetSlot] = card;
      this.addLog(`${p.name} が復旧フェイズでマス${targetSlot + 1}に${card.label}を設置しました`);
    } else {
      // パーツ破壊（落下・巻き上げのレベル低下による破壊を含む）の復旧では、必ずいずれかのパーツを設置する
      if (task.type === 'destroyed' && task.drawnCards.length > 0) {
        throw new Error('パーツ破壊の復旧では、必ずいずれかのパーツを設置してください');
      }
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
  // onPlayerDone: 1人分の試運転が終わるたびに呼ばれる。
  // これを使って途中経過を配信することで、ボーナス満足度をマップの右側に順次表示できる。
  async startTrialPhase(emitStep, onPlayerDone) {
    if (this.trialStarted) return; // 二重実行防止（同じゲームで2回結果が出るバグ対策）
    this.trialStarted = true;
    this.phase = 'trial';
    this.trialResults = [];
    for (const p of this.players) {
      const result = await this.runTrialForPlayer(p, emitStep);
      this.trialResults.push(result);
      if (onPlayerDone) {
        try { onPlayerDone(result); } catch (e) { /* 配信失敗で試運転を止めない */ }
      }
      await wait(400);
    }
    this.applyRecords();
    this.finalizeScores();
    this.phase = 'finished';
  }

  async runTrialForPlayer(p, emitStep) {
    let altitude = 2;
    let speed = 2;
    // 客層は補助（交換・出禁）によりプレイヤーごとに内容が異なりうるため、共有のrevealedCustomersではなく個別のp.customersを使う
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
    const thrill5PlusCount = thrillHistory.filter((t) => t >= 5).length;
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
          // スリル値５のマスを1回以上通過するとボーナス満足度50
          achieved = thrill5PlusCount >= 1;
          bonus = achieved ? 50 : 0;
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
      sabotageTurnPlayerId: this.phase === 'sabotage' && this.currentSabotagePlayer() ? this.currentSabotagePlayer().id : null,
      // イベントフェイズの実行順（レール配置位置の合計値が小さい人から）を画面に明記するために送る
      sabotageEvents: this.sabotageEvents,
      sabotageOrder: (this.phase === 'sabotage' || this.phase === 'recovery')
        ? this.sabotageOrder.map((id, i) => {
            const pl = this.getPlayer(id);
            return { playerId: id, name: pl ? pl.name : '', positionSum: pl ? this.railPositionSum(pl) : 0, index: i, done: pl ? pl.sabotageSubmitted : false };
          })
        : [],
      recoveryTurnPlayerId: this.phase === 'recovery' && this.players[this.recoveryTurnIndex] ? this.players[this.recoveryTurnIndex].id : null,
      players: this.players.map((p) => this.publicPlayerView(p)),
      revealedCustomers: this.revealedCustomers,
      customerDeckCount: this.customerDeck.length,
      generalDeckCount: this.generalDeck.length,
      myDraftPacket: me ? me.draftPacket : [],
      // 配置フェイズで自分が今回置くべき枚数（ラウンド数×2枚になるよう調整される）
      myRequiredPlacementCount: me && this.phase === 'placement' ? this.requiredPlacementCount(me) : 0,
      requiredPlacedTotal: this.phase === 'lobby' ? 0 : this.requiredPlacedTotal(),
      myId: playerId,
      log: this.log.slice(-50),
      winners: this.winners || null,
      trialResults: this.trialResults,
    };
  }
}

module.exports = GameRoom;
