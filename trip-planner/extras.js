// 선택 기능 모음.
// 1번(관광 사진)은 .env 에 키만 넣으면 동작합니다.
// 2번은 아직 구현되지 않은 빈 자리입니다. ★직접입력 표시를 따라 채우세요.
import { haversine } from './public/planner.js';

/* ───────── 1. 한국관광공사 TourAPI: 명소 사진 ───────── */
const TOUR_URL = 'https://apis.data.go.kr/B551011/KorService2/locationBasedList2';
const plain = (s) => String(s || '').replace(/\(.*?\)|\[.*?\]|\s/g, '');

export async function addTourPhotos(found, key = process.env.TOUR_API_KEY, fetchImpl = fetch) {
  if (!key) return found;
  try {
    const params = new URLSearchParams({
      serviceKey: key, MobileOS: 'ETC', MobileApp: 'TripPlanner', _type: 'json',
      mapX: found.center.lng, mapY: found.center.lat, radius: 20000,
      contentTypeId: 12, arrange: 'Q', numOfRows: 200, pageNo: 1,
    });
    const res = await fetchImpl(`${TOUR_URL}?${params}`, { signal: AbortSignal.timeout(8000) });
    const items = [(await res.json())?.response?.body?.items?.item || []].flat();
    return {
      ...found,
      attractions: found.attractions.map((place) => {
        // 이름이 같고 500m 안에 있는 곳만 같은 장소로 봄
        const hit = items.find((i) => plain(i.title) === plain(place.name) &&
          haversine(place, { lat: Number(i.mapy), lng: Number(i.mapx) }) < 500);
        return hit?.firstimage ? { ...place, image: hit.firstimage.replace(/^http:/, 'https:') } : place;
      }),
    };
  } catch (e) {
    console.warn('TourAPI 사진을 가져오지 못했어요:', e.message);
    return found; // 사진이 없어도 추천은 계속 동작
  }
}

/* ───────── 장소 자체의 주차 가능 여부 (TourAPI 소개정보) ───────── */
const API = 'https://apis.data.go.kr/B551011/KorService2';

// 설명 문구가 분명할 때만 가능/불가로 판단하고, 애매하면 '확인 안 됨'
export function judgeParking(text) {
  const no = /불가|없음|없습니다/.test(text);
  const yes = /(?<!불)가능|있음|있습니다|무료|유료|\d+\s*(대|면)/.test(text);
  return no && !yes ? 'no' : yes && !no ? 'yes' : 'unknown';
}

export async function tourParking(place, key = process.env.TOUR_API_KEY, fetchImpl = fetch) {
  const none = { status: 'unknown', text: '' };
  if (!key || !place.name) return none;
  const get = async (path, params) => {
    const query = new URLSearchParams({ serviceKey: key, MobileOS: 'ETC', MobileApp: 'TripPlanner', _type: 'json', ...params });
    const res = await fetchImpl(`${API}/${path}?${query}`, { signal: AbortSignal.timeout(8000) });
    return [(await res.json())?.response?.body?.items?.item || []].flat();
  };
  try {
    const near = await get('locationBasedList2', { mapX: place.lng, mapY: place.lat, radius: 500, arrange: 'E', numOfRows: 100 });
    const hit = near.find((i) => plain(i.title) === plain(place.name));
    if (!hit) return none;
    const [intro] = await get('detailIntro2', { contentId: hit.contentid, contentTypeId: hit.contenttypeid });
    // 유형마다 항목 이름이 다름(parking, parkingculture, parkingfood 등). 요금 항목은 제외
    const text = Object.entries(intro || {})
      .filter(([name, value]) => /^parking(?!fee)/.test(name) && value)
      .map(([, value]) => String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
      .join(' ').slice(0, 150);
    return { status: judgeParking(text), text };
  } catch (e) {
    console.warn('TourAPI 주차 정보를 가져오지 못했어요:', e.message);
    return none;
  }
}

/* ───────── 2. 블로그 후기 (네이버 검색 API) ───────── */
export async function getBlogReviews(placeName) {
  // ★직접입력: NAVER API HUB에서 키를 발급받고, 공식 문서의 주소와 인증 헤더로
  //   블로그 검색을 호출해 [{ title, link }] 형태로 돌려주세요.
  //   키는 코드에 쓰지 말고 .env 에 넣어 process.env 로 읽으세요.
  return [];
}

// AI 추천은 ai.js 에 구현되어 있습니다.
// 날씨는 weather.js 에 구현되어 있습니다.
// 2번을 구현한 뒤에는 server.js 에 주소(/api/...)를 만들고
// public/app.js 에서 불러 화면에 보여줘야 합니다.
