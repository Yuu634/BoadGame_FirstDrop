'use strict';

// ---- 一般パーツ (33枚) ----
// 進入速度の許容条件（condition）：twist/airtime/loopは「ちょうど1値」ではなく2値のいずれかを許容する
const PART_DEFS = [
  { type: 'curve', count: 10, thrill: 1, condition: null },
  { type: 'twist', count: 7, thrill: 2, condition: [1, 2] },
  { type: 'airtime', count: 5, thrill: 3, condition: [2, 3] },
  { type: 'tunnel', count: 4, thrill: 0, condition: null },
  { type: 'brake', count: 4, thrill: 0, condition: null },
  { type: 'loop', count: 3, thrill: 4, condition: [3, 4] },
];

const PART_LABELS = {
  curve: 'カーブ',
  twist: 'ツイスト',
  airtime: 'サイクロン',
  tunnel: 'トンネル',
  brake: 'ブレーキ',
  loop: 'ループ',
  climb: '巻上',
  drop: '落下',
};

// ---- 巻上デッキ (18枚：Lv2/3/4 各6枚) ----
const CLIMB_DEFS = [
  { value: 2, count: 6 },
  { value: 3, count: 6 },
  { value: 4, count: 6 },
];

// ---- 落下デッキ (18枚：Lv1廃止、Lv2/3/4 各6枚) ----
const DROP_DEFS = [
  { value: 2, count: 6 },
  { value: 3, count: 6 },
  { value: 4, count: 6 },
];

// ---- 客層カード (6種類×2枚=12枚) ----
const CUSTOMER_TYPES = [
  { key: 'elder', name: '常連の老人', durability: 2, skillDesc: '全レールにおいてスリル値2以下 → +15', skillPoints: 15 },
  { key: 'family', name: '家族連れ', durability: 2, skillDesc: '異なるパーツ種類を5種類以上通過 → +10', skillPoints: 10 },
  { key: 'schoolTrip', name: '修学旅行生', durability: 3, skillDesc: 'スリル値が3マス連続で上昇 → +10', skillPoints: 10 },
  { key: 'streamer', name: '動画配信者', durability: 3, skillDesc: '最終マスが最大スリル値 → +12', skillPoints: 12 },
  { key: 'couple', name: 'カップル', durability: 4, skillDesc: '+4×(トンネル枚数)', skillPoints: 4 },
  { key: 'thrillSeeker', name: '絶叫マニア', durability: 5, skillDesc: 'スリル4以上のマスを3回通過 → +12', skillPoints: 12 },
];

const RAIL_SIZE = 8;
const ROUNDS = 4;
const JUST_MATCH_BONUS = 5;
const OVER_MATCH_PENALTY = 2;

// ---- ルール設定 ----
const RAIL_SIZE_OPTIONS = [8, 16];
const DEFAULT_SETTINGS = {
  railSize: 8,
  endAltitudeZeroBonus: false,
  recordsEnabled: true,
  sabotageEnabled: true,
};
const END_ALTITUDE_ZERO_BONUS_POINTS = 10;

// ---- 記録更新（毎ゲームランダムに2項目が選ばれる） ----
const RECORD_DEFS = [
  {
    key: 'maxSpeed',
    label: '最高速度記録',
    unit: '速度',
    bonus: 8,
    desc: '試運転中に到達した最高速度が、全プレイヤーの中で最も高かった人にボーナス満足度が贈られます。',
  },
  {
    key: 'maxAltitude',
    label: '最高高度記録',
    unit: '高度',
    bonus: 8,
    desc: '試運転中に到達した最高高度が、全プレイヤーの中で最も高かった人にボーナス満足度が贈られます。',
  },
  {
    key: 'maxCustomerSatisfaction',
    label: '満足度記録',
    unit: '満足度',
    bonus: 8,
    desc: '自分の客のうち最も満足度が高い1人を選び、その満足度が全プレイヤーの中で最も高かった人にボーナス満足度が贈られます。',
  },
  {
    key: 'totalDropHeight',
    label: '落下高低差記録',
    unit: '高低差',
    bonus: 8,
    desc: '成功した落下カードの高低差の合計が、全プレイヤーの中で最も大きかった人にボーナス満足度が贈られます。',
  },
];

