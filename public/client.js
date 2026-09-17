'use strict';

const socket = io();

const CUSTOMER_SKILLS = {
  elder: '全レールにおいてスリル値2以下 → +10',
  family: '異なるパーツ種類を5種類以上通過 → +15',
  schoolTrip: 'スリル値2以上が3マス連続 → +10',
  streamer: '8マス目が最大スリル値（同率含む） → +10',
  couple: 'トンネル通過ごとに → +10×(トンネル枚数)',
  thrillSeeker: 'スリル値５のマスを1回以上通過 → +50',
};

// 客層のイラスト画像
const CUSTOMER_IMAGES = {
  elder: 'pictures/customer-elder.png',
  family: 'pictures/customer-family.png',
  schoolTrip: 'pictures/customer-student.png',
  streamer: 'pictures/customer-streamer.png',
  couple: 'pictures/customer-couple.png',
  thrillSeeker: 'pictures/customer-thrillseeker.png',
};
function customerIconSrc(typeKey) {
  return CUSTOMER_IMAGES[typeKey] || '';
}
// innerHTML内に埋め込む用の<img>タグ文字列
function customerIcon(typeKey, cls) {
  const src = customerIconSrc(typeKey);
  if (!src) return '';
  return `<img src="${src}" class="icon-img ${cls || 'customer-icon-img'}" alt="">`;
}

const CUSTOMER_TABLE_DATA = [
  { typeKey: 'elder', name: '常連の老人', durability: 2, skill: CUSTOMER_SKILLS.elder },
  { typeKey: 'family', name: '家族連れ', durability: 2, skill: CUSTOMER_SKILLS.family },
  { typeKey: 'schoolTrip', name: '修学旅行生', durability: 3, skill: CUSTOMER_SKILLS.schoolTrip },
  { typeKey: 'streamer', name: '動画配信者', durability: 3, skill: CUSTOMER_SKILLS.streamer },
  { typeKey: 'couple', name: 'カップル', durability: 4, skill: CUSTOMER_SKILLS.couple },
  { typeKey: 'thrillSeeker', name: '絶叫マニア', durability: 5, skill: CUSTOMER_SKILLS.thrillSeeker },
];

function initCustomerSkillTable() {
  const tbody = document.getElementById('customerSkillTable');
  if (!tbody) return;
  tbody.innerHTML = '';
  CUSTOMER_TABLE_DATA.forEach((row) => {
    const [cond, bonus] = row.skill.split(' → ');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${customerIcon(row.typeKey)} ${row.name}</td><td>${row.durability}</td><td>${cond}</td><td class="plus">${bonus}</td>`;
    tbody.appendChild(tr);
  });
}
initCustomerSkillTable();

const PHASE_LABEL = {
  lobby: 'ロビー：参加者待ち',
  draft: 'ドラフトフェイズ',
  placement: '配置フェイズ',
  sabotage: 'イベントフェイズ',
  recovery: '復旧フェイズ',
  trial: '試運転フェイズ',
  finished: '結果発表',
};

const SABOTAGE_LABELS = {
  customer: '客層補助',
  part: 'パーツ補助',
};

const SAFETY_NOTE = '条件を満たさないと安全装置作動（スリル0・以降の満足度はこの直前の値で固定される）';

const PART_INFO = {
  curve: { desc: '条件なし。通過すると速度-1。誰でも安心して置ける基本パーツ。' },
  twist: { desc: `進入時の速度が1か2のときだけ使用可能。成功すると速度-1。${SAFETY_NOTE}。` },
  airtime: { desc: `進入時の速度が2か3のときだけ使用可能。成功すると速度-1。${SAFETY_NOTE}。` },
  loop: { desc: `進入時の速度が3か4のときだけ使用可能。成功すると速度-1。${SAFETY_NOTE}。全ゲームで3枚しかない希少パーツ。` },
  tunnel: { desc: '速度-1。進入した瞬間（このマスに来た時点）の速度が、そのままスリル値になる（速いほど高スリル）。安全装置の対象外。' },
  brake: { desc: '配置するときに「下げる量」を自分で決める。このマスに来た時点の速度からその分だけ下げる（速度が足りなければ下げられる分だけ）。下げた分がそのままスリル値になる。' },
};

// レールパーツのイラスト画像
const PART_IMAGES = {
  curve: 'pictures/part-curve.png',
  twist: 'pictures/part-twist.png',
  airtime: 'pictures/part-airtime.png',
  loop: 'pictures/part-loop.png',
  tunnel: 'pictures/part-tunnel.png',
  brake: 'pictures/part-brake.png',
};
function partIconSrc(c) {
  if (!c) return '';
  if (c.kind === 'climb') return 'pictures/part-lifthill.png';
  if (c.kind === 'drop') return 'pictures/part-drop.png';
  return PART_IMAGES[c.type] || '';
}
// innerHTML内に埋め込む用の<img>タグ文字列
function partIcon(c, cls) {
  const src = partIconSrc(c);
  if (!src) return '';
  return `<img src="${src}" class="icon-img ${cls || 'part-icon-img'}" alt="">`;
}

// スリル値をカード上に分かりやすく表示するためのラベル（固定値は数字、可変値は式）
function cardThrillLabel(c) {
  if (!c) return '';
  if (c.kind === 'climb') return 'スリル0';
  if (c.kind === 'drop') return `スリル${c.value}（成功時）`;
  if (c.type === 'tunnel') return 'スリル＝進入時の速度';
  if (c.type === 'brake') return 'スリル＝下げた量';
  return `スリル${c.thrill}`;
}

// カード下部に表示する「安全装置作動条件・その他効果」の説明文
function cardEffectText(c) {
  if (!c) return '';
  if (c.kind === 'climb') return `高度を${c.value}増やし、速度を0にする。`;
  if (c.kind === 'drop') return `高度が${c.value}以上あれば${c.value}消費して同じ量だけ速度が上がる。${SAFETY_NOTE}。`;
  const info = PART_INFO[c.type];
  return info ? info.desc : '';
}

function cardTooltip(c) {
  if (!c) return '';
  return `${cardLabel(c)}：${cardEffectText(c)}`;
}

// カード上部の「高さ変化・速度変化」表示
function cardStatText(c) {
  if (!c) return { height: '', speed: '' };
  if (c.kind === 'climb') return { height: `+${c.value}`, speed: '0（リセット）' };
  if (c.kind === 'drop') return { height: `-${c.value}（条件付）`, speed: `+${c.value}（成功時）` };
  if (c.type === 'brake') return { height: '±0', speed: '配置時に指定した量だけ減少' };
  if (c.type === 'tunnel') return { height: '±0', speed: '-1' };
  return { height: '±0', speed: '-1（成功時）' };
}

// カード本体（上部：名前・高さ/速度/スリル、中部：レールイラスト、下部：効果説明）を構築する
function buildCardVisual(c) {
  const stats = cardStatText(c);
  const frag = document.createDocumentFragment();

  const top = document.createElement('div');
  top.className = 'card-v-top';
  const nameEl = document.createElement('div');
  nameEl.className = 'card-v-name';
  nameEl.textContent = cardLabel(c);
  top.appendChild(nameEl);
  const statsEl = document.createElement('div');
  statsEl.className = 'card-v-stats';
  statsEl.innerHTML = `<span class="card-v-stat">高さ ${stats.height}</span><span class="card-v-stat">速さ ${stats.speed}</span><span class="card-v-stat">スリル ${cardThrillLabel(c).replace('スリル', '')}</span>`;
  top.appendChild(statsEl);
  frag.appendChild(top);

  const mid = document.createElement('div');
  mid.className = 'card-v-mid';
  const src = partIconSrc(c);
  if (src) {
    const img = document.createElement('img');
    img.className = 'card-v-img';
    img.src = src;
    img.alt = cardLabel(c);
    mid.appendChild(img);
  }
  frag.appendChild(mid);

  const bottom = document.createElement('div');
  bottom.className = 'card-v-bottom';
  bottom.textContent = cardEffectText(c);
  frag.appendChild(bottom);

  return frag;
}

let myPlayerId = localStorage.getItem('fd_playerId') || null;
let myRoomId = localStorage.getItem('fd_roomId') || null;
let latestState = null;
let joined = false;

// placement UI local state
let selectedCardId = null;
let draftSelectedCardId = null;
let placementBrakeReduce = 0;
let actionPending = false;
let pendingPlacements = []; // {cardId, slot, card}
const trialLines = [];
let resultAnim = null; // { totals:{playerId:number}, currentIndex:number, step:number, done:boolean }

const el = (id) => document.getElementById(id);

const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = () => motionPreference.matches;
motionPreference.addEventListener('change', () => {
  if (!reducedMotion()) return;
  document.querySelectorAll('[data-motion-id], .card-flight').forEach((node) => node.getAnimations().forEach((animation) => animation.cancel()));
});
let feedbackTimer;
function showFeedback(message) {
  const box = el('actionFeedback');
  box.textContent = message;
  box.classList.remove('hidden');
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => box.classList.add('hidden'), 3200);
}

// Lock submissions until the server acknowledges them; local selection remains reversible.
function submitAction(event, data, callback) {
  if (actionPending) return;
  actionPending = true;
  render();
  socket.timeout(8000).emit(event, data, (error, response) => {
    actionPending = false;
    if (error) showFeedback('応答を確認できませんでした。盤面の状態を確認してから、もう一度操作してください。');
    else callback(response);
    render();
  });
}

function makeInteractive(node, label, onClick) {
  node.setAttribute('role', 'button');
  node.tabIndex = 0;
  node.setAttribute('aria-label', label);
  node.addEventListener('click', () => { if (!actionPending) onClick(); });
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!actionPending) onClick();
    }
  });
}

function decorateHand(row) {
  row.classList.add('card-hand');
  Array.from(row.children).forEach((card, i, cards) => {
    card.style.setProperty('--fan-angle', `${(i - (cards.length - 1) / 2) * 3}deg`);
    card.style.setProperty('--fan-rise', `${Math.abs(i - (cards.length - 1) / 2) * 3}px`);
  });
}

function renderTurnGuide(s, me) {
  const guide = el('turnGuide');
  guide.classList.toggle('hidden', s.phase === 'lobby');
  if (!me || s.phase === 'lobby') return;
  const phases = [['draft', 'カードを集める'], ['placement', 'レールに置く']];
  if (s.settings.sabotageEnabled) phases.push(['sabotage', 'イベント']);
  if (s.phase === 'recovery') phases.push(['recovery', '復旧']);
  phases.push(['trial', '試運転'], ['finished', '結果']);
  el('phaseSteps').innerHTML = phases.map(([phase, label], i) => `<span class="phase-step${phase === s.phase ? ' current' : ''}" ${phase === s.phase ? 'aria-current="step"' : ''}><b>${i + 1}</b>${label}</span>`).join('');
  let title = '', hint = '', active = true;
  if (s.phase === 'draft') {
    active = !me.hasPendingPick;
    title = active ? (draftSelectedCardId ? 'このカードを手札に加えますか？' : '受け取るカードを1枚選びましょう') : '選択完了。みんなの選択を待っています';
    hint = '残りのカードは隣のプレイヤーへ。最後の1枚は自動で受け取り、合計3枚を集めます。';
  } else if (s.phase === 'placement') {
    active = !me.placedThisRound;
    title = me.placedThisRound ? '配置完了。みんなの配置を待っています' : selectedCardId ? '光っている空きマスを選びましょう' : pendingPlacements.length === requiredPlacementCount(s) ? 'コースを確認して、配置を確定しましょう' : '手札からレールに置くカードを選びましょう';
    hint = me.placedThisRound ? '全員が配置を確定すると、次のフェイズへ進みます。他のプレイヤーのコースも見てみましょう。' : `配置予定 ${pendingPlacements.length} / ${requiredPlacementCount(s)}枚。確定前なら置いたカードを押して取り消せます。未使用のカードは持ち越せません。`;
  } else if (s.phase === 'sabotage') {
    active = !!me.pendingSabotageChoices.length || (s.sabotageTurnPlayerId === s.myId && !me.sabotageSubmitted);
    title = me.pendingSabotageChoices.length ? '届いたイベントの対象を選んでください' : active ? '補助カードを1枚使うか、見送りましょう' : '他のプレイヤーのイベントを待っています';
    hint = '使えるカードを選ぶと対象が表示されます。効果と対象を確認して確定してください。';
  } else if (s.phase === 'recovery') {
    active = s.recoveryTurnPlayerId === s.myId && me.recoveryTasks.length > 0;
    title = active ? 'カードを選んでレールを復旧しましょう' : '他のプレイヤーがレールを復旧しています';
    hint = '破壊されたマスは復旧が必要です。交換されたマスは、そのマスか前後のマスに置けます。';
  } else {
    active = false;
    title = s.phase === 'trial' ? 'コースターが走行中です' : 'みんなの満足度を発表します';
    hint = 'スリルと客層の耐性が一致すると「スリル＋5」点。安全装置が作動すると、その先の得点は増えません。';
  }
  guide.classList.toggle('waiting', !active || actionPending);
  el('guideBadge').textContent = actionPending ? '送信中' : active ? 'あなたの操作' : '進行状況';
  el('guideTitle').textContent = title;
  el('guideHint').textContent = hint;
  const status = `${el('guideBadge').textContent}：${title}`;
  if (el('guideStatus').textContent !== status) el('guideStatus').textContent = status;
}

// Keep keyboard focus and animate only cards that entered or actually moved.
function captureUi() {
  return new Map(Array.from(document.querySelectorAll('[data-motion-id]'), (node) => [node.dataset.motionId, {
    rect: node.getBoundingClientRect(),
    card: node.classList.contains('card-v') ? node.cloneNode(true) : null,
  }]));
}
function animateUi(previous) {
  if (reducedMotion()) return;
  document.querySelectorAll('[data-motion-id]').forEach((node) => {
    const snapshot = previous.get(node.dataset.motionId);
    const before = snapshot?.rect;
    const after = node.getBoundingClientRect();
    if (!after.width) return;
    if (!before) node.animate([{ opacity: 0, translate: '0 18px' }, { opacity: 1, translate: '0 0' }], { duration: 320, easing: 'ease-out' });
    else if (snapshot.card && node.classList.contains('slot')) {
      // A fixed overlay keeps the travelling card visible outside the scrollable hand/rail.
      const flight = document.createElement('div');
      flight.className = 'card-hand card-flight';
      flight.setAttribute('aria-hidden', 'true');
      flight.inert = true;
      snapshot.card.removeAttribute('data-motion-id');
      snapshot.card.removeAttribute('data-focus-key');
      snapshot.card.classList.remove('chosen', 'selectable');
      flight.appendChild(snapshot.card);
      Object.assign(flight.style, { left: `${before.x}px`, top: `${before.y}px`, width: `${before.width}px`, height: `${before.height}px` });
      document.body.appendChild(flight);
      const motion = flight.animate([
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${after.x - before.x}px, ${after.y - before.y}px) scale(${after.width / before.width}, ${after.height / before.height})`, opacity: .15 },
      ], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
      motion.finished.then(() => flight.remove(), () => flight.remove());
    } else if (Math.abs(before.x - after.x) > 2 || Math.abs(before.y - after.y) > 2) {
      node.animate([{ translate: `${before.x - after.x}px ${before.y - after.y}px` }, { translate: '0 0' }], { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  });
}

