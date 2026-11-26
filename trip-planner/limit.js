// 호출 횟수 제한. 공개했을 때 남이 AI 요금과 API 한도를 소진하지 못하게 합니다.
// 메모리에만 저장하므로 서버가 재시작되면 횟수가 초기화됩니다.
export function createLimiter(env = process.env, now = () => Date.now()) {
  const num = (name, fallback) => (Number(env[name]) >= 0 && env[name] ? Number(env[name]) : fallback);
  const rules = {
    ai: { perMinute: 5, perDay: num('AI_DAILY_LIMIT', 50) },
    kakao: { perMinute: 120, perDay: num('KAKAO_DAILY_LIMIT', 3000) },
    data: { perMinute: 60, perDay: num('DATA_DAILY_LIMIT', 3000) },
  };
  const minute = new Map(), day = new Map();
  let minuteStamp = 0, dayStamp = 0;

  return (group, client) => {
    const rule = rules[group];
    const m = Math.floor(now() / 60000), d = Math.floor((now() + 9 * 3600e3) / 86400e3); // 한국 날짜 기준
    if (m !== minuteStamp) { minute.clear(); minuteStamp = m; }
    if (d !== dayStamp) { day.clear(); dayStamp = d; }
    const key = `${group}|${client}`;
    if ((day.get(group) || 0) >= rule.perDay) return '오늘 이용량이 모두 소진됐어요. 내일 다시 이용해 주세요.';
    if ((minute.get(key) || 0) >= rule.perMinute) return '요청이 너무 많아요. 1분 뒤에 다시 시도해 주세요.';
    minute.set(key, (minute.get(key) || 0) + 1);
    day.set(group, (day.get(group) || 0) + 1);
    return null;
  };
}

export function limitGroup(path) {
  if (path.startsWith('/api/ai/')) return 'ai';
  if (['/api/places', '/api/geocode', '/api/route', '/api/parking'].includes(path)) return 'kakao';
  if (path === '/api/weather' || path.startsWith('/api/tickets/')) return 'data';
  return null;
}
