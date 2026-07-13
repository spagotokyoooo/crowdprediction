import { createReadStream, existsSync, statSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
const processedLineEvents = new Set();
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  destinationId: process.env.LINE_DESTINATION_ID || '',
  cronSecret: process.env.CRON_SECRET || '',
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

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function japanDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00+09:00`);
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function lineDateLabel(date) {
  const value = new Date(`${date}T12:00:00+09:00`);
  return `${value.getMonth() + 1}/${value.getDate()}（${['日', '月', '火', '水', '木', '金', '土'][value.getDay()]}）`;
}

function crowdText(delta) {
  return ({ '-2': 'かなり少なそう', '-1': '少なそう', 0: 'いつも通り', 1: '混みそう', 2: 'かなり混みそう' })[delta];
}

function crowdDelta(score) {
  if (score <= -1.25) return -2;
  if (score <= -0.4) return -1;
  if (score < 0.4) return 0;
  if (score < 1.25) return 1;
  return 2;
}

async function buildDailyLineMessage(date) {
  const weekday = new Date(`${date}T12:00:00+09:00`).getDay();
  if (weekday === 0) return `${lineDateLabel(date)}のSPAGO\n\n本日は定休日です。\n来週の予報は日曜朝にお送りします。`;
  const [weather, venues] = await Promise.all([getWeather(), getVenues()]);
  const slots = weather.hourly.filter((slot) => slot.date === date && [11, 13, 15, 17, 19, 21].includes(slot.hour));
  const weatherScore = slots.length ? Math.min(...slots.map((slot) => slot.score)) : 0;
  const events = venues.events.filter((item) => item.date === date);
  const event = events[0];
  const score = weatherScore + (event?.time ? 0.95 : 0);
  const delta = crowdDelta(score);
  const weatherSlot = slots.find((slot) => slot.score === weatherScore) || slots[0];
  const summary = delta === 0 ? 'いつも通り' : `通常より${crowdText(delta)}`;
  const eventTime = event?.time ? Number(event.time.slice(0, 2)) : null;
  const attentionTime = eventTime && delta > 0
    ? `${String(eventTime + 2).padStart(2, '0')}:00〜${String(eventTime + 4).padStart(2, '0')}:00`
    : event && !event.time ? 'イベント時刻を確認中'
      : '特になし';
  const weatherImpact = weatherScore <= -0.4 ? '人流が落ち着く可能性があります' : '大きな補正はありません';
  const lines = [
    `${lineDateLabel(date)}｜SPAGO混雑予報`,
    '',
    `結論　${summary}（${delta > 0 ? '+' : ''}${delta}）`,
    `注意時間　${attentionTime}`,
    '',
    `天気　${weatherSlot ? `${weatherSlot.label} / ${Math.round(weatherSlot.temperature)}°C` : '取得中'}`,
    `影響　${weatherImpact}`,
  ];
  lines.push('', '近隣イベント');
  if (event) lines.push(`・${event.venue} ${event.time ? `${event.time}開始` : '時刻確認中'}`);
  else lines.push('・大きく影響しそうなイベントはありません');
  if (event && !event.time) lines.push('※ 開始・終了時刻の確認後に、混雑時間へ反映します。');
  lines.push('', '確度　中');
  return lines.join('\n');
}

async function buildWeeklyLineMessage() {
  const lines = ['来週のSPAGO｜要注意日'];
  for (let offset = 1; offset <= 7; offset += 1) {
    const date = japanDate(offset);
    const weekday = new Date(`${date}T12:00:00+09:00`).getDay();
    if (weekday === 0) {
      lines.push(`${lineDateLabel(date)}　定休日`);
      continue;
    }
    const message = await buildDailyLineMessage(date);
    const conclusion = message.split('\n')[2]?.replace('結論：', '') || '確認中';
    if (!conclusion.startsWith('いつも通り')) lines.push(`${lineDateLabel(date)}　${conclusion}`);
  }
  return lines.length === 1 ? `${lines[0]}\n\n現在、大きな変動要因は確認されていません。` : lines.join('\n');
}

function verifyLineSignature(rawBody, signature) {
  if (!lineConfig.channelSecret || !signature) return false;
  const expected = createHmac('sha256', lineConfig.channelSecret).update(rawBody).digest('base64');
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  return expectedBuffer.length === signatureBuffer.length && timingSafeEqual(expectedBuffer, signatureBuffer);
}

async function callLine(endpoint, body) {
  if (!lineConfig.channelAccessToken) return { sent: false, reason: 'LINE_CHANNEL_ACCESS_TOKEN is not configured' };
  const response = await fetch(`https://api.line.me/v2/bot/message/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${lineConfig.channelAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`LINE API HTTP ${response.status}: ${await response.text()}`);
  return { sent: true };
}

