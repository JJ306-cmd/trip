import { splitDays, orderDay, schedule, hhmm, MAX_FOODS_PER_DAY, MAX_ATTRACTIONS_PER_DAY } from './planner.js';
import { initTickets, showTickets, travelTimes, onTravelChange } from './tickets.js';
import { createGuide, carCourseLinks, toLink } from './guide.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
};
const api = async (url, options) => {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청에 실패했어요.');
  return data;
};
const link = (href, text) => /^https?:\/\//.test(href) && el('a', { href, textContent: text, target: '_blank', rel: 'noopener' });
const mode = () => document.querySelector('input[name=mode]:checked').value;
const status = (text) => { $('status').textContent = text; };

let data = null;   // 추천 결과
let plan = null;   // 날짜별 일정
let map = null;
let version = 0;   // 늦게 도착한 응답을 버리기 위한 번호
let forecast = []; // 날짜별 예보
let weatherNote = '';
let hasWeather = false;

// 동행별 하루 기본 명소 수 (체크는 직접 바꿀 수 있음)
const PACE = { family: 2, couple: 3, friends: 4, solo: 3 };
const companionLabel = () => $('companion').selectedOptions[0].textContent;
const dateOf = (index) => new Date(Date.parse($('trip-date').value) + index * 86400000).toISOString().slice(0, 10);

function weatherText(index) {
  const date = dateOf(index);
  const w = forecast.find((f) => f.date === date);
  if (!w) return `${date} 날씨: ${weatherNote || '아직 예보가 없어요.'}`;
  return `${date} 날씨: ${[w.sky, w.min != null && `${w.min}~${w.max}℃`, `강수확률 최고 ${w.pop}%`].filter(Boolean).join(' · ')}`;
}
const rainy = (index) => forecast.some((f) => f.date === dateOf(index) && f.pop >= 60);

function showWeather() {
  $('weather').replaceChildren(...Array.from({ length: Number($('days').value) }, (_, i) => el('div', { textContent: weatherText(i) })));
}

async function loadWeather(center, mine) {
  forecast = [];
  weatherNote = hasWeather ? '확인 중…' : '공공데이터 키가 필요해요.';
  showWeather();
  if (!hasWeather) return;
  try {
    const result = await api(`/api/weather?lat=${center.lat}&lng=${center.lng}`);
    if (data?.center !== center) return;
    forecast = result;
    weatherNote = '';
  } catch (e) { if (data?.center !== center) return; weatherNote = e.message; }
  showWeather();
  if (plan) showDay(plan.current);
}

/* ---------- 지도: 카카오 → OpenStreetMap → 약도 순서로 시도 ---------- */
const load = (tag, props) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), 6000);
  const node = el(tag, { ...props, onload: () => { clearTimeout(timer); resolve(); }, onerror: () => { clearTimeout(timer); reject(new Error('load')); } });
  document.head.append(node);
});
const pin = (n, type) => el('div', { className: `pin ${type}`, textContent: n });

async function kakaoMap(key) {
  await load('script', { src: `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false` });
  await new Promise((r) => window.kakao.maps.load(r));
  const K = window.kakao.maps;
  const view = new K.Map($('map'), { center: new K.LatLng(36.4, 127.9), level: 12 });
  let items = [];
  let mine = null;
  const draw = (stops, paths) => {
    items.forEach((i) => i.setMap(null));
    items = [];
    view.relayout();
    const bounds = new K.LatLngBounds();
    for (const s of stops) {
      const position = new K.LatLng(s.lat, s.lng);
      bounds.extend(position);
      const content = pin(s.n, s.type);
      content.title = s.name;
      items.push(new K.CustomOverlay({ position, content, map: view }));
    }
    for (const p of paths) {
      items.push(new K.Polyline({
        map: view, path: p.points.map(([x, y]) => new K.LatLng(y, x)),
        strokeWeight: 5, strokeColor: '#1668e3', strokeOpacity: 0.8, strokeStyle: p.estimated ? 'shortdash' : 'solid',
      }));
    }
    if (stops.length) view.setBounds(bounds);
  };
  draw.me = (p) => {
    mine?.setMap(null);
    mine = p && new K.CustomOverlay({ position: new K.LatLng(p.lat, p.lng), content: el('div', { className: 'me', title: '내 위치' }), map: view, zIndex: 10 });
  };
  return draw;
}

