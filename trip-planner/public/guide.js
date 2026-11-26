// 추천 코스를 순서대로 따라가는 안내. 위치는 브라우저 안에서만 쓰고 서버로 보내지 않습니다.
import { haversine } from './planner.js';

export const ARRIVE_METERS = 100;

export function createGuide({ geolocation, onChange = () => {} }) {
  let state = null, watch = null, session = 0;

  const emit = () => onChange(state);
  function stop() {
    session++;
    if (watch != null) geolocation.clearWatch(watch);
    watch = null;
    state = null;
    emit();
  }
  // 다음 장소로. 새 목적지는 한 번 벗어난 뒤에야 자동 도착 처리(가까운 장소가 연달아 넘어가지 않게)
  function next(skipped = false) {
    if (!state || state.done) return;
    state.last = { name: state.stops[state.index].name, skipped };
    state.index++;
    state.armed = false;
    state.distance = state.position && state.stops[state.index]
      ? Math.round(haversine(state.position, state.stops[state.index])) : null;
    if (state.index >= state.stops.length) {
      state.done = true;
      geolocation.clearWatch(watch);
      watch = null;
    }
    emit();
  }
  function update({ coords }) {
    if (!state || state.done) return;
    state.position = { lat: coords.latitude, lng: coords.longitude };
    state.accuracy = Math.round(coords.accuracy);
    state.error = '';
    state.distance = Math.round(haversine(state.position, state.stops[state.index]));
    const accurate = state.accuracy <= ARRIVE_METERS;
    if (accurate && state.distance > ARRIVE_METERS) state.armed = true;
    else if (accurate && state.armed) return next();
    emit();
  }
  function start(stops, key) {
    stop();
    if (!stops.length) return;
    state = { stops, key, index: 0, armed: true, position: null, distance: null, accuracy: null, error: '', done: false, last: null };
    if (!geolocation) {
      state.error = '이 브라우저에서는 위치를 쓸 수 없어요. 버튼으로 진행해 주세요.';
      return emit();
    }
    const mine = ++session;
    watch = geolocation.watchPosition(
      (p) => mine === session && update(p),
      (e) => {
        if (mine !== session || !state) return;
        state.error = e.code === 1 ? '위치 권한이 거부됐어요. 허용하거나 버튼으로 진행해 주세요.'
          : '위치를 확인하지 못했어요. 잠시 기다리거나 버튼으로 진행해 주세요.';
        emit();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    emit();
  }
  return { start, stop, next, state: () => state };
}

const spot = (p) => `${encodeURIComponent(p.name.replace(/[,/]/g, ' '))},${p.lat},${p.lng}`;
export const toLink = (place) => `https://map.kakao.com/link/to/${spot(place)}`;

// 자차 전체 코스 링크. 경유지가 최대 5개라 출발+5+도착(7곳)씩 나눔
export function carCourseLinks(points) {
  const links = [];
  for (let i = 0; i + 1 < points.length; i += 6)
    links.push(`https://map.kakao.com/link/by/car/${points.slice(i, i + 7).map(spot).join('/')}`);
  return links;
}