async function replyLine(replyToken, text) {
  return callLine('reply', {
    replyToken,
    messages: [{
      type: 'text',
      text,
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: '今日', text: '今日' } },
          { type: 'action', action: { type: 'message', label: '明日', text: '明日' } },
          { type: 'action', action: { type: 'message', label: '今週', text: '今週' } },
        ],
      },
    }],
  });
}

async function pushLine(to, text) {
  return callLine('push', { to, messages: [{ type: 'text', text }] });
}

async function broadcastLine(text) {
  return callLine('broadcast', { messages: [{ type: 'text', text }] });
}

async function sendMorningLine(text) {
  return lineConfig.destinationId ? pushLine(lineConfig.destinationId, text) : broadcastLine(text);
}

async function handleLineEvent(event) {
  if (!event.webhookEventId || processedLineEvents.has(event.webhookEventId)) return;
  processedLineEvents.add(event.webhookEventId);
  if (processedLineEvents.size > 1000) processedLineEvents.clear();
  if (event.type === 'postback' && event.replyToken) {
    await replyLine(event.replyToken, '記録しました。予報の補正に活用します。');
    return;
  }
  if (event.type !== 'message' || event.message?.type !== 'text' || !event.replyToken) return;
  const input = event.message.text.trim();
  if (input.includes('今日') || input.includes('きょう')) {
    await replyLine(event.replyToken, await buildDailyLineMessage(japanDate()));
  } else if (input.includes('明日') || input.includes('あした')) {
    await replyLine(event.replyToken, await buildDailyLineMessage(japanDate(1)));
  } else if (input.includes('今週') || input.includes('来週')) {
    await replyLine(event.replyToken, await buildWeeklyLineMessage());
  } else {
    await replyLine(event.replyToken, '「今日」「明日」「今週」と送ると、SPAGOの通常比予報を返します。');
  }
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
  if (pathname === '/webhook/line' && request.method === 'POST') {
    try {
      const rawBody = await readBody(request);
      if (!verifyLineSignature(rawBody, request.headers['x-line-signature'])) {
        response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Invalid LINE signature');
        return;
      }
      const payload = JSON.parse(rawBody.toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
      Promise.allSettled((payload.events || []).map(handleLineEvent));
    } catch (error) {
      sendJson(response, { error: 'LINE webhookを処理できませんでした。', detail: error.message }, 400);
    }
    return;
  }
  if (pathname === '/api/line/status') {
    sendJson(response, {
      webhookReady: Boolean(lineConfig.channelSecret),
      deliveryMode: lineConfig.destinationId ? 'push' : 'broadcast',
      notificationReady: Boolean(lineConfig.channelAccessToken),
      cronReady: Boolean(lineConfig.cronSecret),
    });
    return;
  }
  if (pathname === '/api/line/preview') {
    try {
      const period = new URL(request.url, `http://${request.headers.host}`).searchParams.get('period');
      sendJson(response, { text: period === 'week' ? await buildWeeklyLineMessage() : await buildDailyLineMessage(japanDate()) });
    } catch (error) {
      sendJson(response, { error: 'LINE通知文を生成できませんでした。', detail: error.message }, 502);
    }
    return;
  }
  if (pathname === '/api/jobs/morning' && request.method === 'POST') {
    if (!lineConfig.cronSecret || request.headers.authorization !== `Bearer ${lineConfig.cronSecret}`) {
      sendJson(response, { error: 'Unauthorized' }, 401);
      return;
    }
    if (!lineConfig.channelAccessToken) {
      sendJson(response, { error: 'LINE_CHANNEL_ACCESS_TOKEN is not configured' }, 503);
      return;
    }
    try {
      const date = japanDate();
      const isSunday = new Date(`${date}T12:00:00+09:00`).getDay() === 0;
      const text = isSunday ? `${await buildDailyLineMessage(date)}\n\n${await buildWeeklyLineMessage()}` : await buildDailyLineMessage(date);
      sendJson(response, { ...(await sendMorningLine(text)), date, weekly: isSunday, deliveryMode: lineConfig.destinationId ? 'push' : 'broadcast' });
    } catch (error) {
      sendJson(response, { error: 'LINE朝通知を送信できませんでした。', detail: error.message }, 502);
    }
    return;
  }
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