async function osmMap() {
  const base = 'https://unpkg.com/leaflet@1.9.4/dist/';
  await load('link', { rel: 'stylesheet', href: base + 'leaflet.css' });
  await load('script', { src: base + 'leaflet.js' });
  const L = window.L;
  const view = L.map($('map')).setView([36.4, 127.9], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(view);
  const layer = L.layerGroup().addTo(view);
  let mine = null;
  const draw = (stops, paths) => {
    layer.clearLayers();
    view.invalidateSize();
    for (const s of stops) {
      const icon = L.divIcon({ html: pin(s.n, s.type), className: '', iconSize: [30, 30] });
      L.marker([s.lat, s.lng], { icon, title: s.name }).bindTooltip(el('span', { textContent: s.name })).addTo(layer);
    }
    for (const p of paths) {
      L.polyline(p.points.map(([x, y]) => [y, x]), { color: '#1668e3', weight: 5, dashArray: p.estimated ? '8 8' : null }).addTo(layer);
    }
    if (stops.length) view.fitBounds(stops.map((s) => [s.lat, s.lng]), { padding: [40, 40] });
  };
  draw.me = (p) => {
    mine?.remove();
    mine = p && L.circleMarker([p.lat, p.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(view);
  };
  return draw;
}

// 지도 서비스에 연결할 수 없을 때: 좌표만으로 위치 관계를 그림
function sketchMap() {
  const NS = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text) n.textContent = text;
    return n;
  };
  let project = null, dot = null;
  const draw = (stops, paths) => {
    project = null;
    const svg = make('svg', { class: 'sketch', viewBox: '0 0 800 800' });
    const note = el('p', { className: 'map-note', textContent: '지도 서비스에 연결되지 않아 위치 관계만 보여주는 약도예요.' });
    $('map').replaceChildren(note, svg);
    if (!stops.length) return;
    const all = [...stops.map((s) => [s.lng, s.lat]), ...paths.flatMap((p) => p.points)];
    const xs = all.map((p) => p[0] * 0.81), ys = all.map((p) => p[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = 600 / Math.max(maxX - minX, maxY - minY, 0.005);
    const at = ([x, y]) => [400 + (x * 0.81 - (minX + maxX) / 2) * k, 400 - (y - (minY + maxY) / 2) * k];
    project = (p) => ({ svg, xy: at([p.lng, p.lat]) });
    for (const p of paths) {
      svg.append(make('polyline', { points: p.points.map((q) => at(q).join(',')).join(' '), fill: 'none', stroke: '#1668e3', 'stroke-width': 3, 'stroke-dasharray': p.estimated ? '8 8' : 'none' }));
    }
    for (const s of stops) {
      const [x, y] = at([s.lng, s.lat]);
      svg.append(
        make('circle', { cx: x, cy: y, r: 14, fill: s.type === 'food' ? '#e8663c' : '#1668e3' }),
        make('text', { x, y: y + 5, 'text-anchor': 'middle', fill: '#fff', 'font-size': 14 }, String(s.n)),
        make('text', { x, y: y + 32, 'text-anchor': 'middle', fill: '#17211f', 'font-size': 14 }, s.name),
      );
    }
  };
  draw.me = (p) => {
    dot?.remove();
    dot = null;
    if (!p || !project) return;
    const { svg, xy: [x, y] } = project(p);
    dot = make('circle', { cx: x, cy: y, r: 9, fill: '#1a73e8', stroke: '#fff', 'stroke-width': 3 });
    svg.append(dot);
  };
  return draw;
}

async function initMap(jsKey) {
  for (const start of [jsKey && (() => kakaoMap(jsKey)), osmMap].filter(Boolean)) {
    try { return await start(); } catch (e) { console.warn('지도 로드 실패', e); $('map').replaceChildren(); }
  }
  return sketchMap();
}

const submit = $('search').querySelector('button');

/* ---------- 화면 전환: 홈 / 일정 만들기 / 내 일정 ---------- */
const VIEWS = ['home', 'create', 'result'];
function applyView() {
  const view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
  if (document.body.dataset.view !== view) { document.body.dataset.view = view; window.scrollTo(0, 0); }
  for (const v of VIEWS) $('view-' + v).inert = v !== view;
  for (const a of document.querySelectorAll('[data-nav]')) a.toggleAttribute('aria-current', false);
  document.querySelector(`[data-nav=${view}]`).setAttribute('aria-current', 'page');
  if (view === 'result') redraw();
}
// 지도는 보이는 상태에서 다시 그려야 크기가 맞음
function redraw() {
  if (!map) return;
  if (plan) showDay(plan.current);
  else if (data) map(data.attractions.slice(0, 10).map((p, i) => ({ ...p, n: i + 1 })), []);
}
function go(view) {
  if (location.hash === '#' + view) applyView();
  else location.hash = view;
}
window.addEventListener('hashchange', applyView);

function startRegion(region) {
  if (submit.disabled) return;
  $('region').value = region;
  go('create');
  $('search').requestSubmit();
}
$('hero-search').addEventListener('submit', (event) => {
  event.preventDefault();
  startRegion($('hero-region').value.trim());
});
for (const b of document.querySelectorAll('[data-region]')) b.addEventListener('click', () => startRegion(b.dataset.region));
for (const b of document.querySelectorAll('.styles button')) {
  b.addEventListener('click', () => b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'));
}
for (const b of document.querySelectorAll('.examples button')) b.addEventListener('click', () => { $('preference').value = b.textContent; });
for (const b of document.querySelectorAll('.result-tabs button')) {
  b.addEventListener('click', () => {
    $('view-result').dataset.tab = b.dataset.tab;
    for (const o of document.querySelectorAll('.result-tabs button')) o.setAttribute('aria-pressed', o === b);
    redraw();
  });
}
const styleText = () => {
  const picked = [...document.querySelectorAll('.styles [aria-pressed=true]')].map((b) => b.textContent);
  return picked.length ? `스타일: ${picked.join(', ')}. ` : '';
};

/* ---------- 추천 목록 ---------- */
const selected = () => [...document.querySelectorAll('.places input:checked')]
  .map((box) => [...data.attractions, ...data.foods].find((p) => p.id === box.value));

function updateCount() {
  const s = selected();
  $('count').textContent = `명소 ${s.filter((p) => p.type === 'attraction').length}곳, 맛집 ${s.filter((p) => p.type === 'food').length}곳 선택`;
}

function renderPicks() {
  const days = Number($('days').value);
  const preset = { attractions: days * PACE[$('companion').value], foods: days * MAX_FOODS_PER_DAY };
  for (const key of ['attractions', 'foods']) {
    $(key).replaceChildren(...data[key].map((p, i) => el('li', {},
      el('input', { type: 'checkbox', id: 'p-' + p.id, value: p.id, checked: i < preset[key], onchange: updateCount }),
      el('label', { htmlFor: 'p-' + p.id }, p.name, el('div', { className: 'meta', textContent: [p.category, p.address].filter(Boolean).join(' · ') })),
      p.image && el('img', { src: p.image, alt: '', className: 'thumb', loading: 'lazy' }),
      link(p.url, '리뷰 보기'),
    )));
    if (!data[key].length) $(key).append(el('li', { textContent: '검색 결과가 없어요.' }));
  }
  $('ai-summary').hidden = true;
  $('picks').hidden = false;
  updateCount();
}

$('search').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  go('create');
  button.disabled = true;
  status('추천 장소를 찾는 중…');
  const mine = ++version;
  try {
    const found = await api(`/api/places?region=${encodeURIComponent($('region').value.trim())}&companion=${$('companion').value}`);
    if (mine !== version) return;
    data = found;
    guide.stop();
    plan = null;
    $('plan').hidden = true;
    $('trip-title').textContent = '내 일정';
    $('trip-tags').replaceChildren();
    renderPicks();
    loadWeather(data.center);
    map(data.attractions.slice(0, 10).map((p, i) => ({ ...p, n: i + 1 })), []);
    status('');
  } catch (e) { status(e.message); }
  finally { button.disabled = false; }
});

/* ---------- AI 맞춤 추천 ---------- */
$('ai').addEventListener('click', async () => {
  const mine = ++version;
  const current = data;
  const candidates = [...current.attractions, ...current.foods].slice(0, 40)
    .map(({ id, type, name, category }) => ({ id, type, name, category: category || '' }));
  $('ai').disabled = true;
  status('AI가 고르는 중… (최대 1분)');
  try {
    const answer = await api('/api/ai/recommend', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: $('region').value.trim().slice(0, 40), days: Number($('days').value), preference: `동행: ${companionLabel()}. ${styleText()}${$('preference').value.trim()}`.slice(0, 200), candidates }),
    });
    if (mine !== version || current !== data) return;
    const reasons = new Map(answer.picks.map((p) => [p.id, p.reason]));
    for (const box of document.querySelectorAll('.places input')) {
      box.checked = reasons.has(box.value);
      const label = box.nextElementSibling;
      label.querySelector('.reason')?.remove();
      if (box.checked) label.append(el('div', { className: 'reason', textContent: 'AI: ' + reasons.get(box.value) }));
    }
    updateCount();
    $('ai-summary').textContent = answer.summary;
    $('ai-summary').hidden = false;
    // 이전 일정은 선택과 달라졌으므로 숨김
    guide.stop();
    plan = null;
    $('plan').hidden = true;
    status('AI가 고른 곳을 체크했어요. 확인한 뒤 동선을 만드세요.');
  } catch (e) { status(e.message); }
  finally { $('ai').disabled = false; }
});

