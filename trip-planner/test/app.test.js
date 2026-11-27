import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDays, orderDay, schedule, estimateLeg, MAX_FOODS_PER_DAY } from '../public/planner.js';
import { demo } from '../demo.js';
import { createApp } from '../server.js';
import { createKakao } from '../kakao.js';
import { addTourPhotos, tourParking, judgeParking } from '../extras.js';
import { createTago, toMinute, todayKST } from '../tago.js';
import { createLimiter } from '../limit.js';
import { createGuide, carCourseLinks } from '../public/guide.js';
import { createWeather, toGrid, baseTime, summarize } from '../weather.js';
import { createAI, aiSettings } from '../ai.js';

const picks = [...demo.attractions.slice(0, 7), ...demo.foods];

test('모든 장소가 한 번씩, 하루 식당 2곳 이하로 배정된다', () => {
  const days = splitDays(picks, 2);
  assert.equal(days.flat().length, picks.length);
  assert.equal(new Set(days.flat().map((p) => p.id)).size, picks.length);
  for (const d of days) assert.ok(d.filter((p) => p.type === 'food').length <= MAX_FOODS_PER_DAY);
});

test('식당은 점심·저녁 시간대에 배치된다', () => {
  for (const list of splitDays(picks, 2)) {
    const order = orderDay(list);
    const legs = order.map((p, i) => (i ? estimateLeg(order[i - 1], p, 'car').duration : 0));
    const meals = schedule(order, legs, 600).filter((r) => r.label);
    assert.equal(meals.length, 2);
    assert.ok(meals[0].begin >= 690 && meals[0].begin <= 810, '점심 ' + meals[0].begin);
    assert.ok(meals[1].begin >= 1020, '저녁 ' + meals[1].begin);
  }
});

test('너무 많이 고르면 안내한다', () => {
  assert.throws(() => splitDays(demo.foods, 1), /맛집/);
});

test('서버: 예시 검색, 경로, 입력 검증, 파일 접근 차단', async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/places?region=경주`)).status, 200);
  assert.equal((await fetch(`${base}/api/places?region=부산`)).status, 400);
  const post = (body) => fetch(`${base}/api/route`, { method: 'POST', body });
  const ok = await (await post(JSON.stringify({ mode: 'car', points: demo.attractions.slice(0, 3) }))).json();
  assert.equal(ok.legs.length, 2);
  assert.equal((await post('null')).status, 400);
  assert.equal((await post('{')).status, 400);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/__proto__`)).status, 404);
});

// 아래는 문서의 응답 형식을 흉내 낸 가짜 응답으로 확인 (실제 호출 아님)
const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
const [a, b] = [demo.attractions[0], demo.attractions[5]];

test('대중교통 응답 해석', async () => {
  const kakao = createKakao('k', reply({ status: 'OK', routes: [{
    properties: { totalDistance: 15000, totalTime: 2400, transfers: 0, fare: { value: 1700 } },
    steps: [{ properties: { type: 'BUS', time: 1500, guidance: '버스 탑승', vehicles: [{ name: '10' }], stops: [{ name: '가' }, { name: '나' }, { name: '다' }] }, path: { points: [[129.2, 35.8], [129.3, 35.79]] } }],
  }] }));
  const [leg] = (await kakao.route('transit', [a, b])).legs;
  assert.equal(leg.fare, 1700);
  assert.equal(leg.steps[0], '[10] 버스 탑승');
  assert.deepEqual(leg.segments[0], { type: 'BUS', seconds: 1500, vehicles: ['10'], from: '가', to: '다' });
  assert.equal(leg.estimated, false);
});

test('자동차 응답 해석', async () => {
  const kakao = createKakao('k', reply({ routes: [{ result_code: 0, summary: { fare: { toll: 0 } },
    sections: [{ distance: 14000, duration: 1500, roads: [{ vertexes: [129.2, 35.8, 129.3, 35.79] }], guides: [{ guidance: '우회전' }] }] }] }));
  const [leg] = (await kakao.route('car', [a, b])).legs;
  assert.deepEqual(leg.path, [[129.2, 35.8], [129.3, 35.79]]);
  assert.deepEqual(leg.steps, ['우회전']);
});

test('경로 API가 실패하면 추정치로 대체', async () => {
  const kakao = createKakao('k', reply({ msg: 'limit' }, 429));
  for (const mode of ['car', 'transit']) {
    const [leg] = (await kakao.route(mode, [a, b])).legs;
    assert.equal(leg.estimated, true);
    assert.match(leg.note, /429/);
  }
});

test('TourAPI 사진은 이름과 위치가 맞을 때만 붙고, 실패해도 결과는 유지', async () => {
  const found = { center: demo.center, attractions: demo.attractions.slice(0, 2) };
  const [first] = found.attractions;
  const ok = reply({ response: { body: { items: { item: [
    { title: first.name, mapx: String(first.lng), mapy: String(first.lat), firstimage: 'http://example.com/a.jpg' },
  ] } } } });
  const result = await addTourPhotos(found, 'k', ok);
  assert.equal(result.attractions[0].image, 'https://example.com/a.jpg');
  assert.equal(result.attractions[1].image, undefined);
  assert.deepEqual(await addTourPhotos(found, 'k', async () => new Response('<xml/>')), found);
  assert.equal(await addTourPhotos(found, ''), found);
});

