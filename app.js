const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

const forecastData = {
  '2026-07-13': {
    weather: { label: '晴れのち曇り', temp: '30°C', score: 0, confidence: '高' },
    events: [{ venue: '国立競技場', title: 'サンプル：夜間スポーツイベント', time: '18:00', scale: 'large', score: 1.35, demo: true }],
  },
  '2026-07-14': {
    weather: { label: '弱い雨', temp: '26°C', score: -0.25, confidence: '中' },
    events: [{ venue: '東京体育館', title: 'サンプル：アリーナイベント', time: '19:00', scale: 'medium', score: 0.95, demo: true }],
  },
  '2026-07-15': {
    weather: { label: '晴れ', temp: '31°C', score: -0.1, confidence: '高' },
    events: [],
  },
  '2026-07-16': {
    weather: { label: '雨', temp: '25°C', score: -0.5, confidence: '中' },
    events: [],
  },
  '2026-07-17': {
    weather: { label: '晴れ', temp: '29°C', score: 0, confidence: '高' },
    events: [
      { venue: '国立代々木競技場', title: 'サンプル：ライブイベント', time: '18:30', scale: 'large', score: 1.45, demo: true },
      { venue: 'WITH HARAJUKU HALL', title: 'サンプル：展示イベント', time: '11:00', scale: 'small', score: 0.35, demo: true },
    ],
  },
  '2026-07-18': {
    weather: { label: '強い雨', temp: '24°C', score: -1.0, confidence: '中' },
    events: [{ venue: '明治神宮野球場', title: 'サンプル：野球イベント', time: '18:00', scale: 'large', score: 1.1, demo: true }],
  },
  '2026-07-19': { closed: true },
};

const elements = {
  tabs: [...document.querySelectorAll('.day-tab')],
  date: document.querySelector('#forecast-date'),
  label: document.querySelector('#forecast-label'),
  value: document.querySelector('#forecast-value'),
  delta: document.querySelector('#forecast-delta'),
  detail: document.querySelector('#forecast-detail'),
  confidence: document.querySelector('#confidence-label'),
  confidenceDot: document.querySelector('#confidence-dot'),
  slots: document.querySelector('#slot-list'),
  slotSummary: document.querySelector('#slots-summary'),
  drivers: document.querySelector('#driver-list'),
  lineBubble: document.querySelector('#line-bubble'),
  feedback: document.querySelector('#feedback-confirmation'),
  dataStatus: document.querySelector('#data-status'),
  refresh: document.querySelector('#refresh-button'),
  venues: document.querySelector('#venue-list'),
  dialog: document.querySelector('#event-dialog'),
  form: document.querySelector('#event-form'),
};

let activeDate = '2026-07-13';
let venueSources = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')} / ${dayNames[date.getDay()]}曜日`;
}

function eventScoreForSlot(event, hour) {
  if (event.unknownTime) return 0;
  const [startHour, startMinute] = event.time.split(':').map(Number);
  const start = startHour + startMinute / 60;
  if (hour >= start - 1.5 && hour < start) return event.score * 0.7;
  if (hour >= start + 2 && hour < start + 3.5) return event.score;
  return 0;
}

function getDelta(score) {
  if (score <= -1.25) return -2;
  if (score <= -0.4) return -1;
  if (score < 0.4) return 0;
  if (score < 1.25) return 1;
  return 2;
}

function deltaText(delta) {
  return ({ '-2': 'かなり少なそう', '-1': '少なそう', 0: 'いつも通り', 1: '混みそう', 2: 'かなり混みそう' })[delta];
}

function scaleText(scale) {
  return ({ small: '小規模', medium: '中規模', large: '大規模' })[scale];
}

function createSlots(day) {
  return [11, 13, 15, 17, 19, 21].map((hour) => {
    const eventScore = day.events.reduce((total, event) => total + eventScoreForSlot(event, hour), 0);
    const weatherScore = day.weather.score;
    const total = eventScore + weatherScore;
    const reasons = [];
    day.events.forEach((event) => {
      if (eventScoreForSlot(event, hour) > 0) reasons.push(`${event.venue} ${event.time}`);
    });
    if (weatherScore < -0.2) reasons.push(day.weather.label);
    return { hour, total, delta: getDelta(total), reasons };
  });
}