/* ---------- 일정 ---------- */
async function build() {
  const places = selected();
  if (!places.length) return status('장소를 하나 이상 골라 주세요.');
  const days = Number($('days').value);
  const travel = mode();
  const [h, m] = ($('start-time').value || '10:00').split(':').map(Number);
  const mine = ++version;
  $('build').disabled = true;
  status('동선을 계산하는 중…');
  try {
    const query = $('origin').value.trim();
    let origin = null;
    if (query) origin = { ...(await api('/api/geocode?q=' + encodeURIComponent(query))), type: 'origin' };
    const result = [];
    const { go, back } = travelTimes();
    for (const [dayIndex, list] of splitDays(places, days, origin).entries()) {
      // 첫날은 선택한 교통편 도착 20분 뒤부터 시작
      const startMinute = dayIndex === 0 && go ? go.arrive + 20 : h * 60 + m;
      const ordered = orderDay(list, { start: origin, startMinute, mode: travel });
      const points = origin && ordered.length ? [origin, ...ordered] : ordered;
      const route = points.length > 1
        ? await api('/api/route', { method: 'POST', body: JSON.stringify({ mode: travel, points }) })
        : { legs: [], toll: null };
      const legSeconds = ordered.map((_, i) => (origin ? route.legs[i] : route.legs[i - 1])?.duration || 0);
      result.push({ origin: ordered.length ? origin : null, points, route, rows: schedule(ordered, legSeconds, startMinute) });
    }
    if (mine !== version) return;
    plan = { id: mine, days: result, mode: travel, go, back: back && { ...back } };
    const period = $('days').selectedOptions[0].textContent;
    $('trip-title').textContent = `${data.center.name} ${period}`;
    $('trip-tags').replaceChildren(...[companionLabel(), travel === 'car' ? '자차' : '대중교통', `장소 ${places.length}곳`]
      .map((t) => el('em', { textContent: '#' + t })));
    showDay(0);
    status('');
    return true;
  } catch (e) { status(e.message); }
  finally { $('build').disabled = false; }
}

