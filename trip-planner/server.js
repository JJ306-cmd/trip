import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import './env.js';
import { createLimiter, limitGroup } from './limit.js';
import { createTago, KINDS, todayKST } from './tago.js';
import { createWeather } from './weather.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createKakao } from './kakao.js';
import { demo } from './demo.js';
import { addTourPhotos, tourParking } from './extras.js';
import { aiSettings, createAI } from './ai.js';
import { estimateLeg } from './public/planner.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const FILES = {
  '/privacy': ['privacy.html', 'text/html'],
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/planner.js': ['planner.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
  '/tickets.js': ['tickets.js', 'text/javascript'],
  '/guide.js': ['guide.js', 'text/javascript'],
};

const validPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

export function createApp({ restKey = '', jsKey = '', kakao = restKey ? createKakao(restKey) : null, ai = null, placeParking = tourParking, tago = null, weather = null, limiter = createLimiter(), trustProxy = false } = {}) {
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      const group = limitGroup(url.pathname);
      if (group) {
        // 접속자 구분값. 위조될 수 있으므로 하루 총량 제한도 함께 둠
        const client = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
        const refused = limiter(group, client);
        if (refused) return send(res, 429, { error: refused });
      }
      // public/images 에 직접 넣은 사진 (없으면 화면의 그림이 보임)
      const image = req.method === 'GET' && url.pathname.match(/^\/images\/([\w-]+\.(jpg|png|webp))$/);
      if (image) {
        const body = await readFile(root + 'public/images/' + image[1]).catch(() => null);
        if (!body) return send(res, 404, { error: '사진이 없어요.' });
        res.writeHead(200, { 'Content-Type': image[2] === 'jpg' ? 'image/jpeg' : `image/${image[2]}` });
        return res.end(body);
      }
      if (req.method === 'GET' && Object.hasOwn(FILES, url.pathname)) {
        const [file, type] = FILES[url.pathname];
        return send(res, 200, await readFile(root + 'public/' + file, 'utf8'), type);
      }
      if (url.pathname === '/api/config') return send(res, 200, { live: !!kakao, jsKey, ai: ai?.provider || null, tickets: !!tago, weather: !!weather });

      if (url.pathname === '/api/places') {
        const region = (url.searchParams.get('region') || '').trim().slice(0, 40);
        if (!region) return send(res, 400, { error: '여행할 지역을 입력해 주세요.' });
        if (!kakao) {
          if (!region.includes('경주')) return send(res, 400, { error: 'API 키가 없어 예시 지역 "경주"만 검색할 수 있어요.' });
          return send(res, 200, { ...demo, demo: true });
        }
        const found = await kakao.places(region, url.searchParams.get('companion'));
        if (!found) return send(res, 404, { error: `"${region}" 지역을 찾지 못했어요. 시·군·구 이름으로 검색해 보세요.` });
        return send(res, 200, await addTourPhotos(found));
      }

      if (url.pathname === '/api/geocode') {
        const query = (url.searchParams.get('q') || '').trim().slice(0, 60);
        if (!kakao) return send(res, 400, { error: '출발지 검색은 API 키가 있어야 해요.' });
        const point = query && (await kakao.geocode(query));
        if (!point) return send(res, 404, { error: '출발지를 찾지 못했어요.' });
        return send(res, 200, point);
      }

      if (url.pathname === '/api/weather') {
        const lat = Number(url.searchParams.get('lat') || NaN), lng = Number(url.searchParams.get('lng') || NaN);
        if (!weather) return send(res, 400, { error: '.env 에 공공데이터 키를 넣어 주세요.' });
        if (!validPoint({ lat, lng })) return send(res, 400, { error: '잘못된 요청이에요.' });
        try { return send(res, 200, await weather(lat, lng)); }
        catch (e) { console.error(e.message); return send(res, 502, { error: e.message.startsWith('날씨') ? e.message : '날씨를 가져오지 못했어요.' }); }
      }

      if (url.pathname.startsWith('/api/tickets/')) {
        if (!tago) return send(res, 400, { error: '.env 에 공공데이터 키를 넣어 주세요.' });
        const get = (name) => url.searchParams.get(name) || '';
        const kind = get('kind');
        if (!Object.hasOwn(KINDS, kind)) return send(res, 400, { error: '잘못된 요청이에요.' });
        try {
          if (url.pathname === '/api/tickets/stations') {
            const q = get('q').trim().slice(0, 20);
            if (!q) return send(res, 400, { error: '이름을 입력해 주세요.' });
            return send(res, 200, await tago.stations(kind, q));
          }
          if (url.pathname === '/api/tickets/timetable') {
            const from = get('from'), to = get('to'), date = get('date');
            if (![from, to].every((id) => /^[A-Za-z0-9]{1,20}$/.test(id)) || !/^\d{4}-\d{2}-\d{2}$/.test(date))
              return send(res, 400, { error: '잘못된 요청이에요.' });
            if (KINDS[kind].todayOnly && date !== todayKST())
              return send(res, 400, { error: '시외버스는 오늘 출발편만 조회할 수 있어요.' });
            return send(res, 200, await tago.timetable(kind, from, to, date));
          }
        } catch (e) {
          console.error(e.message);
          return send(res, 502, { error: e.message.startsWith('시간표') ? e.message : '시간표를 가져오지 못했어요.' });
        }
      }

      if (url.pathname === '/api/parking') {
        const lat = Number(url.searchParams.get('lat') || NaN), lng = Number(url.searchParams.get('lng') || NaN);
        if (!validPoint({ lat, lng })) return send(res, 400, { error: '잘못된 요청이에요.' });
        if (!kakao) return send(res, 400, { error: '주차장 확인은 카카오 키가 필요해요.' });
        const name = (url.searchParams.get('name') || '').slice(0, 80);
        const [own, nearby] = await Promise.all([placeParking({ name, lat, lng }), kakao.parking({ lat, lng })]);
        return send(res, 200, { own, ...nearby });
      }

      if (req.method === 'POST' && url.pathname === '/api/ai/recommend') {
        if (!ai) return send(res, 400, { error: '.env 에 AI 키를 넣어 주세요.' });
        // 다른 웹사이트가 몰래 호출해 요금이 나가지 않도록 JSON 요청만 허용
        if (!String(req.headers['content-type']).startsWith('application/json'))
          return send(res, 415, { error: '잘못된 요청이에요.' });
        let raw = '';
        req.setEncoding('utf8');
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 20000) return send(res, 413, { error: '요청이 너무 커요.' });
        }
        let body;
        try { body = JSON.parse(raw); } catch { body = null; }
        const { region, days, preference = '', candidates } = body || {};
        const text = (v, max) => typeof v === 'string' && v.length <= max;
        if (!text(region, 40) || !text(preference, 200) || ![1, 2, 3].includes(days) ||
            !Array.isArray(candidates) || !candidates.length || candidates.length > 40 ||
            !candidates.every((c) => c && text(c.id, 40) && text(c.name, 80) && text(c.category, 60) &&
              ['attraction', 'food'].includes(c.type)))
          return send(res, 400, { error: '잘못된 요청이에요.' });
        try { return send(res, 200, await ai.recommend({ region, days, preference, candidates })); }
        catch (e) { console.error(e); return send(res, 502, { error: e.message.startsWith('AI') ? e.message : 'AI에 연결하지 못했어요.' }); }
      }

      if (req.method === 'POST' && url.pathname === '/api/route') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 20000) return send(res, 413, { error: '요청이 너무 커요.' });
        }
        let body;
        try { body = JSON.parse(raw); } catch { return send(res, 400, { error: '잘못된 요청이에요.' }); }
        const { mode, points } = body || {};
        if (!['car', 'transit'].includes(mode) || !Array.isArray(points) || points.length < 2 ||
            points.length > 10 || !points.every(validPoint))
          return send(res, 400, { error: '잘못된 요청이에요.' });
        if (!kakao) return send(res, 200, { toll: null, legs: points.slice(1).map((b, i) => estimateLeg(points[i], b, mode)) });
        return send(res, 200, await kakao.route(mode, points));
      }
      send(res, 404, { error: '없는 주소예요.' });
    } catch (e) {
      console.error(e);
      send(res, 502, { error: '정보를 가져오지 못했어요. 서버 창의 오류 메시지를 확인해 주세요.' });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PORT) || 3000;
  const settings = aiSettings();
  const ai = settings && createAI(settings);
  console.log(ai ? `AI 추천 사용: ${ai.provider} (${ai.model})` : 'AI 키가 없어 AI 추천은 꺼져 있습니다.');
  const tagoKey = process.env.TAGO_API_KEY || process.env.TOUR_API_KEY;
  // 내 컴퓨터에서는 외부 접속 차단. 배포 환경에서는 HOST=0.0.0.0
  const host = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
  createApp({ trustProxy: !!process.env.RENDER || process.env.TRUST_PROXY === '1', restKey: process.env.KAKAO_REST_KEY, jsKey: process.env.KAKAO_JS_KEY, ai, tago: tagoKey ? createTago(tagoKey) : null,
    weather: process.env.TOUR_API_KEY ? createWeather(process.env.TOUR_API_KEY) : null })
    .listen(port, host, () => {
      console.log(`http://localhost:${port} 에서 실행 중`);
      if (!process.env.KAKAO_REST_KEY) console.log('API 키가 없어 예시(경주) 모드로 실행합니다.');
    });
}