// ---------- lobby screen wiring ----------
const params = new URLSearchParams(location.search);
if (params.get('room')) {
  el('roomCodeInput').value = params.get('room').toUpperCase();
}

el('createBtn').addEventListener('click', () => {
  const name = el('nameInput').value.trim() || 'プレイヤー';
  socket.emit('createRoom', { name }, (res) => {
    if (!res.ok) return showLobbyError(res.error);
    onJoined(res.roomId, res.playerId);
  });
});

el('joinBtn').addEventListener('click', () => {
  const name = el('nameInput').value.trim() || 'プレイヤー';
  const roomId = el('roomCodeInput').value.trim().toUpperCase();
  if (!roomId) return showLobbyError('ルームコードを入力してください');
  socket.emit('joinRoom', { roomId, name }, (res) => {
    if (!res.ok) return showLobbyError(res.error);
    onJoined(res.roomId, res.playerId);
  });
});

function showLobbyError(msg) {
  el('lobbyError').textContent = msg;
}

function onJoined(roomId, playerId) {
  myRoomId = roomId;
  myPlayerId = playerId;
  joined = true;
  localStorage.setItem('fd_roomId', roomId);
  localStorage.setItem('fd_playerId', playerId);
  el('lobbyScreen').classList.add('hidden');
  el('gameScreen').classList.remove('hidden');
  el('roomCodeLabel').textContent = roomId;
}

// auto-reconnect attempt
if (myRoomId && myPlayerId) {
  socket.emit('joinRoom', { roomId: myRoomId, playerId: myPlayerId }, (res) => {
    if (res.ok) onJoined(res.roomId, res.playerId);
  });
}

el('copyLinkBtn').addEventListener('click', () => {
  const url = `${location.origin}${location.pathname}?room=${myRoomId}`;
  navigator.clipboard.writeText(url).then(() => {
    el('copiedMsg').classList.remove('hidden');
    setTimeout(() => el('copiedMsg').classList.add('hidden'), 1800);
  });
});

el('backToTitleBtn').addEventListener('click', () => {
  const inGame = latestState && latestState.phase !== 'lobby' && latestState.phase !== 'finished';
  const msg = inGame
    ? 'ゲームの途中です。タイトル画面に戻るとこのルームから離脱します。よろしいですか？'
    : 'タイトル画面に戻りますか？';
  if (!window.confirm(msg)) return;
  localStorage.removeItem('fd_roomId');
  localStorage.removeItem('fd_playerId');
  location.href = location.pathname;
});

el('startGameBtn').addEventListener('click', () => {
  socket.emit('startGame', {}, (res) => {
    if (!res.ok) alert(res.error);
  });
});

// ---------- ルール設定（ロビー） ----------
function wireSettingsGroup(containerId, field, parse) {
  const container = el(containerId);
  container.querySelectorAll('.settings-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = latestState;
      if (!s || s.hostId !== s.myId) return;
      const value = parse(btn.dataset.value);
      socket.emit('updateSettings', { [field]: value }, (res) => {
        if (!res.ok) alert(res.error);
      });
    });
  });
}
wireSettingsGroup('settingRailSize', 'railSize', (v) => Number(v));
wireSettingsGroup('settingAltitudeBonus', 'endAltitudeZeroBonus', (v) => v === 'true');
wireSettingsGroup('settingRecords', 'recordsEnabled', (v) => v === 'true');
wireSettingsGroup('settingSabotage', 'sabotageEnabled', (v) => v === 'true');

function renderSettingsBox(s) {
  if (!s.settings) return;
  const isHost = s.hostId === s.myId;
  const groups = [
    { id: 'settingRailSize', value: String(s.settings.railSize) },
    { id: 'settingAltitudeBonus', value: String(s.settings.endAltitudeZeroBonus) },
    { id: 'settingRecords', value: String(s.settings.recordsEnabled) },
    { id: 'settingSabotage', value: String(s.settings.sabotageEnabled) },
  ];
  groups.forEach((g) => {
    const container = el(g.id);
    container.querySelectorAll('.settings-opt').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === g.value);
      btn.disabled = !isHost;
    });
  });
  el('settingsHostHint').classList.toggle('hidden', isHost);
}

el('playAgainBtn').addEventListener('click', () => {
  socket.emit('playAgain', {}, (res) => {
    if (!res.ok) alert(res.error);
  });
});

el('skipResultBtn').addEventListener('click', () => {
  if (!resultAnim || !latestState || latestState.phase !== 'finished') return;
  resultAnim.done = true;
  resultAnim.totals = Object.fromEntries(latestState.trialResults.map((r) => [r.playerId, r.total]));
  renderResultTick(latestState);
});

// ---------- socket state events ----------
socket.on('state', (state) => {
  const me = state.players.find((p) => p.id === state.myId);
  if (!latestState || latestState.phase !== state.phase || latestState.round !== state.round || (me && me.placedThisRound)) {
    pendingPlacements = [];
    selectedCardId = null;
  }
  if (state.phase !== 'draft' || me.hasPendingPick || !state.myDraftPacket.some((c) => c.id === draftSelectedCardId)) draftSelectedCardId = null;
  if (state.phase === 'draft' && (!latestState || latestState.phase !== 'draft') && state.round === 1) trialLines.length = 0;
  latestState = state;
  render();
});

socket.on('log', () => {});

socket.on('trialStep', (detail) => {
  trialLines.push(detail);
  renderTrial();
  if (latestState) renderPlayersBoard(latestState);
});

socket.on('gameOver', () => {
  // final 'state' event carries the same info; nothing extra needed
});

