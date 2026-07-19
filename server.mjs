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
  openingHours: '11:30〜21:00',
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
    eventCoverage: 'automated',
    extract: extractTokyoGymnasium,
  },
  {
    id: 'jingu-stadium',
    name: '明治神宮野球場',
    url: 'https://www.jingu-stadium.com/',
    note: '当日スケジュール',
    eventCoverage: 'automated',
    extract: extractJinguStadium,
  },
  {
    id: 'yoyogi',
    name: '国立代々木競技場',
    url: 'https://www.jpnsport.go.jp/yoyogi/tabid/58/default.aspx',
    urls: [
      'https://www.jpnsport.go.jp/yoyogi/event/tabid/59/Default.aspx',
      'https://www.jpnsport.go.jp/yoyogi/event/tabid/60/Default.aspx',
    ],
    note: '第一・第二体育館の公式情報',
    eventCoverage: 'automated',
    extract: extractYoyogi,
  },
  {
    id: 'national-stadium',
    name: '国立競技場',
    url: 'https://jns-e.com/event/',
    note: '公式イベント情報',
    eventCoverage: 'automated',
    extract: extractNationalStadium,
  },
  {
    id: 'with-harajuku',
    name: 'WITH HARAJUKU HALL',
    url: 'https://withharajuku.jp/',
    note: 'NEWS & EVENTS',
    eventCoverage: 'automated',
    extract: extractWithHarajuku,
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

function weatherSummary(weather, date) {
  const daytimeSlots = weather.hourly.filter((slot) => slot.date === date && slot.hour >= 6 && slot.hour <= 21);
  if (!daytimeSlots.length) return null;
  const slotAt = (hour) => daytimeSlots.find((slot) => slot.hour === hour)
    || daytimeSlots.reduce((nearest, slot) => Math.abs(slot.hour - hour) < Math.abs(nearest.hour - hour) ? slot : nearest);
  return {
    flow: [
      { label: '朝', slot: slotAt(9) },
      { label: '昼', slot: slotAt(15) },
      { label: '夜', slot: slotAt(20) },
    ],
    low: Math.round(Math.min(...daytimeSlots.map((slot) => slot.temperature))),
    high: Math.round(Math.max(...daytimeSlots.map((slot) => slot.temperature))),
  };
}

function eventOccursOn(event, date) {
  return event.date === date || Boolean(event.endDate && event.date <= date && date <= event.endDate);
}

function truncate(text, maxLength = 42) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function eventDescription(event) {
  const time = event.time ? ` ${event.time}〜` : '';
  return `${time}${truncate(event.title)}`;
}

function weatherFlowText(summary, includePrecipitation = false) {
  return summary.flow
    .map(({ label, slot }) => `${label} ${slot.label} ${Math.round(slot.temperature)}°C${includePrecipitation && slot.precipitationProbability ? `（雨${slot.precipitationProbability}%）` : ''}`)
    .join(' → ');
}

function venueStatus(source, date) {
  if (source.status !== 'connected') return `${source.name}：取得確認中`;
  if (source.eventCoverage !== 'automated') return `${source.name}：公式情報を確認中`;
  const events = source.events.filter((event) => eventOccursOn(event, date));
  if (!events.length) return `${source.name}：予定なし`;
  const descriptions = events.slice(0, 2).map(eventDescription);
  if (events.length > 2) descriptions.push(`ほか${events.length - 2}件`);
  return `${source.name}：${descriptions.join(' ／ ')}`;
}

function dailyInfo(weather, venues, date) {
  return {
    weather: weatherSummary(weather, date),
    venueStatuses: venues.sources.map((source) => venueStatus(source, date)),
  };
}

function eventsByVenue(venues, date) {
  return venues.sources.flatMap((source) => {
    if (source.status !== 'connected' || source.eventCoverage !== 'automated') return [];
    const events = source.events.filter((event) => eventOccursOn(event, date));
    return events.length ? [{ name: source.name, events }] : [];
  });
}

function weatherNeedsAttention(summary) {
  return Boolean(summary?.flow.some(({ slot }) => slot.precipitationProbability >= 50 || /雨|雷|雪/.test(slot.label)));
}

async function buildDailyLineMessage(date) {
  const weekday = new Date(`${date}T12:00:00+09:00`).getDay();
  if (weekday === 0) {
    return `${lineDateLabel(date)}｜SPAGO\n\n本日は定休日です。\nゆっくり休んで、また明日からよろしくお願いします。`;
  }
  const [weather, venues] = await Promise.all([getWeather(), getVenues()]);
  const info = dailyInfo(weather, venues, date);
  const lines = [
    `${lineDateLabel(date)}｜SPAGO周辺情報`,
    '',
    '天気予報',
  ];
  if (info.weather) {
    lines.push(`・${weatherFlowText(info.weather, true)}`);
    lines.push(`・気温：${info.weather.low}〜${info.weather.high}°C`);
  } else {
    lines.push('・天気予報を取得中');
  }
  lines.push('', '近隣施設のイベント状況', ...info.venueStatuses);
  if (info.venueStatuses.some((status) => status.endsWith('公式情報を確認中'))) {
    lines.push('', '※「公式情報を確認中」の施設はイベント予定の自動取得対象外です。');
  }
  return lines.join('\n');
}

function weekOffsets(period) {
  const weekday = new Date(`${japanDate()}T12:00:00+09:00`).getDay();
  if (period === 'next') {
    const nextMonday = weekday === 0 ? 1 : 8 - weekday;
    return Array.from({ length: 6 }, (_, index) => nextMonday + index);
  }
  if (weekday === 0) return [];
  return Array.from({ length: 7 - weekday }, (_, index) => index);
}

async function buildWeeklyLineMessage(period = 'current') {
  const title = period === 'next' ? '来週のSPAGO周辺情報' : '今週のSPAGO周辺情報';
  const offsets = weekOffsets(period);
  if (!offsets.length) return `${title}\n\n今週の情報は終了しました。来週の情報は「来週」で確認できます。`;
  const [weather, venues] = await Promise.all([getWeather(), getVenues()]);
  const days = offsets.map((offset) => {
    const date = japanDate(offset);
    const info = dailyInfo(weather, venues, date);
    return { date, weather: info.weather, events: eventsByVenue(venues, date) };
  });
  const highlights = days.filter((day) => day.events.length || weatherNeedsAttention(day.weather) || !day.weather);
  const lines = [title, '', '注意日'];
  if (!highlights.length) {
    lines.push('・イベント予定・荒天の見込みはありません。');
  }
  for (const day of highlights) {
    const labels = [day.events.length ? 'イベント' : '', weatherNeedsAttention(day.weather) ? '天気' : ''].filter(Boolean);
    lines.push('', `${lineDateLabel(day.date)}｜${labels.join('・') || '天気予報を取得中'}`);
    if (day.events.length) {
      const eventText = day.events
        .map(({ name, events }) => `${name}：${events.slice(0, 2).map(eventDescription).join(' ／ ')}${events.length > 2 ? ` ／ ほか${events.length - 2}件` : ''}`)
        .join('\n・');
      lines.push(`・${eventText}`);
    }
    if (weatherNeedsAttention(day.weather)) lines.push(`・天気：${weatherFlowText(day.weather, true)}`);
    if (!day.weather) lines.push('・天気予報を取得中');
  }
  const unavailableSources = venues.sources.filter((source) => source.status !== 'connected').map((source) => source.name);
  lines.push('', '※ イベント予定のない施設は省略しています。');
  if (unavailableSources.length) lines.push(`※ 取得確認中：${unavailableSources.join('、')}`);
  return lines.join('\n');
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
          { type: 'action', action: { type: 'message', label: '来週', text: '来週' } },
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
  } else if (input.includes('来週')) {
    await replyLine(event.replyToken, await buildWeeklyLineMessage('next'));
  } else if (input.includes('今週')) {
    await replyLine(event.replyToken, await buildWeeklyLineMessage('current'));
  } else {
    await replyLine(event.replyToken, '「今日」「明日」「今週」「来週」と送ると、天気予報と近隣施設のイベント状況を返します。');
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

function uniqueEvents(events) {
  return [...new Map(events.map((event) => [`${event.venueId}:${event.date}:${event.title}`, event])).values()];
}

function datedEventsFromText(text, { venueId, venue, sourceUrl, scale = 'medium' }) {
  const events = [];
  const expression = /(20\d{2})\/(\d{1,2})\/(\d{1,2})[（(][^）)]*[）)]\s*([\s\S]{3,160}?)(?=\s+(?:20\d{2}\/\d{1,2}\/\d{1,2}[（(]|来月のイベント|再来月以降のイベント)|$)/g;
  for (const match of text.matchAll(expression)) {
    const [, year, month, day, rawTitle] = match;
    const title = rawTitle.replace(/\s+(?:来月|再来月以降).*$/, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 3) continue;
    events.push({
      venueId,
      venue,
      date: toDate(Number(year), Number(month), Number(day)),
      time: null,
      title,
      scale,
      sourceUrl,
      source: 'official',
    });
  }
  return uniqueEvents(events);
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

function extractYoyogi(htmlPages) {
  return uniqueEvents(htmlPages.flatMap((html) => datedEventsFromText(compactText(html), {
    venueId: 'yoyogi',
    venue: '国立代々木競技場',
    sourceUrl: 'https://www.jpnsport.go.jp/yoyogi/tabid/58/default.aspx',
  }))).slice(0, 40);
}

function extractNationalStadium(html) {
  const text = compactText(html);
  const eventSection = text.slice(Math.max(0, text.indexOf('イベントアーカイブ')));
  const events = [];
  const expression = /(?:^|\s)(?:音楽|スポーツ|その他)\s+(.{2,140}?)\s+日程\s+(20\d{2})\s+(\d{1,2})\/(\d{1,2})/g;
  for (const match of eventSection.matchAll(expression)) {
    const [, title, year, month, day] = match;
    events.push({
      venueId: 'national-stadium',
      venue: '国立競技場',
      date: toDate(Number(year), Number(month), Number(day)),
      time: null,
      title: title.replace(/\s+/g, ' ').trim(),
      scale: 'large',
      sourceUrl: 'https://jns-e.com/event/',
      source: 'official',
    });
  }
  return uniqueEvents(events);
}

function extractWithHarajuku(html) {
  const text = compactText(html);
  const events = [];
  const expression = /(20\d{2})年(\d{1,2})月(\d{1,2})日[（(][^）)]*[）)](?:[～〜-](?:(\d{1,2})月)?(\d{1,2})日[（(][^）)]*[）)])?/g;
  for (const match of text.matchAll(expression)) {
    const [, year, month, day, endMonth, endDay] = match;
    const prefix = text.slice(Math.max(0, match.index - 240), match.index);
    const eventMarker = Math.max(prefix.lastIndexOf(' EVENTS '), prefix.lastIndexOf(' SHOP EVENTS '));
    if (eventMarker < 0) continue;
    const title = prefix.slice(eventMarker).replace(/^\s*(?:SHOP )?EVENTS\s+/, '').replace(/◆\s*終了しました\s*◆/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 4 || title.includes('毎月19日はウィズ原宿の日')) continue;
    events.push({
      venueId: 'with-harajuku',
      venue: 'WITH HARAJUKU HALL',
      date: toDate(Number(year), Number(month), Number(day)),
      endDate: endDay ? toDate(Number(year), Number(endMonth || month), Number(endDay)) : null,
      time: null,
      title,
      scale: 'small',
      sourceUrl: 'https://withharajuku.jp/',
      source: 'official',
    });
  }
  return uniqueEvents(events).slice(0, 20);
}

async function getVenues() {
  if (cache.venues.expiresAt > Date.now()) return cache.venues.value;
  const results = await Promise.all(venueSources.map(async (venue) => {
    try {
      const urls = venue.urls || [venue.url];
      const pages = await Promise.all(urls.map(getText));
      const events = venue.extract(pages.length === 1 ? pages[0] : pages);
      return {
        id: venue.id,
        name: venue.name,
        url: venue.url,
        note: venue.note,
        eventCoverage: venue.eventCoverage,
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
        eventCoverage: venue.eventCoverage,
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
      const today = japanDate();
      const text = period === 'week' ? await buildWeeklyLineMessage('current') : period === 'next-week' ? await buildWeeklyLineMessage('next') : await buildDailyLineMessage(today);
      sendJson(response, { text });
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
      const text = await buildDailyLineMessage(date);
      sendJson(response, { ...(await sendMorningLine(text)), date, weekly: false, deliveryMode: lineConfig.destinationId ? 'push' : 'broadcast' });
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