function getForecast(date) {
  const day = forecastData[date];
  if (day.closed) return { closed: true };
  const slots = createSlots(day);
  const strongest = slots.reduce((winner, slot) => Math.abs(slot.total) > Math.abs(winner.total) ? slot : winner, slots[0]);
  const dailyEventScore = day.events.reduce((sum, event) => sum + event.score, 0);
  const overallScore = dailyEventScore > 0 ? Math.max(...slots.map((slot) => slot.total)) : day.weather.score;
  const delta = getDelta(overallScore);
  const highlighted = slots.filter((slot) => slot.delta !== 0);
  return { day, slots, strongest, delta, highlighted, overallScore };
}

function reasonText(day, forecast) {
  if (!day.events.length) {
    if (forecast.delta < 0) return `${day.weather.label}の影響で、通常より人流が落ち着く見込みです。`;
    return '大きく影響しそうな天気・近隣イベントはありません。';
  }
  const primary = [...day.events].sort((a, b) => b.score - a.score)[0];
  if (primary.unknownTime) return `${primary.venue}でイベントが予定されています。開始・終了時刻の確認後に通常比へ反映します。`;
  if (forecast.delta < 0) return `${day.weather.label}の影響で、通常より人流が落ち着く見込みです。`;
  const peak = forecast.highlighted.at(-1) || forecast.strongest;
  return `${primary.venue}のイベント後、${String(peak.hour).padStart(2, '0')}:00頃に人流の増加が見込まれます。`;
}

function renderClosed(date) {
  const dateObject = new Date(`${date}T12:00:00`);
  elements.date.textContent = `${formatDate(date)} / 定休日`;
  elements.label.textContent = '本日は';
  elements.value.textContent = '定休日';
  elements.delta.textContent = '—';
  elements.detail.textContent = '日曜は営業していません。来週の要注意日は、日曜朝の週間通知でお知らせします。';
  elements.confidence.textContent = '週間予報を準備中';
  elements.confidenceDot.className = 'neutral';
  elements.slots.innerHTML = '<p class="empty-state">営業日の予報を選択してください。</p>';
  elements.drivers.innerHTML = '<p class="empty-state">日曜日はイベントの通常比に反映しません。</p>';
  elements.lineBubble.innerHTML = `<strong>${dateObject.getMonth() + 1}/${dateObject.getDate()}（日）のSPAGO</strong><br><br>本日は定休日です。<br>来週の予報は日曜朝にお送りします。`;
  document.querySelectorAll('.meter-points span').forEach((point) => point.classList.remove('selected'));
}

function renderSlots(forecast) {
  elements.slots.innerHTML = forecast.slots.map((slot) => {
    const direction = slot.delta > 0 ? 'up' : slot.delta < 0 ? 'down' : 'flat';
    const width = Math.max(18, Math.min(100, 48 + slot.total * 28));
    const detail = slot.reasons.length ? slot.reasons.join(' · ') : '通常の外部要因なし';
    return `<article class="slot-row ${direction}">
      <time>${String(slot.hour).padStart(2, '0')}:00</time>
      <div class="slot-track"><span style="width:${width}%"></span></div>
      <strong>${deltaText(slot.delta)}</strong>
      <small>${detail}</small>
    </article>`;
  }).join('');
  elements.slotSummary.textContent = forecast.highlighted.length
    ? `${forecast.highlighted.map((slot) => `${String(slot.hour).padStart(2, '0')}:00`).join(' / ')} に変動があります。`
    : '通常比を動かす大きな要因はありません。';
}