const TYPE = { BUS: '버스', SUBWAY: '지하철', WALKING: '도보' };
const minutes = (seconds) => `${Math.max(1, Math.round(seconds / 60))}분`;
function segmentText(s) {
  return [
    [TYPE[s.type] || s.type, s.vehicles.join(', ')].filter(Boolean).join(' '),
    s.seconds != null && minutes(s.seconds),
    s.from && (s.to ? `${s.from} 승차 → ${s.to} 하차` : s.from),
  ].filter(Boolean).join(' · ');
}

function legView(leg, from, to, depart, arrive) {
  const car = plan.mode === 'car';
  const how = leg.walk ? '도보' : car ? '자차' : '대중교통';
  const info = [`${how} 약 ${Math.max(1, Math.round(leg.duration / 60))}분`, `${(leg.distance / 1000).toFixed(1)}km`,
    leg.fare ? `${leg.fare.toLocaleString()}원` : null, leg.estimated ? '(직선거리 추정)' : null].filter(Boolean).join(' · ');
  const spot = (p) => `${encodeURIComponent(p.name.replace(/[,/]/g, ' '))},${p.lat},${p.lng}`;
  const by = leg.walk ? 'walk' : car ? 'car' : 'traffic';
  return el('li', { className: 'leg' },
    el('div', { textContent: '↓ ' + info }),
    depart != null && el('div', { textContent: `${hhmm(depart)} 출발 → ${hhmm(arrive)} 도착 (예상)` }),
    leg.segments?.length && el('ul', {}, ...leg.segments.map((s) => el('li', { textContent: segmentText(s) }))),
    !car && !leg.walk && leg.estimated && el('div', { textContent: '버스·지하철 구간 정보는 불러오지 못했어요.' }),
    leg.note && el('div', { textContent: '경로를 불러오지 못했어요: ' + leg.note.slice(0, 80) }),
    leg.steps.length && el('details', {}, el('summary', { textContent: '상세 안내' }),
      el('ol', {}, ...leg.steps.map((s) => el('li', { textContent: s })))),
    !data.demo && link(`https://map.kakao.com/link/by/${by}/${spot(from)}/${spot(to)}`, '카카오맵에서 길찾기'),
  );
}