const candidates = [...demo.attractions, ...demo.foods].map(({ id, type, name, category }) => ({ id, type, name, category }));
const request = { region: '경주', days: 1, preference: '', candidates };
const answer = JSON.stringify({ summary: '요약', picks: [
  { id: 'a1', reason: '이유' }, { id: 'a1', reason: '중복' }, { id: 'ghost', reason: '없는 곳' },
  { id: 'a2', reason: 'r' }, { id: 'a3', reason: 'r' }, { id: 'a4', reason: '초과' }, { id: 'f1', reason: 'r' },
] });

for (const [provider, body] of [
  ['openai', { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: answer }] }] }],
  ['gemini', { candidates: [{ content: { parts: [{ text: answer }] } }] }],
]) {
  test(`AI(${provider}): 없는 장소·중복·초과를 걸러냄`, async () => {
    const result = await createAI({ provider, key: 'k' }, reply(body)).recommend(request);
    assert.deepEqual(result.picks.map((p) => p.id), ['a1', 'a2', 'a3', 'f1']);
  });
}

test('AI 설정과 서버 요청 검증', async (t) => {
  assert.equal(aiSettings({}), null);
  assert.equal(aiSettings({ GEMINI_API_KEY: 'g' }).provider, 'gemini');
  assert.equal(aiSettings({ AI_PROVIDER: 'openai', GEMINI_API_KEY: 'g' }), null);
  const server = createApp({ ai: createAI({ provider: 'openai', key: 'k' }, reply({ output: [{ content: [{ type: 'output_text', text: answer }] }] })) }).listen(0);
  t.after(() => server.close());
  const url = `http://localhost:${server.address().port}/api/ai/recommend`;
  const post = (body, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body });
  assert.equal((await post(JSON.stringify(request))).status, 200);
  assert.equal((await post(JSON.stringify(request), 'text/plain')).status, 415);
  assert.equal((await post(JSON.stringify({ ...request, days: 9 }))).status, 400);
});

test('식당이 적으면 명소가 있는 날에 배정', () => {
  const [first, second] = splitDays([demo.attractions[0], demo.foods[0]], 2);
  assert.equal(first.length, 2);
  assert.equal(second.length, 0);
});

test('주차장 응답 해석과 서버 응답', async (t) => {
  const kakao = createKakao('k', reply({ documents: [{ place_name: '역전 공영주차장', distance: '120', x: '129.2', y: '35.8' }] }));
  assert.equal((await kakao.parking(a)).publicLots[0].distance, 120);
  const server = createApp({ kakao, placeParking: async () => ({ status: 'no', text: '불가' }) }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}/api/parking`;
  const body = await (await fetch(`${base}?lat=35.8&lng=129.2&name=x`)).json();
  assert.equal(body.own.status, 'no');
  assert.equal(body.publicLots.length, 1);
  assert.equal((await fetch(base)).status, 400);
});

test('장소 주차 여부 판단', async () => {
  assert.equal(judgeParking('가능'), 'yes');
  assert.equal(judgeParking('주차 불가'), 'no');
  assert.equal(judgeParking('없음'), 'no');
  assert.equal(judgeParking('대형버스 불가, 승용차 가능'), 'unknown');
  assert.equal(judgeParking(''), 'unknown');
  const fake = async (url) => new Response(JSON.stringify({ response: { body: { items: { item:
    url.includes('detailIntro2') ? [{ parkingfee: '1000원', parkingculture: '가능<br>30대' }]
      : [{ title: a.name, contentid: '1', contenttypeid: '14' }] } } } }));
  assert.deepEqual(await tourParking(a, 'k', fake), { status: 'yes', text: '가능 30대' });
  assert.equal((await tourParking(a, '', fake)).status, 'unknown');
});

test('시간표 시각 해석', () => {
  assert.equal(toMinute('20261127093000'), 570);
  assert.equal(toMinute(202611270930), 570);
  assert.equal(toMinute('2026-11-27 16:59'), 1019);
  assert.equal(toMinute(undefined), null);
});

const tagoReply = (item, code = '00') => reply({ response: { header: { resultCode: code }, body: { items: item ? { item } : '' } } });

test('시간표 해석: 1건 객체, 결과 없음, XML 오류', async () => {
  const one = createTago('k', tagoReply({ traingradename: 'KTX', trainno: 1, depplandtime: 20261127090000, arrplandtime: 20261127113000, adultcharge: 0 }));
  assert.deepEqual(await one.timetable('train', 'A', 'B', '2026-11-27'), [{ name: 'KTX 1', depart: 540, arrive: 690, fare: null }]);
  assert.deepEqual(await createTago('k', tagoReply(null)).timetable('express', 'A', 'B', '2026-11-27'), []);
  const bad = createTago('k', async () => new Response('<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>'));
  await assert.rejects(bad.timetable('train', 'A', 'B', '2026-11-27'), /NOT_REGISTERED/);
});

test('시간표 서버 입력 검증과 시외버스 당일 제한', async (t) => {
  const server = createApp({ tago: createTago('k', tagoReply(null)) }).listen(0);
  t.after(() => server.close());
  const call = async (q) => (await fetch(`http://localhost:${server.address().port}/api/tickets/${q}`)).status;
  assert.equal(await call(`timetable?kind=train&from=A1&to=B1&date=${todayKST()}`), 200);
  assert.equal(await call('timetable?kind=intercity&from=A1&to=B1&date=2000-01-01'), 400);
  assert.equal(await call('timetable?kind=train&from=A%26x&to=B1&date=2026-11-27'), 400);
  assert.equal(await call('stations?kind=plane&q=a'), 400);
});