function renderDrivers(day) {
  const weatherDelta = getDelta(day.weather.score);
  const weatherTone = weatherDelta < 0 ? 'negative' : 'neutral';
  const weatherImpact = weatherDelta < 0 ? '−' : '±';
  const weatherText = weatherDelta < 0 ? '人流をやや抑える見込み' : '大きな補正なし';
  const weather = `<article class="driver-row">
    <div class="driver-symbol weather ${weatherTone}">☼</div>
    <div><strong>天気　${day.weather.label} / ${day.weather.temp}</strong><p>${weatherText}</p></div>
    <b>${weatherImpact}</b>
  </article>`;
  const events = day.events.map((event) => `<article class="driver-row">
    <div class="driver-symbol event">⌁</div>
    <div><strong>${escapeHtml(event.venue)}</strong><p>${escapeHtml(event.timeLabel || `${event.time}開始`)} · ${scaleText(event.scale)} · ${escapeHtml(event.title)}</p></div>
    <b>${event.score > 0 ? '＋' : '…'}</b>
  </article>`).join('');
  elements.drivers.innerHTML = weather + (events || '<p class="empty-state event-empty">登録済みの近隣イベントはありません。</p>');
}

function renderLinePreview(date, day, forecast) {
  const monthDay = new Date(`${date}T12:00:00`);
  const dateLabel = `${monthDay.getMonth() + 1}/${monthDay.getDate()}（${dayNames[monthDay.getDay()]}）`;
  const notable = forecast.highlighted.filter((slot) => slot.delta > 0);
  const hasUnknownTimeEvent = day.events.some((event) => event.unknownTime);
  const time = hasUnknownTimeEvent ? '確認中' : notable.length ? `${String(notable[0].hour).padStart(2, '0')}:00〜${String(notable.at(-1).hour + 2).padStart(2, '0')}:00` : '終日';
  const eventLine = day.events.length ? `\n🎤 ${escapeHtml(day.events[0].venue)} ${escapeHtml(day.events[0].timeLabel || `${day.events[0].time}開始`)}` : '';
  const weatherLine = `\n☼ ${day.weather.label} / ${day.weather.temp}`;
  const conclusion = forecast.delta === 0 ? 'いつも通り' : `通常より${deltaText(forecast.delta)}`;
  elements.lineBubble.innerHTML = `<strong>${dateLabel}のSPAGO</strong><br><br>結論：${conclusion}（${forecast.delta > 0 ? '+' : ''}${forecast.delta}）<br>注意時間：${time}${eventLine}${weatherLine}<br><br><span>※ サンプルデータによるプレビュー</span>`;
}

function render(date) {
  activeDate = date;
  elements.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.date === date));
  const forecast = getForecast(date);
  if (forecast.closed) {
    renderClosed(date);
    return;
  }
  const { day } = forecast;
  const delta = forecast.delta;
  elements.date.textContent = formatDate(date);
  elements.label.textContent = delta === 0 ? '今日は' : '通常より';
  elements.value.textContent = deltaText(delta);
  elements.delta.textContent = `${delta > 0 ? '+' : ''}${delta}`;
  elements.delta.className = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'zero';
  elements.detail.textContent = reasonText(day, forecast);
  elements.confidence.textContent = `確度：${day.weather.confidence}`;
  elements.confidenceDot.className = day.weather.confidence === '高' ? 'high' : 'medium';
  document.querySelectorAll('.meter-points span').forEach((point) => point.classList.toggle('selected', Number(point.dataset.level) === delta));
  renderSlots(forecast);
  renderDrivers(day);
  renderLinePreview(date, day, forecast);
}

elements.tabs.forEach((tab) => tab.addEventListener('click', () => render(tab.dataset.date)));

document.querySelector('#event-button').addEventListener('click', () => {
  elements.form.elements.date.value = activeDate;
  elements.dialog.showModal();
});
document.querySelector('#all-events-button').addEventListener('click', () => elements.dialog.showModal());

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(elements.form);
  const date = form.get('date');
  if (!forecastData[date] || forecastData[date].closed) return;
  const scale = form.get('scale');
  forecastData[date].events.push({
    venue: form.get('venue'),
    title: form.get('title'),
    time: form.get('time'),
    scale,
    score: ({ small: 0.45, medium: 0.95, large: 1.45 })[scale],
    manual: true,
  });
  elements.dialog.close();
  render(date);
});