const parkingCache = new Map();
function parkingView(place) {
  const box = el('div', { className: 'meta', textContent: '주차장 확인 중…' });
  const key = `${place.name}|${place.lat},${place.lng}`;
  if (!parkingCache.has(key))
    parkingCache.set(key, api(`/api/parking?lat=${place.lat}&lng=${place.lng}&name=${encodeURIComponent(place.name)}`));
  parkingCache.get(key).then(({ own, publicLots, lots }) => {
    const title = { yes: '주차 가능', no: '주차 불가', unknown: '주차 가능 여부 확인 안 됨' }[own.status];
    const lines = [el('div', {}, el('strong', { textContent: title }), own.text ? ` · 관광공사 안내: ${own.text}` : '')];
    // 가능이 확인되지 않으면 대신 세울 곳을 안내
    if (own.status !== 'yes') {
      const list = publicLots.length ? publicLots : lots;
      const heading = publicLots.length ? '근처 공영주차장 (1km 안)'
        : list.length ? '1km 안에서 공영주차장은 검색되지 않았어요. 500m 안의 다른 주차장:'
        : '근처에서 검색된 주차장이 없어요. 방문 전에 확인하세요.';
      lines.push(el('div', { textContent: heading }),
        ...list.map((l) => el('div', {}, `· ${l.name} (직선 ${l.distance}m) `, link(l.url, '위치 보기'))));
    }
    box.replaceChildren(...lines);
  }).catch(() => {
    parkingCache.delete(key); // 다음에 다시 시도
    box.textContent = '주차 정보를 확인하지 못했어요.';
  });
  return box;
}

/* ---------- 코스 따라가기 ---------- */
const guideBox = el('div', { className: 'guide' });
const guide = createGuide({ geolocation: navigator.geolocation, onChange: renderGuide });

