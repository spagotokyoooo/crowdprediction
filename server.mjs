import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const store = {
  name: 'SPAGO 原宿',
  latitude: 35.6757,
  longitude: 139.7075,
  timezone: 'Asia/Tokyo',
};

const cache = {
  weather: { value: null, expiresAt: 0 },
  venues: { value: null, expiresAt: 0 },
};

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const venueSources = [
  {
    id: 'tokyo-gymnasium',
    name: '東京体育館',
    url: 'https://www.tef.or.jp/tmg/',
    note: '大会・イベント日程',
    extract: extractTokyoGymnasium,
  },
  {
    id: 'jingu-stadium',
    name: '明治神宮野球場',
    url: 'https://www.jingu-stadium.com/',
    note: '当日スケジュール',
    extract: extractJinguStadium,
  },
  {
    id: 'yoyogi',
    name: '国立代々木競技場',
    url: 'https://www.jpnsport.go.jp/yoyogi/tabid/58/default.aspx',
    note: '第一・第二体育館の公式情報',
    extract: () => [],
  },
  {
    id: 'national-stadium',
    name: '国立競技場',
    url: 'https://www.jpnsport.go.jp/kokuritu/seat/tabid/57/Default.aspx',
    note: '公式イベント情報',
    extract: () => [],
  },
  {
    id: 'with-harajuku',
    name: 'WITH HARAJUKU HALL',
    url: 'https://withharajuku.jp/',
    note: 'NEWS & EVENTS',
    extract: () => [],
  },
];

function sendJson(response, body, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function compactText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'SPAGO-Crowd-Signal/0.1 (event monitor)' },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function weatherLabel(code) {
  if (code === 0) return '晴れ';
  if ([1, 2].includes(code)) return '晴れ時々曇り';
  if (code === 3) return '曇り';
  if ([45, 48].includes(code)) return '霧';
  if ([51, 53, 55, 56, 57].includes(code)) return '小雨';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '雨';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '雪';
  if ([95, 96, 99].includes(code)) return '雷雨';
  return '天気情報あり';
}

function weatherImpact({ precipitation, windSpeed }) {
  if (windSpeed >= 50) return -1;
  if (precipitation >= 5) return -0.5;
  if (precipitation >= 1) return -0.25;
  return 0;
}

async function getWeather() {
  if (cache.weather.expiresAt > Date.now()) return cache.weather.value;
  const params = new URLSearchParams({
    latitude: String(store.latitude),
    longitude: String(store.longitude),
    timezone: store.timezone,
    forecast_days: '8',
    hourly: 'temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_speed_10m',
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Weather API HTTP ${response.status}`);
  const payload = await response.json();
  const hourly = payload.hourly.time.map((time, index) => ({
    time,
    date: time.slice(0, 10),
    hour: Number(time.slice(11, 13)),
    temperature: payload.hourly.temperature_2m[index],
    apparentTemperature: payload.hourly.apparent_temperature[index],
    precipitation: payload.hourly.precipitation[index],
    precipitationProbability: payload.hourly.precipitation_probability[index],
    weatherCode: payload.hourly.weather_code[index],
    windSpeed: payload.hourly.wind_speed_10m[index],
  }));
  const value = {
    source: 'Open-Meteo Forecast API',
    fetchedAt: new Date().toISOString(),
    store,
    hourly: hourly.map((slot) => ({ ...slot, label: weatherLabel(slot.weatherCode), score: weatherImpact(slot) })),
  };
  cache.weather = { value, expiresAt: Date.now() + 20 * 60 * 1000 };
  return value;
}

function toDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractTokyoGymnasium(html) {
  const text = compactText(html);
  const events = [];
  const expression = /メインアリーナ\s+(20\d{2})年(\d{1,2})月(\d{1,2})日(?:（[^）]+）)?(?:～(?:\d{1,2})月)?(\d{1,2})?日?(?:（[^）]+）)?\s*([^]{6,140}?)(?=\s+(?:有|無)\s|\s+メインアリーナ\s|$)/g;
  for (const match of text.matchAll(expression)) {
    const [, year, month, day, endDay, rawTitle] = match;
    const title = rawTitle.replace(/^～\d{1,2}日（[^）]+）\s*/, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 4) continue;
    events.push({
      venueId: 'tokyo-gymnasium',
      venue: '東京体育館',
      date: toDate(Number(year), Number(month), Number(day)),
      endDate: endDay ? toDate(Number(year), Number(month), Number(endDay)) : null,
      time: null,
      title,
      scale: 'medium',
      sourceUrl: 'https://www.tef.or.jp/tmg/',
      source: 'official',
    });
  }
  return events.slice(0, 20);
}

function extractJinguStadium(html) {
  const text = compactText(html);
  const dateMatch = text.match(/(20\d{2})年\s?(\d{2})月\s?(\d{2})日/);
  if (!dateMatch) return [];
  const schedule = text.split('トピックス')[0];
  const events = [];
  const expression = /(\d{2}:\d{2})\s+(.{4,110}?)(?=\s+\d+\.\s+\d{2}:\d{2}|$)/g;
  for (const match of schedule.matchAll(expression)) {
    events.push({
      venueId: 'jingu-stadium',
      venue: '明治神宮野球場',
      date: toDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])),
      time: match[1],
      title: match[2].trim(),
      scale: 'medium',
      sourceUrl: 'https://www.jingu-stadium.com/',
      source: 'official',
    });
  }
  return events.slice(0, 10);
}

async function getVenues() {
  if (cache.venues.expiresAt > Date.now()) return cache.venues.value;
  const results = await Promise.all(venueSources.map(async (venue) => {
    try {
      const html = await getText(venue.url);
      const events = venue.extract(html);
      return {
        id: venue.id,
        name: venue.name,
        url: venue.url,
        note: venue.note,
        status: 'connected',
        checkedAt: new Date().toISOString(),
        events,
      };
    } catch (error) {
      return {
        id: venue.id,
        name: venue.name,
        url: venue.url,
        note: venue.note,
        status: 'manual',
        checkedAt: new Date().toISOString(),
        events: [],
        error: error.message,
      };
    }
  }));
  const value = {
    fetchedAt: new Date().toISOString(),
    sources: results,
    events: results.flatMap((source) => source.events),
  };
  cache.venues = { value, expiresAt: Date.now() + 30 * 60 * 1000 };
  return value;
}

createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/api/weather') {
    try {
      sendJson(response, await getWeather());
    } catch (error) {
      sendJson(response, { error: '天気情報を取得できませんでした。', detail: error.message }, 502);
    }
    return;
  }
  if (pathname === '/api/venues') {
    try {
      sendJson(response, await getVenues());
    } catch (error) {
      sendJson(response, { error: '会場情報を取得できませんでした。', detail: error.message }, 502);
    }
    return;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(root, requested));

  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': contentTypes[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(response);
}).listen(port, () => {
  console.log(`SPAGO Crowd Prediction is running at http://localhost:${port}`);
});