// ---------- rendering ----------
function render() {
  if (!latestState) return;
  const previous = captureUi();
  const focused = document.activeElement;
  const focusKey = focused && focused.dataset.focusKey;
  const s = latestState;
  const me = s.players.find((p) => p.id === s.myId);
  el('phaseInfo').textContent = `${PHASE_LABEL[s.phase] || s.phase}${s.round ? '（ラウンド' + s.round + '/' + (s.rounds || s.round) + '）' : ''}`;

  el('lobbyWait').classList.toggle('hidden', s.phase !== 'lobby');
  if (s.phase === 'lobby') {
    const ul = el('playerListLobby');
    ul.innerHTML = '';
    s.players.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.name}${p.id === s.hostId ? '（ホスト）' : ''}${p.id === s.myId ? '（あなた）' : ''}`;
      ul.appendChild(li);
    });
    const canStart = s.hostId === s.myId && s.players.length >= 2 && s.players.length <= 4;
    el('startGameBtn').classList.toggle('hidden', !canStart);
    renderSettingsBox(s);
    trialLines.length = 0;
  }

  renderRecordsBar(s);
  renderCustomers(s);
  // Detach the controls before replacing player panels.
  el('gameScreen').appendChild(el('myControls'));
  renderPlayersBoard(s);
  renderMyControls(s);
  const myPanel = document.querySelector('.player-panel.me');
  if (myPanel) myPanel.appendChild(el('myControls'));
  el('myControls').classList.toggle('hidden', !['draft', 'placement', 'sabotage', 'recovery'].includes(s.phase));
  el('playersBoard').classList.toggle('hidden', s.phase === 'lobby');
  el('customerBar').classList.toggle('hidden', s.phase === 'lobby');
  renderTurnGuide(s, me);
  renderSabotageOrderBar(s);
  renderSabotageToast(s);
  el('myControls').classList.toggle('submitting', actionPending);
  el('myControls').setAttribute('aria-busy', String(actionPending));
  if (actionPending) el('myControls').querySelectorAll('button, input, select').forEach((node) => { node.disabled = true; });

  el('trialSection').classList.toggle('hidden', !(s.phase === 'trial' || s.phase === 'finished'));
  el('resultSection').classList.toggle('hidden', s.phase !== 'finished');

  el('scoreBar').classList.toggle('hidden', s.phase !== 'finished');
  if (s.phase === 'finished') {
    if (!resultAnim) {
      resultAnim = {
        totals: Object.fromEntries(s.players.map((p) => [p.id, 0])),
        currentIndex: -1,
        step: -1,
        done: false,
        running: false,
      };
    }
    renderResultTick(s);
    if (!resultAnim.running) {
      resultAnim.running = true;
      runResultAnimation(s);
    }
    // 「次のゲームへ」は結果発表アニメーションの終了を待たず、
    // 結果画面に入った時点でホストに常に表示する（長いアニメーションを飛ばして次へ行けるように）
    const isHost = s.hostId === s.myId;
    el('playAgainBtn').classList.toggle('hidden', !isHost);
    el('playAgainHint').classList.toggle('hidden', isHost);
  } else {
    resultAnim = null;
    el('playAgainBtn').classList.add('hidden');
    el('playAgainHint').classList.add('hidden');
  }

  const logBox = el('logBox');
  logBox.innerHTML = '';
  (s.log || []).forEach((l) => {
    const d = document.createElement('div');
    d.textContent = l.msg;
    logBox.appendChild(d);
  });
  logBox.scrollTop = logBox.scrollHeight;
  document.querySelectorAll('#myControls button, #myControls input, #myControls select, .slot[role="button"], .card-hand [role="button"]').forEach((node) => {
    if (!node.dataset.focusKey) node.dataset.focusKey = node.dataset.motionId || `${node.tagName}:${node.getAttribute('aria-label') || node.textContent}`;
  });
  if (focusKey) {
    const target = Array.from(document.querySelectorAll('[data-focus-key]')).find((node) => node.dataset.focusKey === focusKey);
    if (target) target.focus({ preventScroll: true });
    else if (selectedCardId) document.querySelector('.player-panel.me .slot.selectable')?.focus({ preventScroll: true });
    else if (focused?.classList.contains('slot')) document.querySelector('#myControls .selectable, #myControls button.primary')?.focus({ preventScroll: true });
  }
  animateUi(previous);
}

function renderRecordsBar(s) {
  const bar = el('recordsBar');
  const active = s.activeRecords || [];
  const show = s.phase !== 'lobby' && active.length > 0;
  bar.classList.toggle('hidden', !show);
  el('recordsDetails').classList.toggle('hidden', !show);
  if (!show) return;
  bar.innerHTML = '';
  active.forEach((rec) => {
    const div = document.createElement('div');
    div.className = 'record-chip';
    div.innerHTML = `🏅 <b>${rec.label}（+${rec.bonus}満足度）</b>：${rec.desc || ''}`;
    bar.appendChild(div);
  });
}

// イベントフェイズの実行順（レール配置位置の合計値が小さい人から）を、盤面の上に常時表示する
function renderSabotageOrderBar(s) {
  const bar = el('sabotageOrderBar');
  const order = s.sabotageOrder || [];
  // 復旧フェイズ中も実行順を出したままにして、誰の番だったか分かるようにする
  const show = (s.phase === 'sabotage' || s.phase === 'recovery') && order.length > 0;
  bar.classList.toggle('hidden', !show);
  if (!show) return;
  bar.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'order-bar-title';
  title.textContent = '🔄 イベントフェイズの実行順（レール配置位置の合計値が小さい人から）';
  bar.appendChild(title);

  const row = document.createElement('div');
  row.className = 'order-chips';
  order.forEach((entry, i) => {
    const chip = document.createElement('span');
    const isCurrent = entry.playerId === s.sabotageTurnPlayerId;
    chip.className = 'order-chip' + (isCurrent ? ' current' : '') + (entry.done ? ' done' : '');
    const you = entry.playerId === s.myId ? '（あなた）' : '';
    chip.textContent = `${i + 1}. ${entry.name}${you}（合計${entry.positionSum}）${entry.done ? ' ✔' : ''}${isCurrent ? ' ← 今' : ''}`;
    row.appendChild(chip);
    if (i < order.length - 1) {
      const arrow = document.createElement('span');
      arrow.className = 'order-arrow';
      arrow.textContent = '→';
      row.appendChild(arrow);
    }
  });
  bar.appendChild(row);
}

// 誰が何をされたのか見逃さないよう、イベントフェイズの行為内容を画面中央にポップアップ表示する。
// 同じ内容はログにも残るので、後から見返すこともできる。
let shownSabotageEventIds = new Set();
let sabotageToastQueue = [];
let sabotageToastTimer = null;
function renderSabotageToast(s) {
  const events = s.sabotageEvents || [];
  if (s.phase !== 'sabotage' && s.phase !== 'recovery') {
    // フェイズが変わったら表示済み記録をリセットしておく
    if (!events.length) shownSabotageEventIds = new Set();
    return;
  }
  const fresh = events.filter((e) => !shownSabotageEventIds.has(e.id));
  if (!fresh.length) return;
  fresh.forEach((e) => shownSabotageEventIds.add(e.id));
  // 連続して起きたイベントを上書きしてしまわないよう、順番に1件ずつ表示する
  sabotageToastQueue.push(...fresh.map((e) => e.text));
  if (!sabotageToastTimer) showNextSabotageToast();
}

function showNextSabotageToast() {
  const toast = el('sabotageToast');
  const text = sabotageToastQueue.shift();
  if (text === undefined) {
    toast.classList.add('hidden');
    sabotageToastTimer = null;
    return;
  }
  toast.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'toast-title';
  title.textContent = '🎭 補助カードが使われました';
  toast.appendChild(title);
  const line = document.createElement('div');
  line.className = 'toast-line';
  line.textContent = text;
  toast.appendChild(line);
  // 残りがあることを伝えて、見逃した気にさせない
  if (sabotageToastQueue.length) {
    const more = document.createElement('div');
    more.className = 'toast-more';
    more.textContent = `ほか${sabotageToastQueue.length}件…`;
    toast.appendChild(more);
  }
  toast.classList.remove('hidden');
  // 再表示のたびにポップのアニメーションをやり直す
  toast.style.animation = 'none';
  void toast.offsetWidth;
  toast.style.animation = '';
  sabotageToastTimer = setTimeout(showNextSabotageToast, 3500);
}

// 客層は補助（交換・出禁）によりプレイヤーごとに内容が変わっていくため、ここには
// 「全員共通の公開履歴」ではなく「自分が現在持っている客層」を表示する
function renderCustomers(s) {
  const bar = el('customerBar');
  bar.innerHTML = '';
  const me = s.players.find((p) => p.id === s.myId);
  const myCustomers = (me && me.customers) || [];

  const title = document.createElement('h3');
  title.className = 'customer-bar-title';
  title.textContent = '🙋 あなたの客層';
  bar.appendChild(title);

  myCustomers.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'customer-card';
    div.innerHTML = `<span class="customer-icon">${customerIcon(c.typeKey)}</span>
      <b>客${i + 1}：${c.name}</b><br><span class="dur">スリル耐性 ${c.durability}</span>
      <div class="skill">${CUSTOMER_SKILLS[c.typeKey] || c.skillDesc || ''}</div>`;
    bar.appendChild(div);
  });
  // 客層はプレイヤーごとに別々に配られるため、残り人数は「全ラウンド数 − 自分が今持っている人数」で数える
  const totalCustomers = s.rounds || 4;
  if (myCustomers.length < totalCustomers) {
    const div = document.createElement('div');
    div.className = 'customer-card';
    div.innerHTML = `<span class="hint">残り${totalCustomers - myCustomers.length}人は未公開</span>`;
    bar.appendChild(div);
  }
  if (me && me.bannedCustomerTypes && me.bannedCustomerTypes.length) {
    const div = document.createElement('div');
    div.className = 'customer-card';
    div.innerHTML = `<span class="hint">🚫 出禁：${me.bannedCustomerTypes.map((tk) => (CUSTOMER_TABLE_DATA.find((r) => r.typeKey === tk) || {}).name || tk).join('・')}（該当タイプは今後も公開されません）</span>`;
    bar.appendChild(div);
  }
}

function cardLabel(c) {
  if (!c) return '';
  return c.label;
}
// ブレーキは「何だけ速度を下げたか」をラベルに直接表記する
function cardLabelWithBrake(c, brakeReduce) {
  const base = cardLabel(c);
  if (!c) return base;
  const reduce = brakeReduce !== undefined ? brakeReduce : c.brakeReduce;
  if (c.kind === 'part' && c.type === 'brake' && reduce !== undefined) {
    return `${base}(速度-${reduce})`;
  }
  return base;
}

function cardClass(c) {
  if (!c) return '';
  if (c.kind === 'climb') return 'card climb';
  if (c.kind === 'drop') return 'card drop';
  return `card part thrill${c.thrill}`;
}

// このラウンドで置くべきパーツ枚数。補助のパーツ交換・破壊で枚数がずれても
// 「累計でラウンド数×2枚」になるようサーバーが調整した値を使う
function requiredPlacementCount(s) {
  return s && typeof s.myRequiredPlacementCount === 'number' ? s.myRequiredPlacementCount : 2;
}

// 各レールをクライアント側で先読みシミュレーション（配置さえ済んでいれば完全に正確な値になる）
function simulateRailPreview(rail) {
  let altitude = 2;
  let speed = 2;
  const out = [];
  for (let i = 0; i < rail.length; i++) {
    const card = rail[i];
    if (!card) { out.push(null); continue; }
    const isClimb = card.kind === 'climb';
    const isDrop = card.kind === 'drop';
    const type = isClimb ? 'climb' : isDrop ? 'drop' : card.type;
    const isBrake = type === 'brake';
    const entrySpeed = speed;
    if (!isClimb && !isDrop && !isBrake) speed = Math.max(0, speed - 1);
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
        safety = true;
      }
    } else if (type === 'loop') {
      // ループ・サイクロン・ツイストは進入可能な速度が2種類あるため、そのどちらでも成立させる
      // （サーバー側の判定と条件を一致させないと、有効な配置なのに赤字（安全装置作動）で表示されてしまう）
      if (entrySpeed === 3 || entrySpeed === 4) thrill = 4; else safety = true;
    } else if (type === 'airtime') {
      if (entrySpeed === 2 || entrySpeed === 3) thrill = 3; else safety = true;
    } else if (type === 'twist') {
      if (entrySpeed === 1 || entrySpeed === 2) thrill = 2; else safety = true;
    } else if (type === 'curve') {
      thrill = 1;
    } else if (type === 'tunnel') {
      thrill = entrySpeed;
    } else if (type === 'brake') {
      const desired = Number.isFinite(card.brakeReduce) ? card.brakeReduce : 0;
      const actualReduce = Math.max(0, Math.min(entrySpeed, desired));
      thrill = actualReduce;
      speed = entrySpeed - actualReduce;
    }
    if (safety) { thrill = 0; speed = 0; }
    out.push({ altitude, speed, thrill, safety, estimated: false });
  }
  return out;
}

function trialDataFor(playerId, slot) {
  for (let i = trialLines.length - 1; i >= 0; i--) {
    const d = trialLines[i];
    if (d.playerId === playerId && d.slot === slot) return d;
  }
  return null;
}

// 結果発表アニメーション中、そのプレイヤー・そのマスの得点がすでに公開済みかどうかを返す（未公開ならnull）
function revealedScoreFor(s, playerId, slot) {
  if (s.phase !== 'finished' || !resultAnim) return null;
  const idx = s.trialResults.findIndex((r) => r.playerId === playerId);
  if (idx === -1) return null;
  const r = s.trialResults[idx];
  const h = r.history[slot];
  if (!h || !h.cardLabel) return null;
  if (resultAnim.done) return h.totalDelta;
  if (idx < resultAnim.currentIndex) return h.totalDelta;
  if (idx === resultAnim.currentIndex && slot <= resultAnim.step) return h.totalDelta;
  return null;
}

// 高度・速度・スリル値を1つずつ改行して表示する（レールボックスを縦長・省幅にするため）
function appendSlotInfoLines(div, info, suffix) {
  if (!info) return;
  const rows = [
    `高${info.altitude}`,
    `速${info.speed}`,
    `スリル${info.thrill}${suffix || ''}`,
  ];
  rows.forEach((text) => {
    const line = document.createElement('span');
    line.className = 'slot-info' + (info.safety ? ' slot-info-safety' : '');
    line.textContent = text;
    div.appendChild(line);
  });
}

// レールボックス内のカード名を、適切な位置で改行して表示する。
// 配置予定なら「予定」→カード名、ブレーキなら「ブレーキ」→「(速度-N)」を別行にする。
function appendCardLabelLines(div, c, opts) {
  opts = opts || {};
  const reduce = opts.brakeReduce !== undefined ? opts.brakeReduce : (c && c.brakeReduce);
  const isBrake = c && c.kind === 'part' && c.type === 'brake';
  const lines = [];
  if (opts.pending) lines.push('予定');
  lines.push(`${partIcon(c, 'part-icon-img slot-icon-img')} ${cardLabel(c)}`);
  if (isBrake && reduce !== undefined) lines.push(`(速度-${reduce})`);
  lines.forEach((html) => {
    const line = document.createElement('span');
    line.className = 'slot-label';
    line.innerHTML = html;
    div.appendChild(line);
  });
}

// 自分を「下」、他プレイヤーを「上・左・右」に割り当てて、テーブルを囲むような配置にする
// 自分のプレイヤーを一番上にし、全プレイヤーを一列縦に並べる順番を返す。
// （自分の次からは席順をそのまま使うので、誰が次の手番かが分かりやすい）
function orderedPlayersForBoard(s) {
  const meIndex = s.players.findIndex((p) => p.id === s.myId);
  if (meIndex === -1) return s.players.slice();
  const out = [];
  for (let i = 0; i < s.players.length; i++) {
    out.push(s.players[(meIndex + i) % s.players.length]);
  }
  return out;
}

function renderPlayersBoard(s) {
  const board = el('playersBoard');
  // Trial/result ticks also replace panels without going through render().
  const controls = el('myControls');
  if (board.contains(controls)) el('gameScreen').appendChild(controls);
  board.innerHTML = '';
  orderedPlayersForBoard(s).forEach((p) => {
    const isMe = p.id === s.myId;
    const panel = document.createElement('div');
    panel.className = 'player-panel' + (isMe ? ' me' : '');
    panel.dataset.playerId = p.id;

    const head = document.createElement('div');
    head.className = 'player-head';
    head.innerHTML = `<span class="name">${p.name}${isMe ? '（あなた）' : ''}${p.id === s.hostId ? ' 👑' : ''}</span>
      ${p.connected ? '' : '<span class="tag">切断中</span>'}
      ${s.phase === 'placement' ? `<span class="tag">${p.placedThisRound ? '配置済み' : '配置待ち'}</span>` : ''}
      ${s.phase === 'draft' ? `<span class="tag">${p.hasPendingPick ? '選択済み' : '選択待ち'}</span>` : ''}
      ${s.phase === 'sabotage' ? `<span class="tag">${p.pendingSabotageChoices && p.pendingSabotageChoices.length ? '対応待ち' : (p.sabotageSubmitted ? '提出済み' : (p.id === s.sabotageTurnPlayerId ? '🎯手番' : '待機中'))}</span>` : ''}
      ${s.phase === 'recovery' ? `<span class="tag">${p.recoveryTasks && p.recoveryTasks.length ? (p.id === s.recoveryTurnPlayerId ? '🎯復旧中' : '復旧待ち') : '完了'}</span>` : ''}`;
    panel.appendChild(head);
    head.querySelector('.name').textContent = `${p.name}${isMe ? '（あなた）' : ''}${p.id === s.hostId ? ' 👑' : ''}`;

    if (p.customers && p.customers.length) {
      const custRow = document.createElement('div');
      custRow.className = 'player-customers';
      p.customers.forEach((c) => {
        const chip = document.createElement('span');
        chip.className = 'player-customer-chip';
        chip.title = `${c.name}（スリル耐性${c.durability}）`;
        chip.innerHTML = `${customerIcon(c.typeKey, 'customer-icon-img small')}${c.name}`;
        custRow.appendChild(chip);
      });
      if (p.bannedCustomerTypes && p.bannedCustomerTypes.length) {
        const banChip = document.createElement('span');
        banChip.className = 'player-customer-chip banned';
        banChip.textContent = `🚫出禁：${p.bannedCustomerTypes.map((tk) => (CUSTOMER_TABLE_DATA.find((r) => r.typeKey === tk) || {}).name || tk).join('・')}`;
        custRow.appendChild(banChip);
      }
      panel.appendChild(custRow);
    }

    const course = document.createElement('div');
    course.className = 'player-course';
    panel.appendChild(course);

    // ジェットコースターマップ：スタートマスを左端に置き、その右側に
    // 8レールなら縦2マス×挑4マス、16レールなら縦2マス×挑8マスとなるように並べる
    const cols = Math.max(1, Math.ceil(p.rail.length / 2));
    const rail = document.createElement('div');
    rail.className = 'rail rail-map';
    // 左端のスタート列 + マップ本体の列数。
    // マス幅は CSS 変数 --slot-w で決める（スマホでは狭い値に上書きして画面内に収める）
    rail.style.gridTemplateColumns = `auto repeat(${cols}, var(--slot-w, 66px))`;

    const startBox = document.createElement('div');
    startBox.className = 'slot start-slot';
    // スタートマスは左端で1列目・縦2行分をぶち抜きで使う
    startBox.style.gridColumn = '1';
    startBox.style.gridRow = '1 / span 2';
    startBox.innerHTML = `<span class="idx">0</span><span class="slot-info">スタート</span><span class="slot-info">高2</span><span class="slot-info">速2</span>`;
    rail.appendChild(startBox);

    // 自分のレールは、まだ確定していない「配置予定」カードも仮に置いた状態でプレビューする
    const virtualRail = isMe && pendingPlacements.length
      ? p.rail.map((c, i) => {
          const pend = pendingPlacements.find((pp) => pp.slot === i);
          return pend ? { ...pend.card, brakeReduce: pend.brakeReduce } : c;
        })
      : p.rail;
    const preview = simulateRailPreview(virtualRail);
    p.rail.forEach((card, slot) => {
      const div = document.createElement('div');
      div.className = 'slot' + (card ? ' filled' : '');
      // マス1から横に並べ、列数を超えたら下の行へ折り返す
      div.style.gridColumn = String(2 + (slot % cols));
      div.style.gridRow = String(1 + Math.floor(slot / cols));

      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(slot + 1);
      div.appendChild(idx);

      const pendingHere = isMe && pendingPlacements.find((pp) => pp.slot === slot);
      if (card) {
        const live = (s.phase === 'trial' || s.phase === 'finished') ? trialDataFor(p.id, slot) : null;
        const info = live || preview[slot];
        appendSlotInfoLines(div, info, !live && info && info.estimated ? '?' : '');
        appendCardLabelLines(div, card);
        div.title = cardTooltip(card);

        const scoreVal = revealedScoreFor(s, p.id, slot);
        if (scoreVal !== null) {
          const scoreSpan = document.createElement('span');
          scoreSpan.className = 'slot-score' + (scoreVal > 0 ? ' plus' : scoreVal < 0 ? ' minus' : ' zero');
          scoreSpan.textContent = `${scoreVal >= 0 ? '+' : ''}${scoreVal}`;
          div.appendChild(scoreSpan);
        }
      } else if (pendingHere) {
        const info = preview[slot];
        appendSlotInfoLines(div, info, '');
        appendCardLabelLines(div, pendingHere.card, { pending: true, brakeReduce: pendingHere.brakeReduce });
        div.classList.add('pending-slot');
        makeInteractive(div, `マス${slot + 1}：${cardLabel(pendingHere.card)}の配置を取り消す`, () => {
          pendingPlacements = pendingPlacements.filter((pp) => pp.slot !== slot);
          render();
        });
      } else if (isMe && s.phase === 'placement' && !p.placedThisRound && selectedCardId && pendingPlacements.length < requiredPlacementCount(s)) {
        div.classList.add('selectable');
        const label = document.createElement('span');
        label.className = 'slot-action';
        label.textContent = '＋ ここに置く';
        div.appendChild(label);
        makeInteractive(div, `マス${slot + 1}に選択したカードを配置`, () => placeSelectedAt(slot));
      }
      if (card || pendingHere) div.dataset.motionId = `card:${(card || pendingHere.card).id}`;
      div.dataset.focusKey = `slot:${p.id}:${slot}`;
      const lastTrial = trialLines[trialLines.length - 1];
      const resultRunning = s.phase === 'finished' && resultAnim && !resultAnim.done && s.trialResults[resultAnim.currentIndex]?.playerId === p.id && resultAnim.step === slot;
      if (resultRunning || (s.phase === 'trial' && lastTrial && lastTrial.playerId === p.id && lastTrial.slot === slot)) {
        div.classList.add('running-slot');
        const train = document.createElement('span');
        train.className = 'train-marker';
        train.textContent = '🎢';
        div.appendChild(train);
      }
      rail.appendChild(div);
    });

    const railRow = document.createElement('div');
    railRow.className = 'rail-row';
    railRow.appendChild(rail);

    if (s.phase === 'finished' && resultAnim) {
      const totalBox = document.createElement('div');
      totalBox.className = 'rail-total';
      const val = Math.round(resultAnim.totals[p.id] || 0);
      totalBox.innerHTML = `<span class="rail-total-label">合計</span><span class="rail-total-val">${val}</span>`;
      railRow.appendChild(totalBox);
    }

    // ボーナス満足度の計算結果を、マップの右側に表示する
    if (s.phase === 'trial' || s.phase === 'finished') {
      const bonusBox = buildRailBonusBox(s, p.id);
      if (bonusBox) railRow.appendChild(bonusBox);
    }

    course.appendChild(railRow);

    if (isMe && s.phase === 'placement' && !p.placedThisRound) {
      const note = document.createElement('p');
      note.className = 'rail-preview-note';
      const unsafe = preview.map((info, i) => info?.safety ? i + 1 : null).filter(Boolean);
      note.textContent = unsafe.length ? `⚠ 仮の試走：マス${unsafe.join('・')}で安全装置が作動します。空きマスを飛ばした予測なので、前後の配置で変わります。` : '仮の試走：スタートは高度2・速度2。空きマスを飛ばした予測です。番号順に走行します。';
      note.classList.toggle('preview-warning', unsafe.length > 0);
      course.appendChild(note);
    }

    if (p.hand.length && !(isMe && s.phase === 'placement' && !p.placedThisRound)) {
      const label = document.createElement('p');
      label.className = 'hand-label';
      label.textContent = `${isMe ? '集めた手札' : '公開手札'} · ${p.hand.length}枚${isMe ? '' : ' ／ 閲覧のみ'}`;
      course.appendChild(label);
      const row = document.createElement('div');
      row.className = 'hand-row';
      p.hand.forEach((c) => row.appendChild(makeCardEl(c, false)));
      decorateHand(row);
      course.appendChild(row);
    }

    board.appendChild(panel);
    if (isMe) panel.appendChild(controls);
  });
}

function makeCardEl(c, selectable) {
  const d = document.createElement('div');
  d.className = cardClass(c) + ' card-v card-v-compact' + (selectable ? ' selectable' : '');
  if (c.id === selectedCardId) d.className += ' chosen';
  d.title = cardTooltip(c);
  d.appendChild(buildCardVisual(c));
  d.dataset.motionId = `card:${c.id}`;
  d.tabIndex = 0;
  d.setAttribute('aria-label', cardTooltip(c));
  return d;
}

function makeCardOptionBox(c, selectable, onClick) {
  const box = document.createElement('div');
  box.className = 'card-option card-v' + (selectable ? ' selectable' : '') + (c.id === selectedCardId ? ' chosen' : '');
  box.appendChild(buildCardVisual(c));
  box.dataset.motionId = `card:${c.id}`;
  box.setAttribute('aria-pressed', String(c.id === selectedCardId));
  if (selectable && onClick) makeInteractive(box, `${cardLabel(c)}を選ぶ。${cardEffectText(c)}`, () => { if (!actionPending) onClick(); });
  else box.setAttribute('aria-disabled', 'true');
  return box;
}

function placeSelectedAt(slot) {
  const s = latestState;
  const me = s.players.find((p) => p.id === s.myId);
  const options = allMyOptions(me);
  const card = options.find((c) => c.id === selectedCardId);
  if (!card || actionPending || s.phase !== 'placement' || me.placedThisRound || me.rail[slot] || pendingPlacements.some((pp) => pp.slot === slot) || pendingPlacements.length >= requiredPlacementCount(s)) return;

  let brakeReduce;
  if (card.kind === 'part' && card.type === 'brake') {
    brakeReduce = placementBrakeReduce;
  }

  pendingPlacements.push({ cardId: card.id, slot, card, brakeReduce });
  selectedCardId = null;
  render();
  showFeedback(`${cardLabel(card)}をマス${slot + 1}に仮置きしました`);
}

function allMyOptions(me) {
  return me.hand.slice();
}

function renderMyControls(s) {
  const box = el('myControls');
  box.innerHTML = '';
  const me = s.players.find((p) => p.id === s.myId);
  if (!me) return;

  if (s.phase === 'draft') {
    const title = document.createElement('h3');
    title.textContent = '届いたカードから1枚を手札へ';
    box.appendChild(title);
    if (me.hasPendingPick) {
      const p = document.createElement('div');
      p.className = 'hint';
      p.textContent = '選択済みです。他のプレイヤーの選択を待っています…';
      box.appendChild(p);
    } else if (s.myDraftPacket.length === 0) {
      const p = document.createElement('div');
      p.className = 'hint';
      p.textContent = '受け取るカードを待っています…';
      box.appendChild(p);
    } else {
      const info = document.createElement('div');
      info.className = 'hint';
      info.textContent = 'カードを押して選択 → 効果を確認 → 「手札に加える」で決定。';
      box.appendChild(info);
      const row = document.createElement('div');
      row.className = 'card-option-grid';
      s.myDraftPacket.forEach((c) => {
        const e = makeCardOptionBox(c, true, () => {
          draftSelectedCardId = draftSelectedCardId === c.id ? null : c.id;
          render();
        });
        e.classList.toggle('chosen', c.id === draftSelectedCardId);
        e.setAttribute('aria-pressed', String(c.id === draftSelectedCardId));
        row.appendChild(e);
      });
      decorateHand(row);
      box.appendChild(row);
      const selected = s.myDraftPacket.find((c) => c.id === draftSelectedCardId);
      if (selected) {
        const detail = document.createElement('p');
        detail.className = 'selection-detail';
        detail.textContent = `${cardLabel(selected)}：${cardEffectText(selected)}`;
        box.appendChild(detail);
        const confirm = document.createElement('button');
        confirm.className = 'primary';
        confirm.textContent = `${cardLabel(selected)}を手札に加える`;
        confirm.addEventListener('click', () => submitAction('draftPick', { cardId: selected.id }, (res) => {
          if (!res.ok) return showFeedback(res.error);
          draftSelectedCardId = null;
          showFeedback('選択を確定しました。全員が選ぶと残りのカードが回ります。');
        }));
        box.appendChild(confirm);
      }
    }
    return;
  }

  if (s.phase === 'placement') {
    const title = document.createElement('h3');
    title.textContent = `あなたの手札 ／ 配置予定 ${pendingPlacements.length} / ${requiredPlacementCount(s)}枚`;
    box.appendChild(title);

    if (me.placedThisRound) {
      box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: '配置済みです。他のプレイヤーを待っています…' }));
      return;
    }

    const options = allMyOptions(me);
    const usedIds = new Set(pendingPlacements.map((pp) => pp.cardId));

    const needCount = requiredPlacementCount(s);

    const info = document.createElement('div');
    info.className = 'hint';
    if (needCount === 0) {
      // 補助のパーツ交換などで、すでにラウンド数×2枚に達している場合
      info.textContent = `すでに設置枚数（${s.requiredPlacedTotal}枚）に達しているため、今回は配置する必要がありません。「配置を確定」を押してください。`;
    } else {
      info.textContent = selectedCardId ? '選択中のカードを、自分のレールの光るマスに置いてください。もう一度カードを押すと選択を解除できます。' : `手札を選ぶ → 光るマスに置く → ${needCount}枚置いたら確定。カードは空きマスのどこにでも置けます。`;
    }
    box.appendChild(info);

    const row = document.createElement('div');
    row.className = 'card-option-grid placement-picker';
    const canPick = pendingPlacements.length < needCount;
    options.filter((c) => !usedIds.has(c.id)).forEach((c) => {
      const e = makeCardOptionBox(c, canPick, canPick ? () => {
        selectedCardId = c.id === selectedCardId ? null : c.id;
        placementBrakeReduce = 0;
        render();
      } : null);
      row.appendChild(e);
    });
    decorateHand(row);
    box.appendChild(row);

    const selected = options.find((c) => c.id === selectedCardId);
    if (selected) {
      const detail = document.createElement('p');
      detail.className = 'selection-detail';
      detail.textContent = `${cardLabel(selected)}：${cardEffectText(selected)}`;
      box.appendChild(detail);
      if (selected.kind === 'part' && selected.type === 'brake') {
        const label = document.createElement('label');
        label.className = 'brake-setting';
        label.textContent = '下げる速度を指定してから、マスを選択：';
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.value = placementBrakeReduce;
        input.setAttribute('aria-label', 'ブレーキで下げる速度');
        input.addEventListener('input', () => {
          placementBrakeReduce = Number.isFinite(input.valueAsNumber) ? Math.max(0, Math.floor(input.valueAsNumber)) : 0;
        });
        label.appendChild(input);
        box.appendChild(label);
      }
    }

    if (pendingPlacements.length) {
      const list = document.createElement('div');
      list.className = 'hint';
      list.innerHTML = '配置予定：' + pendingPlacements.map((pp) => `${partIcon(pp.card, 'part-icon-img small')}${cardLabelWithBrake(pp.card, pp.brakeReduce)}→マス${pp.slot + 1}`).join('、');
      box.appendChild(list);
      const undoBtn = document.createElement('button');
      undoBtn.textContent = '↶ 最後の配置を取り消す';
      undoBtn.addEventListener('click', () => {
        pendingPlacements.pop();
        render();
      });
      box.appendChild(undoBtn);
    }

    const leftoverCount = options.length - pendingPlacements.length;
    if (leftoverCount > 0) {
      const warn = document.createElement('div');
      warn.className = 'hint';
      warn.textContent = `※ 配置しなかったカード（残り${leftoverCount}枚見込み）は次のラウンドに持ち越せません。ラウンド終了時にすべて捨札になります。`;
      box.appendChild(warn);
    }

    if (pendingPlacements.length === needCount) {
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'primary';
      confirmBtn.textContent = `${needCount}枚の配置を確定`;
      confirmBtn.addEventListener('click', () => {
        submitAction('submitPlacement', {
          placements: pendingPlacements.map((pp) => ({ cardId: pp.cardId, slot: pp.slot, brakeReduce: pp.brakeReduce })),
        }, (res) => {
          if (!res.ok) return showFeedback(res.error);
          pendingPlacements = [];
          selectedCardId = null;
        });
      });
      box.appendChild(confirmBtn);
    }
    return;
  }

  if (s.phase === 'sabotage') {
    renderSabotagePhase(s, me, box);
    return;
  }

  if (s.phase === 'recovery') {
    renderRecoveryPhase(s, me, box);
    return;
  }
}

function makeLabeledSelect(labelText, options, state, key, numeric) {
  if (!options.some((option) => String(option.value) === String(state[key]))) state[key] = options.length ? options[0].value : undefined;
  const wrap = document.createElement('div');
  wrap.className = 'sabotage-field';
  const label = document.createElement('div');
  label.className = 'hint';
  label.textContent = labelText;
  wrap.appendChild(label);
  const select = document.createElement('select');
  select.setAttribute('aria-label', labelText);
  select.disabled = !options.length;
  options.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (String(o.value) === String(state[key])) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => {
    state[key] = numeric ? Number(select.value) : select.value;
    render();
  });
  wrap.appendChild(select);
  return wrap;
}

// ---------- イベントフェイズ ----------
// 2枚配られた補助カードのうち、使えるのは1枚だけ。選ぶ → 効果の対象（客層・パーツ）を選ぶ、の2段階にする。
let sabotageSelectedCardId = null;
let sabotagePlayParams = {}; // 選択中の1枚に対する対象プレイヤー・客層・パーツなどのパラメータ
let pendingChoiceState = {}; // choice.id -> { idx } : 他プレイヤーからの補助への対応（客層/パーツ選択）を保持

// カードごとに「実際に選択可能な対象プレイヤー」だけを返す（対象がいないカードは選べないようにする）
// 「補助カード」なので、自分自身も対象に選べる（allPlayers には自分も含む）。
// ただし「相互交換」系は自分同士では意味がないため、他プレイヤーのみ。
function getValidSabotageTargets(card, me, allPlayers) {
  const others = allPlayers.filter((p) => p.id !== me.id);
  switch (card.type) {
    case 'custRandomSwap':
      return allPlayers.filter((p) => p.customers && p.customers.length > 0);
    case 'custMutualSwap':
      if (!me.customers || me.customers.length === 0) return [];
      return others.filter((p) => p.customers && p.customers.length > 0);
    case 'custBanType':
      return allPlayers.filter((p) => CUSTOMER_TABLE_DATA.some((c) => !(p.bannedCustomerTypes || []).includes(c.typeKey)));
    case 'partDestroy':
      return allPlayers.filter((p) => p.rail.some((c) => c));
    case 'partSwap':
      if (!me.rail.some((c) => c)) return [];
      return others.filter((p) => p.rail.some((c) => c));
    case 'partLevelDown':
      return allPlayers.filter((p) => p.rail.some((c) => c && (c.kind === 'climb' || c.kind === 'drop')));
    default:
      return allPlayers;
  }
}

function renderSabotagePhase(s, me, box) {
  const title = document.createElement('h3');
  title.textContent = 'イベントフェイズ（相手を補助するか、補助への対応をしてください）';
  box.appendChild(title);

  const handIds = new Set((me.sabotageHand || []).map((c) => c.id));
  if (sabotageSelectedCardId && !handIds.has(sabotageSelectedCardId)) {
    sabotageSelectedCardId = null;
    sabotagePlayParams = {};
  }

  // 1. 自分が対応すべき補助（他プレイヤーから受けたカードで、自分の選択が必要なもの）
  // 選択中の値はchoice.idごとに永続化する（renderのたびにstateを作り直すと、選び直しても
  // 常に最初の選択肢に戻ってしまい、実質「最初のパーツしか選べない」不具合になっていた）
  const choiceIds = new Set((me.pendingSabotageChoices || []).map((c) => c.id));
  Object.keys(pendingChoiceState).forEach((id) => { if (!choiceIds.has(id)) delete pendingChoiceState[id]; });

  (me.pendingSabotageChoices || []).forEach((choice) => {
    if (!pendingChoiceState[choice.id]) pendingChoiceState[choice.id] = {};
    const state = pendingChoiceState[choice.id];

    const wrap = document.createElement('div');
    wrap.className = 'sabotage-choice-box';
    const desc = document.createElement('div');
    desc.className = 'hint';
    desc.textContent = `⚠ ${choice.casterName} が「${choice.cardLabel}」を使用しました。対応してください：`;
    wrap.appendChild(desc);

    if (choice.type === 'custRandomSwap') {
      wrap.appendChild(makeLabeledSelect(
        '入れ替える自分の客層：',
        me.customers.map((c, i) => ({ value: i, label: `${c.name}（スリル耐性${c.durability}）` })),
        state, 'idx', true,
      ));
      const btn = document.createElement('button');
      btn.textContent = 'この客層を入れ替える';
      btn.addEventListener('click', () => {
        submitAction('resolveSabotageChoice', { choiceId: choice.id, customerIndex: state.idx }, (res) => {
          if (!res.ok) showFeedback(res.error);
        });
      });
      wrap.appendChild(btn);
    } else if (choice.type === 'partDestroy') {
      const filledSlots = me.rail.map((c, i) => (c ? { value: i, label: `マス${i + 1}：${cardLabel(c)}` } : null)).filter(Boolean);
      if (filledSlots.length === 0) {
        wrap.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: '（設置済みのパーツがありません）' }));
      } else {
        wrap.appendChild(makeLabeledSelect('破壊させる自分のパーツ：', filledSlots, state, 'idx', true));
        const btn = document.createElement('button');
        btn.textContent = 'このパーツを破壊させる';
        btn.addEventListener('click', () => {
          submitAction('resolveSabotageChoice', { choiceId: choice.id, slot: state.idx }, (res) => {
            if (!res.ok) alert(res.error);
          });
        });
        wrap.appendChild(btn);
      }
    }
    box.appendChild(wrap);
  });

  // 2. 自分の補助カードの使用（プレイヤーごとに順番に行う）
  const turnPlayer = s.players.find((p) => p.id === s.sabotageTurnPlayerId);
  const turnTag = document.createElement('div');
  turnTag.className = 'hint sabotage-turn-tag';
  turnTag.textContent = turnPlayer ? `🎯 現在のイベントターン：${turnPlayer.name}${turnPlayer.id === s.myId ? '（あなた）' : ''}` : '';
  box.appendChild(turnTag);

  if (me.sabotageSubmitted) {
    box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: '補助カードは提出済みです。他のプレイヤーを待っています…' }));
    return;
  }
  if (s.sabotageTurnPlayerId !== s.myId) {
    box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: `${turnPlayer ? turnPlayer.name : '他のプレイヤー'} のイベントターンです。順番をお待ちください…` }));
    return;
  }

  // 補助カードは自分も対象にできるため、全プレイヤーを渡す
  const allPlayers = s.players;
  const info = document.createElement('div');
  info.className = 'hint';
  info.textContent = '2枚のうち、使うカードを1枚だけ選んでください（使わなくても構いません）。選ぶと効果の対象を指定できます。';
  box.appendChild(info);

  const handRow = document.createElement('div');
  handRow.className = 'sabotage-hand';
  (me.sabotageHand || []).forEach((card) => {
    const validTargets = getValidSabotageTargets(card, me, allPlayers);
    const usable = validTargets.length > 0;
    const isSelected = sabotageSelectedCardId === card.id;

    const cardBox = document.createElement('div');
    cardBox.className = 'sabotage-card' + (isSelected ? ' active' : '') + (usable ? ' usable' : ' disabled');
    cardBox.dataset.motionId = `card:${card.id}`;

    const head = document.createElement('div');
    head.className = 'sabotage-card-head';
    head.textContent = `[${SABOTAGE_LABELS[card.category] || ''}] ${card.label}`;
    cardBox.appendChild(head);

    const desc = document.createElement('div');
    desc.className = 'sabotage-card-desc';
    desc.textContent = card.desc;
    cardBox.appendChild(desc);

    if (!usable) {
      cardBox.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: '（このカードを使える対象がいません）' }));
      handRow.appendChild(cardBox);
      return;
    }

    const selectBtn = document.createElement('button');
    selectBtn.textContent = isSelected ? '選択中（もう一度押すと解除）' : 'このカードを使う';
    selectBtn.className = isSelected ? 'primary' : '';
    selectBtn.setAttribute('aria-pressed', String(isSelected));
    selectBtn.addEventListener('click', () => {
      sabotageSelectedCardId = isSelected ? null : card.id;
      sabotagePlayParams = {};
      render();
    });
    cardBox.appendChild(selectBtn);

    if (isSelected) {
      cardBox.appendChild(makeLabeledSelect(
        '対象プレイヤー：',
        validTargets.map((op) => ({ value: op.id, label: op.id === s.myId ? `${op.name}（あなた）` : op.name })),
        sabotagePlayParams, 'targetPlayerId', false,
      ));
      const target = s.players.find((p) => p.id === sabotagePlayParams.targetPlayerId);

      if (card.type === 'custMutualSwap') {
        cardBox.appendChild(makeLabeledSelect('自分の客層：', me.customers.map((c, i) => ({ value: i, label: `${c.name}（耐性${c.durability}）` })), sabotagePlayParams, 'myIndex', true));
        if (target) cardBox.appendChild(makeLabeledSelect('相手の客層：', target.customers.map((c, i) => ({ value: i, label: `${c.name}（耐性${c.durability}）` })), sabotagePlayParams, 'targetIndex', true));
      } else if (card.type === 'custBanType') {
        const availableTypes = CUSTOMER_TABLE_DATA.filter((row) => !target || !(target.bannedCustomerTypes || []).includes(row.typeKey));
        cardBox.appendChild(makeLabeledSelect('出禁にする客層タイプ：', availableTypes.map((row) => ({ value: row.typeKey, label: row.name })), sabotagePlayParams, 'typeKey', false));
      } else if (card.type === 'partSwap') {
        cardBox.appendChild(makeLabeledSelect('自分のパーツ：', me.rail.map((c, i) => (c ? { value: i, label: `マス${i + 1}：${cardLabel(c)}` } : null)).filter(Boolean), sabotagePlayParams, 'mySlot', true));
        if (target) cardBox.appendChild(makeLabeledSelect('相手のパーツ：', target.rail.map((c, i) => (c ? { value: i, label: `マス${i + 1}：${cardLabel(c)}` } : null)).filter(Boolean), sabotagePlayParams, 'targetSlot', true));
      } else if (card.type === 'partLevelDown') {
        if (target) {
          const opts = target.rail.map((c, i) => ((c && (c.kind === 'climb' || c.kind === 'drop')) ? { value: i, label: `マス${i + 1}：${cardLabel(c)}` } : null)).filter(Boolean);
          cardBox.appendChild(makeLabeledSelect('相手の巻上/落下パーツ：', opts, sabotagePlayParams, 'targetSlot', true));
        }
      }
    }

    handRow.appendChild(cardBox);
  });
  box.appendChild(handRow);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = sabotageSelectedCardId ? 'primary' : 'secondary';
  confirmBtn.textContent = sabotageSelectedCardId ? '選んだカードを使用して確定' : '何も使わずに確定';
  confirmBtn.addEventListener('click', () => {
    const plays = [];
    if (sabotageSelectedCardId) {
      const card = (me.sabotageHand || []).find((c) => c.id === sabotageSelectedCardId);
      if (!card) { alert('カード情報が更新されました。選び直してください'); sabotageSelectedCardId = null; render(); return; }
      if (!sabotagePlayParams.targetPlayerId) { alert('対象プレイヤーを選んでください'); return; }
      const play = { cardId: card.id, targetPlayerId: sabotagePlayParams.targetPlayerId };
      if (card.type === 'custMutualSwap') {
        if (sabotagePlayParams.myIndex === undefined || sabotagePlayParams.targetIndex === undefined) { alert('客層を選んでください'); return; }
        play.myIndex = sabotagePlayParams.myIndex;
        play.targetIndex = sabotagePlayParams.targetIndex;
      } else if (card.type === 'custBanType') {
        if (!sabotagePlayParams.typeKey) { alert('客層タイプを選んでください'); return; }
        play.typeKey = sabotagePlayParams.typeKey;
      } else if (card.type === 'partSwap') {
        if (sabotagePlayParams.mySlot === undefined || sabotagePlayParams.targetSlot === undefined) { alert('パーツを選んでください'); return; }
        play.mySlot = sabotagePlayParams.mySlot;
        play.targetSlot = sabotagePlayParams.targetSlot;
      } else if (card.type === 'partLevelDown') {
        if (sabotagePlayParams.targetSlot === undefined) { alert('パーツを選んでください'); return; }
        play.targetSlot = sabotagePlayParams.targetSlot;
      }
      plays.push(play);
    }
    submitAction('submitSabotage', { plays }, (res) => {
      if (!res.ok) return alert(res.error);
      sabotageSelectedCardId = null;
      sabotagePlayParams = {};
    });
  });
  box.appendChild(confirmBtn);
}

// ---------- 復旧フェイズ ----------
let recoveryChoiceState = {}; // taskId -> { cardId, position, brakeReduce }

function renderRecoveryPhase(s, me, box) {
  const title = document.createElement('h3');
  title.textContent = '復旧フェイズ';
  box.appendChild(title);

  const taskIds = new Set((me.recoveryTasks || []).map((t) => t.id));
  Object.keys(recoveryChoiceState).forEach((id) => { if (!taskIds.has(id)) delete recoveryChoiceState[id]; });

  const turnPlayer = s.players.find((p) => p.id === s.recoveryTurnPlayerId);
  const turnTag = document.createElement('div');
  turnTag.className = 'hint sabotage-turn-tag';
  turnTag.textContent = turnPlayer ? `🎯 現在の復旧ターン：${turnPlayer.name}${turnPlayer.id === s.myId ? '（あなた）' : ''}` : '';
  box.appendChild(turnTag);

  if (!me.recoveryTasks || me.recoveryTasks.length === 0) {
    box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: '復旧の必要はありません。他のプレイヤーの復旧を待っています…' }));
    return;
  }
  if (s.recoveryTurnPlayerId !== s.myId) {
    box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: `${turnPlayer ? turnPlayer.name : '他のプレイヤー'} の復旧ターンです。順番をお待ちください…` }));
    return;
  }

  me.recoveryTasks.forEach((task) => {
    if (!recoveryChoiceState[task.id]) recoveryChoiceState[task.id] = {};
    const state = recoveryChoiceState[task.id];

    const wrap = document.createElement('div');
    wrap.className = 'recovery-task-box';
    const label = document.createElement('div');
    label.className = 'hint';
    const mandatory = task.type === 'destroyed' && task.drawnCards.length > 0;
    if (task.type === 'destroyed') {
      label.textContent = mandatory
        ? `マス${task.slot + 1}が破壊されました。一般パーツを${task.drawnCards.length}枚引きました。この中から1枚を選んでそのマスに設置してください（必須）：`
        : `マス${task.slot + 1}が破壊されましたが、山札切れのため復旧できませんでした。`;
    } else {
      label.textContent = `マス${task.slot + 1}のパーツが交換されました。一般パーツを${task.drawnCards.length}枚引きました。そのマス、またはその前後1マスに設置できます（すでにパーツがあっても上書きされます）：`;
    }
    wrap.appendChild(label);

    // 同じ見た目（種類・レベル）のカードが複数枚引かれても、選択肢としては1つだけ表示する
    const seenSig = new Set();
    const uniqueCards = task.drawnCards.filter((c) => {
      const sig = `${c.kind}:${c.type || ''}:${c.value || ''}`;
      if (seenSig.has(sig)) return false;
      seenSig.add(sig);
      return true;
    });

    const optionsRow = document.createElement('div');
    optionsRow.className = 'card-option-grid';
    uniqueCards.forEach((c) => {
      const e = makeCardOptionBox(c, true, () => {
        state.cardId = state.cardId === c.id ? null : c.id;
        render();
      });
      if (c.id === state.cardId) e.classList.add('chosen');
      e.setAttribute('aria-pressed', String(c.id === state.cardId));
      optionsRow.appendChild(e);
    });
    decorateHand(optionsRow);
    wrap.appendChild(optionsRow);

    if (state.cardId) {
      const card = task.drawnCards.find((c) => c.id === state.cardId);
      if (task.type === 'swapped') {
        const selfOk = task.slot >= 0 && task.slot < me.rail.length;
        const beforeOk = task.slot - 1 >= 0;
        const afterOk = task.slot + 1 < me.rail.length;
        const posWrap = document.createElement('div');
        posWrap.className = 'sabotage-field';
        if (beforeOk) {
          const b = document.createElement('button');
          b.textContent = `マス${task.slot}に設置${me.rail[task.slot - 1] ? '（上書き）' : ''}`;
          b.className = state.position === 'before' ? 'primary' : '';
          b.addEventListener('click', () => { state.position = 'before'; render(); });
          posWrap.appendChild(b);
        }
        if (selfOk) {
          const b = document.createElement('button');
          b.textContent = `マス${task.slot + 1}（交換されたマス）に設置${me.rail[task.slot] ? '（上書き）' : ''}`;
          b.className = state.position === 'self' ? 'primary' : '';
          b.addEventListener('click', () => { state.position = 'self'; render(); });
          posWrap.appendChild(b);
        }
        if (afterOk) {
          const b = document.createElement('button');
          b.textContent = `マス${task.slot + 2}に設置${me.rail[task.slot + 1] ? '（上書き）' : ''}`;
          b.className = state.position === 'after' ? 'primary' : '';
          b.addEventListener('click', () => { state.position = 'after'; render(); });
          posWrap.appendChild(b);
        }
        wrap.appendChild(posWrap);
      }
      if (card && card.kind === 'part' && card.type === 'brake') {
        const brakeWrap = document.createElement('div');
        brakeWrap.className = 'hint';
        brakeWrap.textContent = 'ブレーキ：下げる速度の値';
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.value = state.brakeReduce !== undefined ? state.brakeReduce : 0;
        input.style.width = '60px';
        input.setAttribute('aria-label', '復旧するブレーキで下げる速度');
        input.addEventListener('input', () => { state.brakeReduce = Math.max(0, parseInt(input.value, 10) || 0); });
        brakeWrap.appendChild(input);
        wrap.appendChild(brakeWrap);
      }

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'primary';
      confirmBtn.textContent = 'このパーツを設置する';
      confirmBtn.disabled = task.type === 'swapped' && !state.position;
      confirmBtn.addEventListener('click', () => {
        if (task.type === 'swapped' && !state.position) { alert('設置する位置を選んでください'); return; }
        submitAction('resolveRecovery', {
          taskId: task.id,
          cardId: state.cardId,
          position: state.position,
          brakeReduce: state.brakeReduce,
        }, (res) => {
          if (!res.ok) return alert(res.error);
          delete recoveryChoiceState[task.id];
        });
      });
      wrap.appendChild(confirmBtn);
    }

    // パーツ破壊（レベル低下による破壊を含む）の復旧は必須のため、山札が残っている限り見送りは選べない
    if (!mandatory) {
      const skipBtn = document.createElement('button');
      skipBtn.textContent = '設置しない（見送る）';
      skipBtn.addEventListener('click', () => {
        submitAction('resolveRecovery', { taskId: task.id }, (res) => {
          if (!res.ok) return alert(res.error);
          delete recoveryChoiceState[task.id];
        });
      });
      wrap.appendChild(skipBtn);
    }

    box.appendChild(wrap);
  });
}

function renderTrial() {
  const log = el('trialLog');
  log.innerHTML = '';
  const s = latestState;
  trialLines.forEach((d) => {
    const p = s.players.find((pl) => pl.id === d.playerId);
    const name = p ? p.name : '?';
    const line = document.createElement('div');
    line.className = 'trial-line' + (d.safety ? ' safety' : '');
    if (!d.card) {
      line.textContent = `${name} - マス${d.slot + 1}：（空き）`;
    } else {
      const custStr = d.customers.map((c) => `${customerIcon(c.typeKey, 'customer-icon-img small')}${c.name}:${c.satisfaction}${c.everReset ? '(固定)' : ''}`).join(' / ');
      line.innerHTML = `${name} - マス${d.slot + 1}：${partIcon(d.card, 'part-icon-img small')}${cardLabel(d.card)} → 高度${d.altitude} 速度${d.speed} スリル${d.thrill}${d.safety ? ' ⚠安全装置作動' : ''}｜${custStr}`;
    }
    log.appendChild(line);
  });
  log.scrollTop = log.scrollHeight;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderScoreBar(s) {
  const bar = el('scoreBar');
  bar.innerHTML = '';
  if (!resultAnim) return;
  const activePlayerId = resultAnim.currentIndex >= 0 && s.trialResults[resultAnim.currentIndex]
    ? s.trialResults[resultAnim.currentIndex].playerId
    : null;
  s.players.forEach((p) => {
    const chip = document.createElement('div');
    const isActive = !resultAnim.done && p.id === activePlayerId;
    chip.className = 'score-chip' + (isActive ? ' bump' : '');
    const val = Math.round(resultAnim.totals[p.id] || 0);
    chip.innerHTML = `<div class="sc-name">${p.name}${p.id === s.myId ? '（あなた）' : ''}${isActive ? ' 🎢' : ''}</div><div class="sc-val">${val}</div>`;
    bar.appendChild(chip);
  });
}

function renderResultsPending(s) {
  el('resultBoard').innerHTML = '';
  const box = el('resultCalc');
  box.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'hint';

  const r = s.trialResults[resultAnim.currentIndex];
  if (!r) {
    title.textContent = '満足度を計算しています…';
    box.appendChild(title);
    return;
  }
  const railLen = r.history.length;

  if (resultAnim.step < railLen) {
    title.textContent = `${r.name} のレールを集計中… マス${resultAnim.step + 1}/${railLen}`;
    const rows = document.createElement('div');
    const h = r.history[resultAnim.step];
    if (h && h.cardLabel) {
      const line = document.createElement('div');
      line.className = 'trial-line' + (h.totalDelta < 0 ? ' safety' : h.totalDelta > 0 ? ' just' : '');
      line.textContent = `マス${resultAnim.step + 1}：${h.cardLabel} → ${h.totalDelta >= 0 ? '+' : ''}${h.totalDelta}点`;
      rows.appendChild(line);
    }
    box.appendChild(rows);
  } else {
    title.textContent = `${r.name} の客層スキルを集計中…`;
  }
  box.insertBefore(title, box.firstChild);
}

// 結果発表アニメーションの1ティック分だけを軽量に再描画する（ページ全体のrender()は呼ばない）。
// 途中でrender()を再帰的に呼ぶと、他の状態更新と絡んで表示が固まる原因になるため、
// アニメーション専用の更新経路として完全に切り離してある。
function renderResultTick(s) {
  el('skipResultBtn').classList.toggle('hidden', !resultAnim || resultAnim.done);
  renderScoreBar(s);
  renderPlayersBoard(s);
  if (resultAnim.done) renderResults(s);
  else renderResultsPending(s);
}

async function runResultAnimation(s) {
  const animation = resultAnim;
  if (reducedMotion()) {
    animation.done = true;
    animation.totals = Object.fromEntries(s.trialResults.map((r) => [r.playerId, r.total]));
    renderResultTick(s);
    return;
  }
  try {
    // 上（1人目）のプレイヤーから順に、1マス目から順に計算結果を反映していく
    for (let idx = 0; idx < s.trialResults.length; idx++) {
      if (resultAnim !== animation || animation.done) return;
      const r = s.trialResults[idx];
      resultAnim.currentIndex = idx;
      const railLen = r.history.length;
      for (let step = 0; step < railLen; step++) {
        if (resultAnim !== animation || animation.done) return;
        resultAnim.step = step;
        const h = r.history[step];
        if (h) resultAnim.totals[r.playerId] += h.totalDelta;
        renderResultTick(s);
        await wait(1000);
      }
      if (resultAnim !== animation || animation.done) return;
      resultAnim.step = railLen;
      renderResultTick(s);
      await wait(800);
      if (resultAnim !== animation || animation.done) return;
      resultAnim.totals[r.playerId] += r.skillTotal;
      renderResultTick(s);
      await wait(600);
    }
  } catch (e) {
    console.error('結果発表アニメーション中にエラーが発生しました。最終結果を直接表示します。', e);
  } finally {
    // 途中で何が起きても、必ず最終結果が正しく表示された状態で終わらせる
    if (resultAnim === animation) {
      resultAnim.currentIndex = s.trialResults.length - 1;
      resultAnim.totals = Object.fromEntries(s.trialResults.map((r) => [r.playerId, r.total]));
      resultAnim.done = true;
      renderResultTick(s);
    }
  }
}

// 試運転フェイズ／結果発表で、ボーナス満足度の計算結果を各プレイヤーのマップの右側に表示する。
// スキルボーナスは全マス走り終わってから加算されるため、そのタイミングに合わせて出す。
function buildRailBonusBox(s, playerId) {
  const r = (s.trialResults || []).find((x) => x.playerId === playerId);
  if (!r) return null;

  // 結果発表アニメーション中は、そのプレイヤーの走行が終わるまでボーナスを伏せておく
  let revealed = true;
  if (resultAnim && !resultAnim.done) {
    const idx = s.trialResults.findIndex((x) => x.playerId === playerId);
    if (idx > resultAnim.currentIndex) revealed = false;
    else if (idx === resultAnim.currentIndex && resultAnim.step < r.history.length) revealed = false;
  }

  const box = document.createElement('div');
  box.className = 'rail-bonus';

  const title = document.createElement('div');
  title.className = 'rail-bonus-title';
  title.textContent = '🎁 ボーナス満足度';
  box.appendChild(title);

  if (!revealed) {
    const wait = document.createElement('div');
    wait.className = 'rail-bonus-wait';
    wait.textContent = '試運転中…';
    box.appendChild(wait);
    return box;
  }

  const addRow = (mark, name, pt, achieved) => {
    const row = document.createElement('div');
    row.className = 'rail-bonus-row' + (achieved ? ' achieved' : '');
    row.innerHTML = `<span class="rb-mark">${mark}</span><span class="rb-name">${name}</span><span class="rb-pt">${pt}</span>`;
    box.appendChild(row);
  };

  // 客層スキル
  r.skills.forEach((sk) => {
    addRow(sk.achieved ? '☑' : '☐', `${customerIcon(sk.typeKey, 'customer-icon-img small')} ${sk.name}`,
      (sk.achieved || sk.bonus) ? `+${sk.bonus}` : '±0', sk.achieved || sk.bonus > 0);
  });
  // 記録更新
  (r.records || []).forEach((rec) => addRow('🏅', rec.label, `+${rec.bonus}`, true));
  // 着地ボーナス
  if (r.endAltitudeBonus) addRow('🛬', '着地ボーナス', `+${r.endAltitudeBonus}`, true);

  const sum = document.createElement('div');
  sum.className = 'rail-bonus-sum';
  sum.innerHTML = `<span>ボーナス計</span><span class="rb-sum-val">+${r.skillTotal}</span>`;
  box.appendChild(sum);

  return box;
}

function renderResults(s) {
  el('resultCalc').innerHTML = '';
  const box = el('resultBoard');
  box.innerHTML = '';
  if (s.winners && s.winners.length) {
    const w = document.createElement('div');
    w.style.fontSize = '18px';
    w.style.marginBottom = '10px';
    w.textContent = `勝者：${s.winners.join(' / ')} 🎉`;
    box.appendChild(w);
  }
  const sorted = [...s.trialResults].sort((a, b) => b.total - a.total);
  sorted.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'result-row' + (s.winners && s.winners.includes(r.name) ? ' winner' : '');
    const skillStr = r.skills.filter((sk) => sk.achieved || sk.bonus).map((sk) => `${customerIcon(sk.typeKey, 'customer-icon-img small')}${sk.name}+${sk.bonus}`).join('、');
    row.innerHTML = `<span>${r.name}</span><span>満足度合計 ${r.satisfactionTotal} ＋ スキル ${r.skillTotal}（${skillStr || 'なし'}） ＝ <b>${r.total}</b></span>`;
    box.appendChild(row);

    const checklist = document.createElement('div');
    checklist.className = 'bonus-checklist';
    (r.records || []).forEach((rec) => {
      const item = document.createElement('div');
      item.className = 'bonus-check-item achieved';
      item.innerHTML = `<span class="bonus-check-mark">🏅</span><span class="bonus-check-name">${rec.label}</span><span class="bonus-check-cond">記録更新（全員中の最高記録）</span><span class="bonus-check-pt">+${rec.bonus}</span>`;
      checklist.appendChild(item);
    });
    if (r.endAltitudeBonus) {
      const item = document.createElement('div');
      item.className = 'bonus-check-item achieved';
      item.innerHTML = `<span class="bonus-check-mark">🛬</span><span class="bonus-check-name">着地ボーナス</span><span class="bonus-check-cond">試運転終了時の高度が0</span><span class="bonus-check-pt">+${r.endAltitudeBonus}</span>`;
      checklist.appendChild(item);
    }
    r.skills.forEach((sk) => {
      const condText = (CUSTOMER_SKILLS[sk.typeKey] || '').split(' → ')[0];
      const item = document.createElement('div');
      item.className = 'bonus-check-item' + (sk.achieved ? ' achieved' : '');
      item.innerHTML = `<span class="bonus-check-mark">${sk.achieved ? '☑' : '☐'}</span><span class="bonus-check-name">${customerIcon(sk.typeKey, 'customer-icon-img small')} ${sk.name}</span><span class="bonus-check-cond">${condText}</span><span class="bonus-check-pt">${sk.achieved || sk.bonus ? '+' + sk.bonus : '±0'}</span>`;
      checklist.appendChild(item);
    });
    box.appendChild(checklist);
  });
}