function renderGuide(state) {
  map?.me(state && !state.done ? state.position : null);
  const day = plan?.days[plan.current];
  if (!day) return guideBox.replaceChildren();
  const button = (text, onclick) => el('button', { type: 'button', textContent: text, onclick });
  const stops = day.rows.map((r) => r.place);
  if (!state) {
    const links = plan.mode === 'car' && !data.demo
      ? carCourseLinks([...(day.origin ? [day.origin] : []), ...stops]) : [];
    return guideBox.replaceChildren(...[
      stops.length && button('안내 시작', () => guide.start(stops, `${plan.id}:${plan.current}`)),
      ...links.map((href, i) => link(href, links.length > 1 ? `카카오맵에서 전체 코스 ${i + 1}구간` : '카카오맵에서 전체 코스 열기')),
    ].filter(Boolean));
  }
  if (state.done) {
    return guideBox.replaceChildren(el('strong', { textContent: '오늘 코스 안내가 끝났어요.' }), button('닫기', guide.stop));
  }
  const target = state.stops[state.index];
  const far = state.distance == null ? '위치 확인 중…'
    : `남은 직선거리 약 ${state.distance >= 1000 ? (state.distance / 1000).toFixed(1) + 'km' : state.distance + 'm'}`;
  guideBox.replaceChildren(...[
    state.last && el('div', { className: 'hint', textContent: `${state.last.name}: ${state.last.skipped ? '건너뜀' : '도착'}` }),
    el('strong', { textContent: `다음 (${state.index + 1}/${state.stops.length}): ${target.name}` }),
    el('div', { textContent: state.error || far }),
    state.accuracy > 100 && el('div', { className: 'hint', textContent: `위치 오차가 커요(약 ±${state.accuracy}m). 도착하면 직접 눌러 주세요.` }),
    el('div', { className: 'actions' }, button('도착', () => guide.next()), button('건너뛰기', () => guide.next(true)), button('안내 종료', guide.stop)),
    !data.demo && link(toLink(target), '카카오맵에서 길찾기'),
    el('div', { className: 'hint', textContent: '화면이 꺼지거나 다른 앱을 쓰면 위치 확인이 멈출 수 있어요.' }),
  ].filter(Boolean));
}

