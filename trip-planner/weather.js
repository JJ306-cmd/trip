// 기상청 단기예보. data.go.kr 에서 "기상청_단기예보 조회서비스" 활용신청이 필요합니다.
const URL_BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst';

// 위경도 → 기상청 격자 좌표 (Lambert Conformal Conic)
export function toGrid(lat, lng) {
  const D = Math.PI / 180, re = 6371.00877 / 5;
  const slat1 = 30 * D, slat2 = 60 * D, olon = 126 * D, olat = 38 * D;
  const t = (a) => Math.tan(Math.PI / 4 + a / 2);
  const sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(t(slat2) / t(slat1));
  const sf = (t(slat1) ** sn * Math.cos(slat1)) / sn;
  const ro = (re * sf) / t(olat) ** sn;
  const ra = (re * sf) / t(lat * D) ** sn;
  let theta = lng * D - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + 43 + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + 136 + 0.5) };
}

// 가장 최근 발표 시각 (02, 05, …, 23시. 발표 직후에는 이전 것을 사용)
export function baseTime(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600e3 - 15 * 60e3);
  let hour = kst.getUTCHours();
  let slot = Math.floor((hour - 2) / 3) * 3 + 2;
  if (slot < 2) { slot = 23; kst.setUTCDate(kst.getUTCDate() - 1); }
  return { base_date: kst.toISOString().slice(0, 10).replaceAll('-', ''), base_time: String(slot).padStart(2, '0') + '00' };
}

export function summarize(items) {
  const days = new Map();
  for (const i of items) {
    const date = String(i.fcstDate).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    if (!days.has(date)) days.set(date, { temps: [], pop: [], sky: [], rain: new Set(), min: null, max: null });
    const d = days.get(date), value = Number(i.fcstValue), time = String(i.fcstTime);
    if (i.category === 'TMP') d.temps.push(value);
    if (i.category === 'TMN') d.min = value;
    if (i.category === 'TMX') d.max = value;
    // 하늘·강수는 여행하는 낮 시간(09~21시)만 반영
    if (time < '0900' || time > '2100') continue;
    if (i.category === 'POP') d.pop.push(value);
    if (i.category === 'SKY') d.sky.push(value);
    if (i.category === 'PTY' && value > 0) d.rain.add({ 1: '비', 2: '비·눈', 3: '눈', 4: '소나기' }[value] || '비');
  }
  return [...days].map(([date, d]) => {
    const common = d.sky.sort((a, b) => d.sky.filter((v) => v === b).length - d.sky.filter((v) => v === a).length)[0];
    return {
      date,
      min: d.min ?? (d.temps.length ? Math.min(...d.temps) : null),
      max: d.max ?? (d.temps.length ? Math.max(...d.temps) : null),
      pop: d.pop.length ? Math.max(...d.pop) : null,
      sky: [...d.rain].join('/') || { 1: '맑음', 3: '구름많음', 4: '흐림' }[common] || '',
    };
  }).filter((d) => d.pop != null); // 낮 예보가 없는 날은 제외
}

export function createWeather(key, fetchImpl = fetch) {
  return async function forecast(lat, lng, now = new Date()) {
    const params = new URLSearchParams({ serviceKey: key, dataType: 'JSON', pageNo: 1, numOfRows: 1500, ...baseTime(now), ...toGrid(lat, lng) });
    const res = await fetchImpl(`${URL_BASE}?${params}`, { signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (data?.response?.header?.resultCode !== '00')
      throw new Error(`날씨 API 오류 (${res.status}). 활용신청과 키를 확인해 주세요.`);
    return summarize([data.response.body?.items?.item || []].flat());
  };
}
