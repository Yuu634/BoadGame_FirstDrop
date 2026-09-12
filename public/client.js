'use strict';

const socket = io();

const CUSTOMER_SKILLS = {
  elder: '全レールにおいてスリル値2以下 → +15',
  family: '異なるパーツ種類を5種類以上通過 → +10',
  schoolTrip: 'スリル値が3マス連続で上昇 → +10',
  streamer: '最終マスが最大スリル値 → +12',
  couple: 'トンネル通過ごとに → +4×(トンネル枚数)',
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
let pendingPlacements = []; // {cardId, slot, card}
const trialLines = [];
let resultAnim = null; // { totals:{playerId:number}, currentIndex:number, step:number, done:boolean }

const el = (id) => document.getElementById(id);

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

// ---------- socket state events ----------
socket.on('state', (state) => {
  latestState = state;
  render();
});

socket.on('log', () => {});

socket.on('trialStep', (detail) => {
  trialLines.push(detail);
  renderTrial();
});

socket.on('gameOver', () => {
  // final 'state' event carries the same info; nothing extra needed
});

// ---------- rendering ----------
function render() {
  if (!latestState) return;
  const s = latestState;
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
  renderPlayersBoard(s);
  renderMyControls(s);

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
}

function renderRecordsBar(s) {
  const bar = el('recordsBar');
  const active = s.activeRecords || [];
  const show = s.phase !== 'lobby' && active.length > 0;
  bar.classList.toggle('hidden', !show);
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
