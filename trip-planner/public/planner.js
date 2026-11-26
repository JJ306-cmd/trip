// 동선 계산 (화면과 서버, 테스트에서 함께 쓰는 순수 함수)
// ★직접수정 가능: 체류시간(분)
export const STAY = { attraction: 90, food: 60 };
// ★직접수정 가능: 점심·저녁 시간 (하루의 분 단위)
export const MEALS = [
  { label: '점심', open: 11 * 60 + 30, target: 12 * 60 },
  { label: '저녁', open: 17 * 60, target: 18 * 60 },
];
export const MAX_ATTRACTIONS_PER_DAY = 6;
export const MAX_FOODS_PER_DAY = 2;

export function haversine(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 직선거리 기반 추정치 (실제 경로 API를 쓸 수 없을 때)
export function estimateLeg(a, b, mode) {
  const distance = Math.round(haversine(a, b) * 1.3);
  const walk = distance < 700;
  const kmh = walk ? 4.5 : mode === 'car' ? 30 : 18;
  const wait = walk ? 0 : mode === 'car' ? 3 : 10;
  return {
    distance,
    duration: Math.round(((distance / 1000 / kmh) * 60 + wait) * 60),
    walk, estimated: true,
    path: [[a.lng, a.lat], [b.lng, b.lat]],
    steps: [],
  };
}

function* permutations(list) {
  if (list.length <= 1) { yield list.slice(); return; }
  for (let i = 0; i < list.length; i++) {
    const rest = list.slice(0, i).concat(list.slice(i + 1));
    for (const p of permutations(rest)) yield [list[i], ...p];
  }
}

// legSeconds[i] = i번째 장소로 가는 이동시간. 첫 장소는 출발지가 없으면 0.
export function schedule(places, legSeconds, startMinute) {
  // 오후 3시 이후에 시작하면 첫 식사는 저녁
  let clock = startMinute, meal = startMinute >= 15 * 60 ? 1 : 0;
  return places.map((place, i) => {
    clock += Math.round((legSeconds[i] || 0) / 60);
    const arrive = clock;
    let begin = arrive, label = null, late = 0;
    if (place.type === 'food') {
      const m = MEALS[Math.min(meal++, MEALS.length - 1)];
      begin = Math.max(arrive, m.open);
      label = m.label;
      late = Math.max(0, begin - m.target);
    }
    const leave = begin + STAY[place.type];
    clock = leave;
    return { place, arrive, begin, leave, label, wait: begin - arrive, late };
  });
}

// 하루 방문 순서: 이동시간 + 식사시간 어긋남 + 대기시간이 가장 작은 순서를 전부 비교
export function orderDay(places, { start = null, startMinute = 600, mode = 'car' } = {}) {
  if (!places.length) return [];
  const cache = new Map();
  const sec = (a, b) => {
    const key = a.id + '>' + b.id;
    if (!cache.has(key)) cache.set(key, estimateLeg(a, b, mode).duration);
    return cache.get(key);
  };
  let best = null, bestCost = Infinity;
  for (const p of permutations(places)) {
    const legs = p.map((x, i) => (i ? sec(p[i - 1], x) : start ? sec(start, x) : 0));
    const travel = legs.reduce((s, v) => s + v, 0) / 60;
    if (travel >= bestCost) continue;
    const cost = travel + schedule(p, legs, startMinute)
      .reduce((s, r) => s + r.late * 0.5 + r.wait * 0.5, 0);
    if (cost < bestCost) { bestCost = cost; best = p; }
  }
  return best;
}

function greedyPath(points, start) {
  const left = points.slice();
  const out = [];
  let cur = start;
  while (left.length) {
    let k = 0;
    if (cur) for (let i = 1; i < left.length; i++) if (haversine(cur, left[i]) < haversine(cur, left[k])) k = i;
    cur = left.splice(k, 1)[0];
    out.push(cur);
  }
  return out;
}

// 출발지가 없으면 어느 곳에서 시작할 때 가장 짧은지 모두 비교
function shortPath(points, start) {
  if (start || points.length < 3) return greedyPath(points, start);
  const length = (path) => path.slice(1).reduce((s, p, i) => s + haversine(path[i], p), 0);
  return points
    .map((first) => [first, ...greedyPath(points.filter((p) => p !== first), first)])
    .reduce((best, path) => (length(path) < length(best) ? path : best));
}

// 선택한 장소를 날짜별로 나눔: 관광지는 가까운 것끼리, 식당은 가까운 날에 배정
export function splitDays(selected, days, start = null) {
  const attractions = shortPath(selected.filter((p) => p.type === 'attraction'), start);
  const foods = selected.filter((p) => p.type === 'food');
  if (attractions.length > days * MAX_ATTRACTIONS_PER_DAY)
    throw new Error(`명소는 하루 ${MAX_ATTRACTIONS_PER_DAY}곳까지 고를 수 있어요.`);
  if (foods.length > days * MAX_FOODS_PER_DAY)
    throw new Error(`맛집은 하루 ${MAX_FOODS_PER_DAY}곳(점심·저녁)까지 고를 수 있어요.`);

  const result = [];
  let from = 0;
  for (let d = 0; d < days; d++) {
    const size = Math.ceil((attractions.length - from) / (days - d));
    result.push(attractions.slice(from, from + size));
    from += size;
  }
  const centers = result.map((list) => list.length
    ? { lat: list.reduce((s, p) => s + p.lat, 0) / list.length, lng: list.reduce((s, p) => s + p.lng, 0) / list.length }
    : null);
  // 날짜별 식당 수를 고르게 하면서, 그날 명소와의 거리 합이 가장 작은 배정을 선택
  const low = Math.floor(foods.length / days), high = Math.ceil(foods.length / days);
  const count = Array(days).fill(0), pick = [];
  let best = [], bestCost = Infinity;
  (function assign(i, cost) {
    if (cost >= bestCost) return;
    if (i === foods.length) {
      if (count.every((c) => c >= low)) { best = pick.slice(); bestCost = cost; }
      return;
    }
    for (let d = 0; d < days; d++) {
      if (count[d] >= high) continue;
      count[d]++; pick[i] = d;
      assign(i + 1, cost + (centers[d] ? haversine(centers[d], foods[i]) : 1e7)); // 명소가 없는 날은 뒤로
      count[d]--;
    }
  })(0, 0);
  foods.forEach((food, i) => result[best[i]].push(food));
  return result;
}

export const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
