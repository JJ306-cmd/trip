// 공공데이터 API(날씨, 관광정보, 시간표) 점검: npm run check-tago  (키는 화면에 출력하지 않음)
import './env.js';
import { KINDS } from './tago.js';
import { baseTime } from './weather.js';

const key = process.env.TAGO_API_KEY || process.env.TOUR_API_KEY;
if (!key) { console.log('.env 에 TOUR_API_KEY(또는 TAGO_API_KEY)가 없어요.'); process.exit(1); }
const secrets = [process.env.TAGO_API_KEY, process.env.TOUR_API_KEY].filter(Boolean);
const safe = (text) => secrets.reduce((t, k) => t.replaceAll(k, '(키)').replaceAll(encodeURIComponent(k), '(키)'), String(text))
  .replace(/\s+/g, ' ').trim().slice(0, 250);

console.log(`키 길이 ${key.length}자 (${process.env.TAGO_API_KEY ? 'TAGO_API_KEY' : 'TOUR_API_KEY'} 사용)\n`);

if (/\s|=.*_KEY|["']/.test(key)) console.log('주의: 키에 공백, 따옴표, 다른 항목 이름이 섞여 있어요.\n');
for (const other of ['KAKAO_REST_KEY', 'KAKAO_JS_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) {
  if (process.env[other] === key) console.log(`주의: 공공데이터 키 자리에 ${other} 와 같은 값이 들어 있어요.\n`);
}

async function probe(label, path, serviceKey, params) {
  const query = new URLSearchParams({ serviceKey, pageNo: 1, numOfRows: 3, ...params });
  try {
    const res = await fetch(`https://apis.data.go.kr/${path}?${query}`, { signal: AbortSignal.timeout(10000) });
    console.log(`[${label}] ${path} → ${res.status}`);
    console.log(`   ${safe(await res.text()) || '(응답 내용 없음)'}\n`);
  } catch (e) {
    console.log(`[${label}] ${path} → 연결 실패: ${safe(e.message)}\n`);
  }
}

// 날씨와 관광정보는 TOUR_API_KEY 를 사용
const tourKey = process.env.TOUR_API_KEY;
if (tourKey) {
  await probe('날씨', '1360000/VilageFcstInfoService_2.0/getVilageFcst', tourKey,
    { dataType: 'JSON', ...baseTime(), nx: 60, ny: 127 });
  await probe('관광정보', 'B551011/KorService2/locationBasedList2', tourKey,
    { _type: 'json', MobileOS: 'ETC', MobileApp: 'TripPlanner', mapX: 126.978, mapY: 37.5665, radius: 1000 });
} else console.log('TOUR_API_KEY 가 비어 있어 날씨·관광정보는 건너뜀\n');

for (const [kind, info] of Object.entries(KINDS)) {
  for (const operation of kind === 'train' ? ['GetCtyCodeList'] : info.stations) {
    await probe(info.label, `1613000/${info.service}/${operation}`, key, { _type: 'json' });
  }
}