function showDay(index) {
  // 다른 날이나 새 일정으로 바뀌면 진행 중인 안내를 종료
  if (guide.state() && guide.state().key !== `${plan.id}:${index}`) guide.stop();
  plan.current = index;
  const day = plan.days[index];
  const offset = day.origin ? 1 : 0;
  const items = [];
  const photo = (place, n) => el('div', { className: 'photo' },
    place.image ? el('img', { src: place.image, alt: '' }) : el('i', { textContent: place.type === 'food' ? '🍽️' : place.type === 'origin' ? '🚩' : '📸' }),
    n && el('b', { className: 'num', textContent: n }));
  if (day.origin) items.push(el('li', { className: 'stop' },
    el('time', { textContent: '출발' }), photo({ type: 'origin' }), el('div', {}, el('strong', { textContent: day.origin.name }))));
  day.rows.forEach((r, i) => {
    const li = i + offset - 1;
    if (li >= 0) {
      // 출발지에서 처음 나설 때는 시작 시각, 그 뒤로는 앞 장소를 떠나는 시각
      const depart = i ? day.rows[i - 1].leave : r.arrive - Math.round(day.route.legs[li].duration / 60);
      items.push(legView(day.route.legs[li], day.points[li], day.points[li + 1], plan.mode === 'transit' ? depart : null, r.arrive));
    }
    items.push(el('li', { className: 'stop ' + r.place.type },
      el('time', { textContent: hhmm(r.begin) }),
      photo(r.place, i + 1),
      el('div', {},
        el('strong', { textContent: r.place.name }),
        el('div', { className: 'meta', textContent: `${hhmm(r.begin)}–${hhmm(r.leave)}${r.label ? ' · ' + r.label : ''}${r.wait > 0 ? ` · 도착 후 여유 ${r.wait}분` : ''}` }),
        link(r.place.url, '장소 정보'),
        plan.mode === 'car' && !data.demo && parkingView(r.place)),
    ));
  });
  const total = day.route.legs.reduce((s, l) => s + l.duration, 0);
  const end = day.rows.at(-1)?.leave;
  const body = el('div', { className: 'day-body' }, ...[
    el('p', { className: 'hint', textContent: weatherText(index) }),
    guideBox,
    rainy(index) && el('p', { className: 'banner', textContent: '비나 눈 가능성이 있어요. 실내 장소를 함께 고려하고 우산을 챙기세요.' }),
    el('p', { className: 'hint', textContent: day.rows.length
      ? `이동 약 ${Math.round(total / 60)}분 · ${hhmm(end)} 종료${day.route.toll ? ` · 통행료 ${day.route.toll.toLocaleString()}원` : ''}`
      : '이 날은 배정된 장소가 없어요.' }),
    index === 0 && plan.go && el('p', { className: 'banner', textContent: `${plan.go.to} ${hhmm(plan.go.arrive)} 도착편에 맞춰 20분 뒤부터 계산했어요. 역·터미널에서 첫 장소까지의 이동은 출발지 칸에 입력하면 반영돼요.` }),
    index === plan.days.length - 1 && plan.back && end > plan.back.depart - 30 && el('p', { className: 'banner', textContent: `${hhmm(plan.back.depart)} ${plan.back.from} 출발편에 늦을 수 있어요(일정 종료 ${hhmm(end)}). 장소를 줄이거나 늦은 편을 고르세요.` }),
    end > 21 * 60 && el('p', { className: 'banner', textContent: '일정이 밤 9시를 넘어요. 장소를 줄여 보세요.' }),
    el('ol', { className: 'timeline' }, ...items),
    el('p', { className: 'hint', textContent: '체류시간은 명소 90분, 식사 60분으로 가정했어요. 영업시간·휴무일은 반영되지 않으니 방문 전에 확인하세요.' }),
  ].filter(Boolean));
  // 날짜 머리글을 누르면 그 날을 펼치고 지도도 바꿈
  $('plan').replaceChildren(...plan.days.flatMap((_, i) => {
    const head = el('button', { type: 'button', className: 'day-head', onclick: () => showDay(i) },
      el('b', { textContent: `DAY ${i + 1}` }), el('span', { textContent: dateOf(i) }));
    head.setAttribute('aria-expanded', i === index);
    return i === index ? [head, body] : [head];
  }));
  $('plan').hidden = false;
  map(
    [...(day.origin ? [{ ...day.origin, n: '출' }] : []), ...day.rows.map((r, i) => ({ ...r.place, n: i + 1 }))],
    day.route.legs.map((l, i) => ({
      estimated: l.estimated,
      points: l.path.length > 1 ? l.path : [day.points[i], day.points[i + 1]].map((p) => [p.lng, p.lat]),
    })),
  );
  renderGuide(guide.state());
}

$('build').addEventListener('click', async () => { if (await build()) go('result'); });
// 동행을 바꾸면 추천을 다시 받고, 날짜·기간을 바꾸면 날씨 표시를 갱신
$('companion').addEventListener('change', () => data && $('search').requestSubmit());
for (const id of ['trip-date', 'days']) $(id).addEventListener('change', () => {
  if (!$('trip-date').value || !data) return;
  showWeather();
  if (plan && plan.current < Number($('days').value)) build();
});
$('trip-date').value = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
// 교통편이 바뀌면 이미 만든 일정을 다시 계산
onTravelChange(() => plan && build());
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
  showTickets(mode() === 'transit');
  if (plan) build();
}));

/* ---------- 시작 ---------- */
submit.disabled = true;
$('hero-search').querySelector('button').disabled = true;
const config = await api('/api/config');
map = await initMap(config.jsKey);
$('ai-box').hidden = !config.ai;
initTickets(config.tickets, mode() === 'transit');
hasWeather = config.weather;
submit.disabled = false;
$('hero-search').querySelector('button').disabled = false;
if (!config.live) {
  $('banner').textContent = '예시 모드: 경주만 검색할 수 있고, 식당은 가상이며 이동시간은 추정치예요. 실제 정보는 카카오 API 키를 넣으면 나와요.';
  $('banner').hidden = false;
  $('region').value = '경주';
  $('origin').disabled = true;
}
// 새로고침한 경우 일정이 없으므로 결과 화면 대신 첫 화면
if (location.hash === '#result') history.replaceState(null, '', '#home');
applyView();
