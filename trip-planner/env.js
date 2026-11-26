// 같은 폴더의 .env 를 읽어 process.env 에 넣습니다.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    // 값을 따옴표로 감싼 경우 따옴표를 제거
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2').trim();
  }
}

// 공공데이터 키를 Encoding 형태(%2B 등)로 넣은 경우 Decoding 형태로 바꿈 (이중 인코딩 방지)
for (const name of ['TOUR_API_KEY', 'TAGO_API_KEY']) {
  if (/%[0-9A-F]{2}/i.test(process.env[name] || '')) {
    try { process.env[name] = decodeURIComponent(process.env[name]); } catch { /* 그대로 사용 */ }
  }
}