// ---- 妨害カード（客層妨害3種＋パーツ妨害3種、各4枚＝計24枚） ----
const SABOTAGE_DEFS = [
  {
    type: 'custRandomSwap',
    category: 'customer',
    label: '客層ランダム交換',
    desc: '対象を1人指定する。対象は自分の客層を1人選び、その客層をランダムな新しい客層と入れ替える（入れ替える客層は対象が指定）。',
    needsTargetChoice: true,
  },
  {
    type: 'custMutualSwap',
    category: 'customer',
    label: '客層相互交換',
    desc: '対象を1人指定し、自分の客層1人と対象の客層1人を、それぞれ自分で選んで入れ替える。',
    needsTargetChoice: false,
  },
  {
    type: 'custBanType',
    category: 'customer',
    label: '客層出禁',
    desc: '対象を1人指定し、客層を1種類選ぶ。対象には今後そのタイプの客層が公開されなくなる（その回はスキップされる）。',
    needsTargetChoice: false,
  },
  {
    type: 'partDestroy',
    category: 'part',
    label: 'パーツ破壊',
    desc: '対象を1人指定する。対象は自分のレールに設置済みのパーツを1つ選び、それを破壊する（空きマスに戻る）。破壊された対象は復旧フェイズを行う。',
    needsTargetChoice: true,
  },
  {
    type: 'partSwap',
    category: 'part',
    label: 'パーツ交換',
    desc: '対象を1人指定し、自分のパーツ1つと対象のパーツ1つを、それぞれ自分で選んで入れ替える。両者とも復旧フェイズを行う。',
    needsTargetChoice: false,
  },
  {
    type: 'partLevelDown',
    category: 'part',
    label: 'レベルダウン',
    desc: '対象を1人指定し、対象の巻上または落下パーツを1つ選ぶ。そのレベルを1下げる（Lv2はこれ以上下げられないため破壊され、復旧フェイズを行う）。',
    needsTargetChoice: false,
  },
];
const SABOTAGE_COPIES_PER_TYPE = 4;
const SABOTAGE_LABELS = Object.fromEntries(SABOTAGE_DEFS.map((d) => [d.type, d.label]));

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let uidCounter = 1;
function nextId(prefix) {
  return `${prefix}_${uidCounter++}`;
}

function buildGeneralDeck() {
  const cards = [];
  for (const def of PART_DEFS) {
    for (let i = 0; i < def.count; i++) {
      cards.push({
        id: nextId('part'),
        kind: 'part',
        type: def.type,
        thrill: def.thrill,
        condition: def.condition,
        label: PART_LABELS[def.type],
      });
    }
  }
  return shuffle(cards);
}

function buildClimbDeck() {
  const cards = [];
  for (const def of CLIMB_DEFS) {
    for (let i = 0; i < def.count; i++) {
      cards.push({ id: nextId('climb'), kind: 'climb', value: def.value, label: `巻上Lv${def.value}` });
    }
  }
  return shuffle(cards);
}

function buildDropDeck() {
  const cards = [];
  for (const def of DROP_DEFS) {
    for (let i = 0; i < def.count; i++) {
      cards.push({ id: nextId('drop'), kind: 'drop', value: def.value, label: `落下Lv${def.value}` });
    }
  }
  return shuffle(cards);
}

function pickRecords(n) {
  return shuffle(RECORD_DEFS).slice(0, n);
}

function buildSabotageDeck() {
  const cards = [];
  for (const def of SABOTAGE_DEFS) {
    for (let i = 0; i < SABOTAGE_COPIES_PER_TYPE; i++) {
      cards.push({ id: nextId('sab'), type: def.type, category: def.category, label: def.label, desc: def.desc });
    }
  }
  return shuffle(cards);
}

function buildCustomerDeck() {
  const cards = [];
  for (const t of CUSTOMER_TYPES) {
    for (let i = 0; i < 2; i++) {
      cards.push({ id: nextId('cust'), typeKey: t.key, name: t.name, durability: t.durability, skillDesc: t.skillDesc });
    }
  }
  return shuffle(cards);
}

module.exports = {
  PART_DEFS,
  PART_LABELS,
  CLIMB_DEFS,
  DROP_DEFS,
  CUSTOMER_TYPES,
  RAIL_SIZE,
  ROUNDS,
  JUST_MATCH_BONUS,
  OVER_MATCH_PENALTY,
  RAIL_SIZE_OPTIONS,
  DEFAULT_SETTINGS,
  END_ALTITUDE_ZERO_BONUS_POINTS,
  RECORD_DEFS,
  pickRecords,
  SABOTAGE_DEFS,
  SABOTAGE_LABELS,
  SABOTAGE_COPIES_PER_TYPE,
  shuffle,
  nextId,
  buildGeneralDeck,
  buildClimbDeck,
  buildDropDeck,
  buildCustomerDeck,
  buildSabotageDeck,
};
