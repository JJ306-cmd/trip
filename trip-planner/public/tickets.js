// 오가는 교통편 화면. 선택한 편의 시각은 동선에 반영합니다.
import { hhmm } from './planner.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
};
const get = async (url) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청에 실패했어요.');
  return data;
};
const picked = { go: null, back: null };
let listener = () => {};
let version = 0;
export const travelTimes = () => picked;
export const onTravelChange = (fn) => { listener = fn; };
const say = (text) => { $('t-status').textContent = text; };
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function showPicked() {
  const line = (label, t) => t && `${label}: ${t.date} ${t.name} ${t.from} ${hhmm(t.depart)} → ${t.to} ${hhmm(t.arrive)}`;
  $('t-picked').replaceChildren(...[line('가는 편', picked.go), line('오는 편', picked.back)].filter(Boolean)
    .map((text) => el('div', { textContent: text })));
}

function reset() {
  version++;
  picked.go = picked.back = null;
  showPicked();
  $('t-list').replaceChildren();
  listener();
}

async function findStations() {
  reset();
  const kind = $('t-kind').value;
  const mine = version;
  say('역·터미널 찾는 중…');
  $('t-select').hidden = true;
  try {
    for (const side of ['from', 'to']) {
      const q = $(`t-${side}-q`).value.trim();
      if (!q) throw new Error('출발지와 도착지 이름을 모두 입력해 주세요.');
      const list = await get(`/api/tickets/stations?kind=${kind}&q=${encodeURIComponent(q)}`);
      if (mine !== version) return;
      if (!list.length) throw new Error(`"${q}" 이름의 역·터미널이 없어요.`);
      $(`t-${side}`).replaceChildren(...list.map((s) => el('option', { value: s.id, textContent: s.city ? `${s.name} (${s.city})` : s.name, title: s.name })));
    }
    $('t-select').hidden = false;
    say(kind === 'intercity' ? '시외버스는 오늘 출발편만 조회돼요.' : '역·터미널과 날짜를 고르세요.');
  } catch (e) { if (mine === version) say(e.message); }
}

async function lookup(direction) {
  const kind = $('t-kind').value;
  const [a, b] = direction === 'go' ? ['from', 'to'] : ['to', 'from'];
  const date = $(direction === 'go' ? 't-date' : 't-back-date').value;
  if (!date) return say('날짜를 골라 주세요.');
  const mine = ++version;
  const name = (side) => $(`t-${side}`).selectedOptions[0].title;
  const from = name(a), to = name(b);
  say('시간표 조회 중…');
  $('t-list').replaceChildren();
  try {
    const rows = await get(`/api/tickets/timetable?kind=${kind}&from=${$(`t-${a}`).value}&to=${$(`t-${b}`).value}&date=${date}`);
    if (mine !== version) return;
    say(rows.length ? `${from} → ${to} ${rows.length}편` : '조회된 직행편이 없어요.');
    $('t-list').replaceChildren(...rows.map((r) => el('li', {},
      el('span', { textContent: `${hhmm(r.depart)} → ${hhmm(r.arrive)} · ${r.name}${r.fare ? ` · ${r.fare.toLocaleString()}원` : ''}` }),
      el('button', { type: 'button', textContent: '선택', onclick: () => {
        picked[direction] = { ...r, from, to, date };
        showPicked();
        listener();
      } }),
    )));
  } catch (e) { if (mine === version) say(e.message); }
}

let available = false;

// 대중교통일 때만 보여줌. 자차로 바꾸면 선택한 편을 해제해 일정에 반영되지 않게 함
export function showTickets(transit) {
  $('tickets').hidden = !(available && transit);
  if (transit) return;
  version++;
  picked.go = picked.back = null;
  showPicked();
  $('t-list').replaceChildren();
  say('');
}

export function initTickets(enabled, transit) {
  available = enabled;
  showTickets(transit);
  $('t-date').value = $('t-back-date').value = today;
  $('t-find').addEventListener('click', findStations);
  $('t-go').addEventListener('click', () => lookup('go'));
  $('t-back').addEventListener('click', () => lookup('back'));
  for (const id of ['t-kind', 't-from-q', 't-to-q']) {
    $(id).addEventListener('change', () => { reset(); $('t-select').hidden = true; say(''); });
  }
  for (const id of ['t-from', 't-to']) $(id).addEventListener('change', () => { reset(); say(''); });
  // 날짜를 바꾸면 그 방향의 선택만 해제
  for (const [id, direction] of [['t-date', 'go'], ['t-back-date', 'back']]) {
    $(id).addEventListener('change', () => {
      version++;
      picked[direction] = null;
      showPicked();
      $('t-list').replaceChildren();
      say('');
      listener();
    });
  }
}