document.querySelectorAll('[data-feedback]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-feedback]').forEach((item) => item.classList.remove('selected'));
  button.classList.add('selected');
  const messages = {
    higher: '記録しました。イベント係数を見直す候補として保存します。',
    accurate: '記録しました。今回の判定を基準として残します。',
    lower: '記録しました。天気・イベントの補正を見直す候補として保存します。',
  };
  elements.feedback.textContent = messages[button.dataset.feedback];
}));

function renderVenues(sources) {
  venueSources = sources;
  elements.venues.innerHTML = sources.map((source) => {
    const isConnected = source.status === 'connected';
    const eventLabel = source.events.length ? `${source.events.length}件を検出` : '予定を確認中';
    return `<a class="venue-row" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">
      <span class="source-dot ${isConnected ? 'connected' : 'manual'}"></span>
      <strong>${escapeHtml(source.name)}</strong>
      <small>${escapeHtml(source.note)}</small>
      <em>${isConnected ? eventLabel : '公式ページを確認'} ↗</em>
    </a>`;
  }).join('');
}

function setDataStatus(message, tone = 'loading') {
  elements.dataStatus.textContent = message;
  elements.dataStatus.className = `data-status ${tone}`;
}

function applyWeather(weather) {
  for (const date of Object.keys(forecastData)) {
    if (forecastData[date].closed) continue;
    const daySlots = weather.hourly.filter((slot) => date === slot.date && [11, 13, 15, 17, 19, 21].includes(slot.hour));
    if (!daySlots.length) continue;
    const evening = daySlots.find((slot) => slot.hour === 17) || daySlots[0];
    const impactSlot = [...daySlots].sort((first, second) => first.score - second.score)[0];
    forecastData[date].weather = {
      label: impactSlot.score < 0 ? impactSlot.label : evening.label,
      temp: `${Math.round(evening.temperature)}°C`,
      score: Math.min(...daySlots.map((slot) => slot.score)),
      confidence: '高',
      source: weather.source,
    };
  }
}

function applyOfficialEvents(events) {
  for (const date of Object.keys(forecastData)) {
    if (forecastData[date].closed) continue;
    const retained = forecastData[date].events.filter((event) => !event.demo && !event.official);
    const official = events
      .filter((event) => event.date === date)
      .map((event) => ({
        venue: event.venue,
        title: event.title,
        time: event.time || '18:00',
        timeLabel: event.time ? `${event.time}開始` : '時刻確認中',
        scale: event.scale || 'medium',
        score: event.time ? 0.95 : 0,
        unknownTime: !event.time,
        official: true,
      }));
    forecastData[date].events = [...retained, ...official];
  }
}

async function refreshLiveData() {
  setDataStatus('ライブデータを取得中', 'loading');
  elements.refresh.disabled = true;
  try {
    const [weatherResponse, venueResponse] = await Promise.all([fetch('/api/weather'), fetch('/api/venues')]);
    const [weatherPayload, venuePayload] = await Promise.all([weatherResponse.json(), venueResponse.json()]);
    if (!weatherResponse.ok) throw new Error(weatherPayload.error || '天気情報の取得に失敗しました。');
    if (!venueResponse.ok) throw new Error(venuePayload.error || '会場情報の取得に失敗しました。');
    applyWeather(weatherPayload);
    applyOfficialEvents(venuePayload.events);
    renderVenues(venuePayload.sources);
    render(activeDate);
    setDataStatus('天気・会場を更新済み', 'live');
  } catch (error) {
    if (!venueSources.length) {
      renderVenues([
        { name: '東京体育館', url: 'https://www.tef.or.jp/tmg/', note: '大会・イベント日程', status: 'manual', events: [] },
        { name: '明治神宮野球場', url: 'https://www.jingu-stadium.com/', note: '当日スケジュール', status: 'manual', events: [] },
        { name: '国立代々木競技場', url: 'https://www.jpnsport.go.jp/yoyogi/tabid/58/default.aspx', note: '第一・第二体育館の公式情報', status: 'manual', events: [] },
      ]);
    }
    setDataStatus('ライブ取得に失敗 — サンプル表示中', 'error');
    console.error(error);
  } finally {
    elements.refresh.disabled = false;
  }
}

elements.refresh.addEventListener('click', refreshLiveData);
render(activeDate);
refreshLiveData();