test('오후 늦게 시작하면 첫 식사는 저녁', () => {
  assert.equal(schedule([demo.foods[0]], [0], 16 * 60)[0].label, '저녁');
});

test('날씨: 격자 변환, 발표 시각, 하루 요약', async () => {
  assert.deepEqual(toGrid(37.5665, 126.978), { nx: 60, ny: 127 });
  assert.deepEqual(baseTime(new Date('2026-11-27T00:15:00+09:00')), { base_date: '20261126', base_time: '2300' });
  assert.deepEqual(baseTime(new Date('2026-11-27T05:20:00+09:00')), { base_date: '20261127', base_time: '0500' });
  const f = (category, fcstValue, fcstTime = '1200') => ({ category, fcstValue, fcstTime, fcstDate: '20261128' });
  assert.deepEqual(summarize([f('TMP', '3', '0600'), f('TMP', '11'), f('POP', '70'), f('SKY', '4'), f('PTY', '1')]),
    [{ date: '2026-11-28', min: 3, max: 11, pop: 70, sky: '비' }]);
  await assert.rejects(createWeather('k', async () => new Response('<xml/>'))(37, 127), /활용신청/);
});

test('동행 유형에 따라 검색어가 추가됨', async () => {
  const queries = [];
  const fake = async (url) => {
    queries.push(new URL(url).searchParams.get('query'));
    return new Response(JSON.stringify({ documents: [{ id: '1', place_name: 'x', x: '127', y: '37' }] }));
  };
  await createKakao('k', fake).places('경주', 'family');
  assert.ok(queries.includes('경주 체험'));
});

test('코스 안내: 도착 감지, 부정확한 위치 무시, 연속 넘김 방지, 건너뛰기', () => {
  let send, cleared = 0;
  const guide = createGuide({ geolocation: { watchPosition: (ok) => { send = ok; return 1; }, clearWatch: () => cleared++ } });
  const at = (p, accuracy = 10) => send({ coords: { latitude: p.lat, longitude: p.lng, accuracy } });
  const near = { name: 'n1', lat: 35.8, lng: 129.2 };
  const close = { name: 'n2', lat: 35.8003, lng: 129.2 };
  const far = { name: 'n3', lat: 35.9, lng: 129.2 };
  guide.start([near, close, far], 'k');
  at(near, 500);
  assert.equal(guide.state().index, 0);
  at(near);
  assert.equal(guide.state().index, 1);
  at(near);
  assert.equal(guide.state().index, 1); // 가까운 다음 장소는 자동으로 넘기지 않음
  guide.next(true);
  at(near);
  at(far);
  assert.equal(guide.state().done, true);
  assert.equal(cleared, 1);
  guide.stop();
  assert.equal(guide.state(), null);
});

test('자차 전체 코스 링크는 7곳씩 나눔', () => {
  const points = Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, lat: 35, lng: 129 }));
  const links = carCourseLinks(points);
  assert.equal(links.length, 2);
  assert.equal(links[0].split('/by/car/')[1].split('/').length, 7);
  assert.equal(links[1].split('/by/car/')[1].split('/').length, 3);
  assert.deepEqual(carCourseLinks(points.slice(0, 1)), []);
});

test('호출 제한: 분당, 하루 총량, 서버 429', async (t) => {
  let time = Date.parse('2026-11-27T12:00:00+09:00');
  const limit = createLimiter({ AI_DAILY_LIMIT: '7' }, () => time);
  for (let i = 0; i < 5; i++) assert.equal(limit('ai', 'x'), null);
  assert.match(limit('ai', 'x'), /1분/);
  time += 60000;
  assert.equal(limit('ai', 'x'), null);
  assert.equal(limit('ai', 'y'), null);
  assert.match(limit('ai', 'z'), /오늘/);
  time += 86400000;
  assert.equal(limit('ai', 'x'), null);
  const server = createApp({ limiter: () => '제한' }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/places?region=a`)).status, 429);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/privacy`)).status, 200);
});

test('사진 경로: 없는 파일은 404, 폴더 밖은 읽지 않음', async (t) => {
  const server = createApp({}).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/images/none.jpg', '/images/..%2Fapp.js', '/images/README.txt']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});
