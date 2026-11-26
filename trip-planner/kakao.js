// 카카오 API 호출. REST 키는 서버에만 둡니다.
import { estimateLeg, haversine } from './public/planner.js';

const DAPI = 'https://dapi.kakao.com';
const NAVI = 'https://apis-navi.kakaomobility.com';

export function createKakao(key, fetchImpl = fetch) {
  async function call(url, init = {}) {
    const res = await fetchImpl(url, {
      ...init,
      headers: { Authorization: `KakaoAK ${key}`, ...(init.headers || {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`카카오 API 오류 ${res.status} ${body.slice(0, 200)}`);
    }
    return res.json();
  }
  const local = (path, params) => call(`${DAPI}/v2/local/search/${path}.json?${new URLSearchParams(params)}`);

  const toPlace = (type) => (d) => ({
    id: d.id, type, name: d.place_name,
    category: (d.category_name || '').split('>').pop().trim(),
    address: d.road_address_name || d.address_name || '',
    lat: Number(d.y), lng: Number(d.x), url: d.place_url || '',
  });

  async function geocode(query) {
    const a = await local('address', { query, size: 1 });
    let d = a.documents?.[0];
    if (!d) d = (await local('keyword', { query, size: 1 })).documents?.[0];
    if (!d) return null;
    return { id: 'geo:' + query, name: query, lat: Number(d.y), lng: Number(d.x) };
  }

  // 검색 결과를 번갈아 섞어 중복과 주차장 등을 제거
  function merge(lists, type) {
    const seen = new Set(), out = [];
    for (let i = 0; i < 15; i++) {
      for (const list of lists) {
        const d = list[i];
        if (!d || seen.has(d.id) || /주차장|화장실|매표소|안내소/.test(d.place_name)) continue;
        seen.add(d.id);
        out.push(toPlace(type)(d));
      }
    }
    return out.slice(0, 20);
  }

  // 동행 유형별로 더 찾아볼 검색어 (적합성을 검증한 것은 아님)
  const THEMES = {
    family: ['체험', '박물관', '공원'],
    couple: ['전망대', '야경', '정원'],
    friends: ['액티비티', '테마파크', '시장'],
    solo: ['산책길', '미술관', '사찰'],
  };

  async function places(region, companion) {
    const center = await geocode(region);
    if (!center) return null;
    const near = { x: center.lng, y: center.lat, radius: 20000, size: 15 };
    const kw = async (query, code) =>
      (await local('keyword', { ...near, query, category_group_code: code })).documents || [];
    const [food, spot, sight, culture] = await Promise.all([
      kw(`${region} 맛집`, 'FD6'),
      kw(`${region} 가볼만한곳`, 'AT4'),
      kw(`${region} 명소`, 'AT4'),
      local('category', { ...near, category_group_code: 'CT1' }).then((r) => r.documents || []),
    ]);
    // 키워드 결과가 적은 지역은 카테고리 검색으로 보충
    let extra = [];
    if (spot.length + sight.length < 8) {
      extra = (await local('category', { ...near, category_group_code: 'AT4' })).documents || [];
    }
    const themed = await Promise.all((THEMES[companion] || []).flatMap((word) =>
      ['AT4', 'CT1'].map((code) => kw(`${region} ${word}`, code))));
    return {
      center, foods: merge([food], 'food'),
      attractions: merge([...themed.filter((list) => list.length), spot, sight, extra, culture], 'attraction'),
    };
  }

  const pointsFromVertexes = (v) => {
    const out = [];
    for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]]);
    return out;
  };

  async function carRoute(points) {
    const spot = (p) => ({ x: p.lng, y: p.lat });
    const data = await call(`${NAVI}/v1/waypoints/directions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: spot(points[0]), destination: spot(points.at(-1)),
        waypoints: points.slice(1, -1).map(spot), priority: 'RECOMMEND',
      }),
    });
    const route = data.routes?.[0];
    if (!route || route.result_code !== 0) throw new Error(route?.result_msg || '자동차 경로를 찾지 못했어요');
    return {
      toll: route.summary?.fare?.toll ?? null,
      legs: route.sections.map((s) => ({
        distance: s.distance, duration: s.duration, estimated: false, walk: false,
        path: (s.roads || []).flatMap((r) => pointsFromVertexes(r.vertexes || [])),
        steps: (s.guides || []).map((g) => g.guidance).filter((t) => t && !/^(출발지|목적지|경유지)$/.test(t)),
      })),
    };
  }

  async function transitLeg(a, b) {
    // 아주 가까우면 API를 부르지 않고 도보로 안내
    if (haversine(a, b) < 500) return estimateLeg(a, b, 'transit');
    const params = new URLSearchParams({
      start_x: a.lng, start_y: a.lat, end_x: b.lng, end_y: b.lat, s_name: a.name, e_name: b.name,
    });
    const data = await call(`${DAPI}/v2/routing/publictraffic?${params}`);
    if (data.status !== 'OK' || !data.routes?.length) throw new Error(`대중교통 경로 없음 (${data.status})`);
    const best = data.routes.reduce((x, y) => (y.properties.totalTime < x.properties.totalTime ? y : x));
    const p = best.properties;
    return {
      distance: p.totalDistance, duration: p.totalTime, fare: p.fare?.value ?? p.fare?.min ?? null,
      transfers: p.transfers, estimated: false, walk: false,
      path: (best.steps || []).flatMap((s) => s.path?.points || []),
      // 화면에 보여줄 구간: 수단, 소요시간, 타는 곳과 내리는 곳
      segments: (best.steps || []).map(({ properties: q = {} }) => {
        const stops = (q.stops || []).map((x) => x.name).filter(Boolean);
        return {
          type: q.type, seconds: q.time ?? null,
          vehicles: (q.vehicles || []).map((x) => x.name).filter(Boolean).slice(0, 3),
          from: stops[0] || '', to: stops.length > 1 ? stops.at(-1) : '',
        };
      }),
      steps: (best.steps || []).map((s) => {
        const v = (s.properties.vehicles || []).map((x) => x.name).filter(Boolean).slice(0, 3).join(', ');
        return [v && `[${v}]`, s.properties.guidance].filter(Boolean).join(' ');
      }).filter(Boolean),
    };
  }

  // 실패한 구간은 추정치로 대체하고 이유를 알려줌
  async function route(mode, points) {
    const fallback = (a, b, e) => ({ ...estimateLeg(a, b, mode), note: e.message });
    const pairs = points.slice(1).map((b, i) => [points[i], b]);
    if (mode === 'car') {
      try { return await carRoute(points); }
      catch (e) { return { toll: null, legs: pairs.map(([a, b]) => fallback(a, b, e)) }; }
    }
    const legs = [];
    for (const [a, b] of pairs) {
      try { legs.push(await transitLeg(a, b)); }
      catch (e) { legs.push(fallback(a, b, e)); }
    }
    return { toll: null, legs };
  }

  // 장소 주변 공영주차장(1km)과 전체 주차장(500m). 요금이나 빈자리 정보는 제공되지 않음
  async function parking({ lat, lng }) {
    const near = { category_group_code: 'PK6', x: lng, y: lat, sort: 'distance' };
    const lot = (d) => ({
      name: d.place_name, distance: Number(d.distance), url: d.place_url || '', lat: Number(d.y), lng: Number(d.x),
    });
    const [pub, all] = await Promise.all([
      local('keyword', { ...near, query: '공영주차장', radius: 1000, size: 15 }),
      local('category', { ...near, radius: 500, size: 3 }),
    ]);
    return {
      publicLots: (pub.documents || []).filter((d) => d.place_name.includes('공영')).slice(0, 3).map(lot),
      lots: (all.documents || []).map(lot),
    };
  }

  return { geocode, places, route, parking };
}
