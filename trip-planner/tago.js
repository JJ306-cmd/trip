// 기차·고속버스·시외버스 시간표 (국토교통부 TAGO 공공데이터)
// 주의: 아래 호출 이름과 요청 항목은 일부만 공개 자료로 확인했습니다.
//       `npm run check-tago` 로 점검하고, 다르면 활용가이드 문서를 보고 여기만 고치세요.
const BASE = 'https://apis.data.go.kr/1613000';

export const KINDS = {
  train: {
    label: '기차', service: 'TrainInfo',
    timetable: ['GetStrtpntAlocFndTrainInfo'], from: 'depPlaceId', to: 'arrPlaceId',
  },
  express: {
    label: '고속버스', service: 'ExpBusInfo',
    stations: ['GetExpBusTrminlList', 'GetExpBusTmnList'],
    timetable: ['GetStrtpntAlocFndExpbusInfo'], from: 'depTerminalId', to: 'arrTerminalId',
  },
  intercity: {
    label: '시외버스', service: 'SuburbsBusInfo', todayOnly: true,
    stations: ['GetSuberbsBusTrminlList'],
    timetable: ['GetStrtpntAlocFndSuberbsBusInfo'], from: 'depTerminalId', to: 'arrTerminalId',
  },
};

export const todayKST = (now = new Date()) => new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// "20261127093000", "202611270930", "2026-11-27 09:30", "09:30" → 하루의 분
export function toMinute(value) {
  const s = String(value ?? '');
  const colon = s.match(/(\d{1,2}):(\d{2})/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  return /^\d{12}(\d{2})?$/.test(s) ? Number(s.slice(8, 10)) * 60 + Number(s.slice(10, 12)) : null;
}

const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

export function createTago(key, fetchImpl = fetch) {
  async function call(service, operation, params = {}) {
    const query = new URLSearchParams({ serviceKey: key, _type: 'json', pageNo: 1, numOfRows: 1000, ...params });
    const res = await fetchImpl(`${BASE}/${service}/${operation}?${query}`, { signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      const reason = text.match(/<(?:returnAuthMsg|errMsg)>(.*?)</)?.[1] || text.slice(0, 80);
      throw new Error(`시간표 API 오류 (${res.status}) ${reason}. 활용신청과 키를 확인해 주세요.`);
    }
    const code = data.response?.header?.resultCode;
    if (code === '03') return [];
    if (!res.ok || (code && code !== '00'))
      throw new Error(`시간표 API 오류 (${res.status}) ${data.response?.header?.resultMsg || text.replaceAll(key, '(키)').slice(0, 120)}`);
    if (!data.response?.body) throw new Error('시간표 API 응답 형식이 예상과 달라요.');
    // 결과가 1건이면 배열이 아니라 객체로 옴
    return [data.response.body.items?.item || []].flat().map(lower);
  }

  // 이름 후보를 차례로 시도
  async function first(service, operations, params) {
    let error;
    for (const operation of operations) {
      try { return await call(service, operation, params); } catch (e) { error = e; }
    }
    throw error;
  }

  const cache = new Map();
  async function allStations(kind) {
    if (cache.has(kind)) return cache.get(kind);
    const info = KINDS[kind];
    let list;
    if (kind === 'train') {
      // 기차역은 도시별로 조회
      list = [];
      for (const city of await call(info.service, 'GetCtyCodeList')) {
        const stations = await call(info.service, 'GetCtyAcctoTrainSttnList', { cityCode: city.citycode });
        list.push(...stations.map((s) => ({ id: s.nodeid, name: s.nodename, city: city.cityname })));
      }
    } else {
      const rows = await first(info.service, info.stations);
      list = rows.map((s) => ({ id: s.terminalid || s.tmncd, name: s.terminalnm || s.tmnnm, city: s.cityname || '' }));
    }
    list = list.filter((s) => s.id && s.name);
    if (list.length) cache.set(kind, list);
    return list;
  }

  async function stations(kind, q) {
    return (await allStations(kind)).filter((s) => s.name.includes(q)).slice(0, 30);
  }

  async function timetable(kind, from, to, date) {
    const info = KINDS[kind];
    const rows = await first(info.service, info.timetable, {
      [info.from]: from, [info.to]: to, depPlandTime: date.replaceAll('-', ''),
    });
    return rows.map((r) => ({
      name: [r.traingradename || r.gradenm, r.trainno].filter(Boolean).join(' ') || info.label,
      depart: toMinute(r.depplandtime), arrive: toMinute(r.arrplandtime),
      fare: Number(r.adultcharge || r.charge) || null,
    })).filter((r) => r.depart != null && r.arrive != null).sort((x, y) => x.depart - y.depart);
  }

  return { stations, timetable, allStations };
}
