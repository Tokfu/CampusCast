'use strict';
/* =====================================================================
   CampusCast – Laboratory Activity 2
   Dashboard + Open-Meteo integration (Geocoding API → Forecast API)

   ACCESS METHOD: Public access. The standard Open-Meteo endpoints are free
   for non-commercial use and need NO API key, bearer token, or OAuth.
   Nothing secret exists in this file, so nothing needs to be hidden.
   ===================================================================== */

const API = {
  geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
  forecast: 'https://api.open-meteo.com/v1/forecast'
};

/* ---------------------------------------------------------------------
   ACCESS METHOD (Requirement 3)
   Open-Meteo's standard endpoints use PUBLIC ACCESS: free for
   non-commercial use, no API key / bearer token / OAuth. Every request
   below is therefore sent WITHOUT credentials (see buildRequestOptions),
   and CampusCast has no user accounts or third-party sign-in because
   nothing in the app needs one. Source: https://open-meteo.com/en/terms
   --------------------------------------------------------------------- */
const ACCESS_METHOD = Object.freeze({
  type: 'Public access',
  key: 'Not required – no API key, bearer token, or OAuth',
  headers: 'No Authorization header; credentials: "omit" (no cookies). Only "Accept: application/json" is sent.',
  signIn: 'Not required – CampusCast has no user accounts or third-party sign-in',
  secrets: 'None exist, so nothing is hidden in the source code or screenshots',
  limits: 'Free tier: under 10,000 calls/day, 5,000/hour, 600/minute – handled by the 429 cooldown and 10-minute cache',
  terms: 'Non-commercial use only (no ads or subscriptions) – this is a school project',
  license: 'Data licensed CC BY 4.0 – attribution to Open-Meteo is shown in the footer',
  source: 'https://open-meteo.com/en/terms'
});

function buildRequestOptions(signal) {
  // Public access: nothing secret to attach, so no credentials are sent.
  return { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', signal };
}

const DEFAULT_QUERY = 'General Trias';
const REQUEST_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 10 * 60 * 1000;     // reuse forecasts for 10 min (fewer requests)
const DEFAULT_COOLDOWN_S = 60;           // wait time after an HTTP 429
const SCHOOL_START = 6, SCHOOL_END = 18; // school-day window (local hours)

/* ---------- state ---------- */
const cache = new Map();
let currentData = null;      // { loc, data } of the last successful load
let lastRequest = null;      // function used by the Retry button
let rateLimitedUntil = 0;
let cooldownTimer = null;
const lastApiDebug = {};     // real request/response samples for the API inspector

/* ---------- weather codes (WMO) ---------- */
const WMO = {
  0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '🌨️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm with hail', '⛈️'], 99: ['Severe thunderstorm', '⛈️']
};
const describeCode = c => WMO[c] || ['Unknown', '❔'];
const isThunder = c => c >= 95;
const isRainyCode = c => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
const TONE = { good: 'success', info: 'info', warn: 'warning', bad: 'danger' };

/* ---------- small helpers ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fullName = l => [l.name, l.admin1, l.country].filter(Boolean).join(', ');
const round = n => Math.round(n);
const formatHour = h => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;
const formatLocalTime = t => new Date(t).toLocaleString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/* =====================================================================
   REQUEST LAYER – timeouts, rate limits, error classification
   ===================================================================== */
class ApiError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const ERROR_TITLES = {
  'rate-limit': 'Too many requests',
  'timeout': 'Request timed out',
  'network': 'Connection problem',
  'server': 'Weather service unavailable',
  'not-found': 'Location not found',
  'bad-request': 'Request not accepted',
  'unknown': 'Something went wrong'
};

async function fetchJson(url) {
  // Respect an active rate-limit cooldown instead of hammering the API.
  const wait = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
  if (wait > 0) throw new ApiError('rate-limit', `The weather service asked us to slow down. Please wait ${wait} more second${wait === 1 ? '' : 's'} before trying again.`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, buildRequestOptions(ctrl.signal));
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('timeout', 'The request took too long. Check your connection and try again.');
    throw new ApiError('network', navigator.onLine
      ? 'Could not reach the weather service. Please try again in a moment.'
      : 'You appear to be offline. Reconnect to the internet and try again.');
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON body */ }
  const reason = body && body.reason ? body.reason : '';

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
    const secs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_COOLDOWN_S;
    rateLimitedUntil = Date.now() + secs * 1000;
    throw new ApiError('rate-limit', `Too many requests were sent to the weather service. Please wait about ${secs} seconds, then try again.${reason ? ' (' + reason + ')' : ''}`);
  }
  if (res.status === 400) throw new ApiError('bad-request', `The weather service did not accept the request.${reason ? ' ' + reason : ''}`);
  if (res.status >= 500) throw new ApiError('server', `The weather service is having problems (HTTP ${res.status}). Please try again shortly.`);
  if (!res.ok) throw new ApiError('unknown', `Unexpected response from the weather service (HTTP ${res.status}).`);
  if (!body) throw new ApiError('server', 'The weather service returned an unreadable response.');
  if (body.error) throw new ApiError('bad-request', body.reason || 'The weather service reported an error.');
  return body;
}

/* =====================================================================
   API 1 – Open-Meteo Geocoding: place name → coordinates
   ===================================================================== */
async function geocode(query) {
  const url = `${API.geocoding}?${new URLSearchParams({ name: query, count: 5, language: 'en', format: 'json' })}`;
  const data = await fetchJson(url);
  if (!data.results || !data.results.length) {
    throw new ApiError('not-found', `No location found for “${query}”. Check the spelling or try a nearby city.`);
  }
  lastApiDebug.geocoding = { url, sample: data.results[0] };
  return data.results;
}

/* =====================================================================
   API 2 – Open-Meteo Forecast: coordinates → weather
   ===================================================================== */
async function getForecast(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) {
    lastApiDebug.forecast = hit.debug;
    return hit.data;
  }
  const url = `${API.forecast}?${new URLSearchParams({
    latitude: lat, longitude: lon,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max',
    timezone: 'auto',
    forecast_days: 2
  })}`;
  const data = await fetchJson(url);
  if (!data.current || !data.hourly || !data.daily || !data.hourly.time) {
    throw new ApiError('server', 'The forecast response was incomplete. Please try again.');
  }
  const debug = { url, sample: sampleForecast(data) };
  lastApiDebug.forecast = debug;
  cache.set(key, { time: Date.now(), data, debug });
  return data;
}

function sampleForecast(data) {
  const shorten = (obj, n) => {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = Array.isArray(obj[k]) ? obj[k].slice(0, n).concat(['…']) : obj[k];
    return out;
  };
  return {
    latitude: data.latitude, longitude: data.longitude, timezone: data.timezone,
    current_units: data.current_units, current: data.current,
    hourly: shorten(data.hourly, 3), daily: shorten(data.daily, 2)
  };
}

/* =====================================================================
   RECOMMENDATION RULES – raw weather → student advice
   (thresholds are documented in the README; heat uses PAGASA-style bands
    applied to the "feels like" temperature as an approximation)
   ===================================================================== */
function hourIndex(data) {
  return data.hourly.time.findIndex(t => t.slice(0, 13) === data.current.time.slice(0, 13));
}

function pickSchoolWindow(data) {
  const nowHour = parseInt(data.current.time.slice(11, 13), 10);
  const dayIndex = nowHour >= SCHOOL_END ? 1 : 0;   // after school → show tomorrow
  const date = data.daily.time[dayIndex];
  const rows = [];
  data.hourly.time.forEach((t, i) => {
    if (t.slice(0, 10) !== date) return;
    const h = parseInt(t.slice(11, 13), 10);
    if (h < SCHOOL_START || h > SCHOOL_END) return;
    rows.push({
      time: t, hour: h,
      temp: data.hourly.temperature_2m[i] ?? 0,
      feels: data.hourly.apparent_temperature[i] ?? data.hourly.temperature_2m[i] ?? 0,
      rain: data.hourly.precipitation_probability[i] ?? 0,
      code: data.hourly.weather_code[i] ?? 0,
      wind: data.hourly.wind_speed_10m[i] ?? 0,
      past: dayIndex === 0 && h < nowHour
    });
  });
  return { dayIndex, label: dayIndex === 0 ? 'Today' : 'Tomorrow', rows };
}

const ACTIVITIES = [
  { name: 'PE class',          icon: '🏃', bad: { rain: 60, feels: 38, wind: 60 }, warn: { rain: 30, feels: 33, wind: 40, uv: 8 } },
  { name: 'Sports practice',   icon: '⚽', bad: { rain: 50, feels: 40, wind: 50 }, warn: { rain: 30, feels: 33, wind: 35, uv: 9 } },
  { name: 'Campus activities', icon: '🎪', bad: { rain: 70, feels: 42, wind: 60 }, warn: { rain: 40, feels: 35, wind: 45, uv: 10 } },
  { name: 'Outdoor studying',  icon: '📚', bad: { rain: 40, feels: 36, wind: 40 }, warn: { rain: 20, feels: 32, wind: 30, uv: 8 } }
];
const GENERAL_OUTDOOR = { bad: { rain: 60, feels: 42, wind: 50 }, warn: { rain: 30, feels: 33, wind: 35, uv: 8 } };

function rateActivity(rule, m) {
  const reasons = [];
  let bad = false, warn = false;
  if (m.thunder) { bad = true; reasons.push('Thunderstorm risk'); }
  if (m.maxRain >= rule.bad.rain) { bad = true; reasons.push(`${m.maxRain}% rain chance`); }
  else if (m.maxRain >= rule.warn.rain) { warn = true; reasons.push(`${m.maxRain}% rain chance`); }
  if (m.maxFeels >= rule.bad.feels) { bad = true; reasons.push(`Feels like ${round(m.maxFeels)}°C`); }
  else if (m.maxFeels >= rule.warn.feels) { warn = true; reasons.push(`Feels like ${round(m.maxFeels)}°C`); }
  if (m.maxWind >= rule.bad.wind) { bad = true; reasons.push(`Wind up to ${round(m.maxWind)} km/h`); }
  else if (m.maxWind >= rule.warn.wind) { warn = true; reasons.push(`Wind up to ${round(m.maxWind)} km/h`); }
  if (m.uv >= rule.warn.uv) { warn = true; reasons.push(`UV index ${m.uv.toFixed(0)}`); }
  return {
    status: bad ? 'Not recommended' : warn ? 'Use caution' : 'Suitable',
    tone: bad ? 'bad' : warn ? 'warn' : 'good',
    reasons: reasons.length ? reasons : ['Conditions look fine']
  };
}

function analyze(data) {
  const win = pickSchoolWindow(data);
  const remaining = win.rows.filter(r => !r.past);
  const rows = remaining.length ? remaining : win.rows;
  if (!rows.length) throw new ApiError('server', 'The forecast did not include school-hour data. Please try again.');

  const maxRain = Math.max(...rows.map(r => r.rain));
  const peak = rows.find(r => r.rain === maxRain);
  const m = {
    maxRain,
    maxFeels: Math.max(...rows.map(r => r.feels)),
    maxWind: Math.max(...rows.map(r => r.wind)),
    minTemp: Math.min(...rows.map(r => r.temp)),
    thunder: rows.some(r => isThunder(r.code)),
    uv: data.daily.uv_index_max[win.dayIndex] ?? 0
  };

  // Rain
  let rain;
  if (m.thunder) rain = { tone: 'bad', status: 'Required', advice: 'Thunderstorm possible – bring an umbrella and avoid open areas' };
  else if (m.maxRain >= 60) rain = { tone: 'bad', status: 'Recommended', advice: 'Umbrella recommended' };
  else if (m.maxRain >= 30) rain = { tone: 'warn', status: 'Optional', advice: 'Pack a compact umbrella just in case' };
  else rain = { tone: 'good', status: 'Not needed', advice: 'Low chance of rain' };

  // Heat (PAGASA-style heat-index bands on the feels-like temperature)
  let heat;
  if (m.maxFeels >= 42) heat = { tone: 'bad', status: 'Danger', advice: 'Dangerous heat – bring lots of water, stay in shade, limit time outdoors' };
  else if (m.maxFeels >= 33) heat = { tone: 'warn', status: 'Extreme caution', advice: 'Bring drinking water and rest in the shade' };
  else if (m.maxFeels >= 28) heat = { tone: 'info', status: 'Bring water', advice: 'Bring drinking water' };
  else heat = { tone: 'good', status: 'Comfortable', advice: 'No heat concerns' };

  // Clothing
  const parts = [];
  if (m.minTemp <= 22) parts.push('Bring a jacket');
  else if (m.maxFeels >= 30) parts.push('Light, breathable clothing');
  else parts.push('Light clothing');
  if (m.maxRain >= 60) parts.push('wear shoes that handle wet floors');
  if (m.maxWind >= 40) parts.push('secure loose papers');
  const clothing = { tone: 'info', status: parts[0].startsWith('Bring') ? 'Jacket' : 'Light', advice: parts.join(' · ') };

  const outdoor = rateActivity(GENERAL_OUTDOOR, m);
  const activities = ACTIVITIES.map(a => ({ ...a, ...rateActivity(a, m) }));

  // Overall readiness score
  const score =
    (m.thunder ? 3 : m.maxRain >= 60 ? 2 : m.maxRain >= 30 ? 1 : 0) +
    (m.maxFeels >= 42 ? 3 : m.maxFeels >= 33 ? 2 : m.maxFeels >= 28 ? 1 : 0) +
    (m.maxWind >= 50 ? 2 : m.maxWind >= 35 ? 1 : 0);
  const overall = score <= 1 ? { level: 'Good', tone: 'good' }
    : score <= 4 ? { level: 'Moderate', tone: 'warn' }
    : { level: 'Needs Extra Prep', tone: 'bad' };

  let summary;
  const when = win.label === 'Tomorrow' ? ' tomorrow' : '';
  if (m.maxRain >= 30) summary = `Prepare for ${m.maxRain >= 60 ? 'likely' : 'possible'} rain around ${formatHour(peak.hour)}${when}.`;
  else if (m.maxFeels >= 33) summary = `Hot conditions${when} – keep water handy and rest in the shade.`;
  else summary = `Conditions look smooth for school${when}.`;

  return { win, rows, m, peak, rain, heat, clothing, outdoor, activities, overall, score, summary };
}

/* =====================================================================
   UI STATE
   ===================================================================== */
function setState(state) { // 'loading' | 'content' | 'error' | 'idle'
  $('loadingState').classList.toggle('d-none', state !== 'loading');
  $('errorState').classList.toggle('d-none', state !== 'error');
  document.querySelectorAll('.data-section').forEach(el => el.classList.toggle('d-none', state !== 'content'));
}

function showLoading(text) { $('loadingText').textContent = text; setState('loading'); }

function clearAlert() { $('alertArea').innerHTML = ''; }
function showAlert(title, message, type = 'danger') {
  $('alertArea').innerHTML = `
    <div class="alert alert-${type} alert-dismissible fade show" role="alert">
      <strong>${esc(title)}</strong> ${esc(message)}
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    </div>`;
}

function updateRetryButton() {
  const btn = $('retryBtn');
  clearInterval(cooldownTimer);
  const tick = () => {
    const left = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    if (left > 0) { btn.disabled = true; btn.textContent = `Try again in ${left}s`; }
    else { btn.disabled = false; btn.textContent = 'Try again'; clearInterval(cooldownTimer); }
  };
  tick();
  if (rateLimitedUntil > Date.now()) cooldownTimer = setInterval(tick, 1000);
}

function showError(e) {
  $('errorTitle').textContent = ERROR_TITLES[e.kind] || ERROR_TITLES.unknown;
  $('errorMessage').textContent = e.message;
  $('retryBtn').classList.toggle('d-none', e.kind === 'not-found');
  updateRetryButton();
  setState('error');
}

function handleError(err) {
  const e = err instanceof ApiError ? err : new ApiError('unknown', 'Something unexpected happened. Please try again.');
  if (!(err instanceof ApiError)) console.error(err);
  if (currentData) {               // keep showing the last good data, explain what failed
    setState('content');
    showAlert(ERROR_TITLES[e.kind] + '.', e.message, e.kind === 'not-found' ? 'warning' : 'danger');
  } else {
    showError(e);
  }
}

/* =====================================================================
   FLOW: search → geocode → (choose) → forecast → render
   ===================================================================== */
function hideChooser() { $('locationResults').innerHTML = ''; }

function showChooser(results) {
  $('locationResults').innerHTML = `
    <div class="card cc-card mb-3"><div class="card-body">
      <div class="d-flex justify-content-between align-items-start mb-2">
        <h2 class="h6 fw-bold mb-0">Several places match – pick one</h2>
        <button type="button" class="btn-close" id="chooserClose" aria-label="Close"></button>
      </div>
      <div class="list-group list-group-flush" id="chooserList"></div>
    </div></div>`;
  $('chooserClose').addEventListener('click', hideChooser);
  results.forEach(r => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'list-group-item list-group-item-action';
    b.textContent = fullName(r);
    b.addEventListener('click', () => selectLocation(r));
    $('chooserList').appendChild(b);
  });
}

async function loadLocation(query, autoPick) {
  lastRequest = () => loadLocation(query, autoPick);
  clearAlert(); hideChooser();
  showLoading(`Finding “${query}”…`);
  try {
    const results = await geocode(query);
    if (autoPick || results.length === 1) {
      await selectLocation(results[0]);
    } else {
      showChooser(results);
      setState(currentData ? 'content' : 'idle');
    }
  } catch (err) { handleError(err); }
}

async function selectLocation(loc) {
  lastRequest = () => selectLocation(loc);
  clearAlert(); hideChooser();
  showLoading(`Getting the forecast for ${loc.name}…`);
  try {
    const data = await getForecast(loc.latitude, loc.longitude);
    const analysis = analyze(data);
    currentData = { loc, data };
    renderAll(loc, data, analysis);
    setState('content');
  } catch (err) { handleError(err); }
}

/* =====================================================================
   RENDERING
   ===================================================================== */
function heroClass(c) {
  if (isThunder(c.weather_code)) return 'hero-storm';
  if (isRainyCode(c.weather_code)) return 'hero-rain';
  if (!c.is_day) return 'hero-night';
  if (c.weather_code >= 2) return 'hero-cloud';
  return 'hero-sun';
}

function badge(tone, text) { return `<span class="badge text-bg-${TONE[tone]}">${esc(text)}</span>`; }

function renderAll(loc, data, a) {
  renderOverview(loc, data, a);
  renderReadiness(data, a);
  renderOutdoor(a);
  renderHourly(a);
  renderInspector();
}

function renderOverview(loc, data, a) {
  const c = data.current, d = data.daily;
  const [desc, icon] = describeCode(c.weather_code);
  const idx = hourIndex(data);
  const rainNow = idx >= 0 ? (data.hourly.precipitation_probability[idx] ?? 0) : 0;

  $('hero').className = 'card cc-hero h-100 ' + heroClass(c);
  $('placeName').textContent = fullName(loc);
  $('updatedAt').textContent = 'Updated ' + formatLocalTime(c.time) + ' (local time)';
  $('heroIcon').textContent = icon;
  $('heroTemp').textContent = round(c.temperature_2m) + '°C';
  $('heroDesc').textContent = desc;
  $('heroFeels').textContent = 'Feels like ' + round(c.apparent_temperature) + '°C';
  $('heroLine').textContent = `${round(c.temperature_2m)}°C | ${rainNow}% Rain | Humidity: ${round(c.relative_humidity_2m)}%`;

  const uv = d.uv_index_max[0] ?? 0;
  const uvLabel = uv < 3 ? 'Low' : uv < 6 ? 'Moderate' : uv < 8 ? 'High' : uv < 11 ? 'Very high' : 'Extreme';
  const stats = [
    ['🌧️', 'Rain chance (this hour)', `${rainNow}%`],
    ['💧', 'Humidity', `${round(c.relative_humidity_2m)}%`],
    ['💨', 'Wind', `${round(c.wind_speed_10m)} km/h`],
    ['🌡️', 'High / Low today', `${round(d.temperature_2m_max[0])}° / ${round(d.temperature_2m_min[0])}°`],
    ['☀️', 'UV index (max today)', `${uv.toFixed(1)} · ${uvLabel}`],
    ['☔', 'Rain now', `${c.precipitation} mm`]
  ];
  $('statsGrid').innerHTML = stats.map(([i, l, v]) => `
    <div class="col-6 col-md-4"><div class="card cc-card stat h-100"><div class="card-body">
      <div class="stat-icon" aria-hidden="true">${i}</div>
      <div class="stat-label">${esc(l)}</div>
      <div class="stat-value">${esc(v)}</div>
    </div></div></div>`).join('');
}

function renderReadiness(data, a) {
  const c = data.current;
  const idx = hourIndex(data);
  const rainNow = idx >= 0 ? (data.hourly.precipitation_probability[idx] ?? 0) : 0;
  $('readinessTitle').textContent = `${a.win.label}'s student readiness`;
  $('readinessBadge').className = `badge fs-6 text-bg-${TONE[a.overall.tone]}`;
  $('readinessBadge').textContent = a.overall.level;
  $('readinessLine').textContent = `${round(c.temperature_2m)}°C | ${rainNow}% Rain | Humidity: ${round(c.relative_humidity_2m)}%`;

  const items = [
    ['Rain', a.rain], ['Heat', a.heat], ['Clothing', a.clothing],
    ['Outdoor Activity', { tone: a.outdoor.tone, status: a.outdoor.status, advice: a.outdoor.reasons.join(' · ') }]
  ];
  $('readinessList').innerHTML = items.map(([label, it]) => `
    <li class="list-group-item">
      <span class="rl-label">${esc(label)}</span>
      ${badge(it.tone, it.status)}
      <span class="rl-advice">${esc(it.advice)}</span>
    </li>`).join('');
  $('readinessSummary').textContent = 'Overall: ' + a.summary;
}

function renderOutdoor(a) {
  $('outdoorGrid').innerHTML = a.activities.map(act => `
    <div class="col-sm-6 col-lg-3"><div class="card cc-card h-100"><div class="card-body">
      <div class="activity-icon" aria-hidden="true">${act.icon}</div>
      <h3 class="h6 fw-bold mt-2">${esc(act.name)}</h3>
      <div class="mb-2">${badge(act.tone, act.status)}</div>
      <div class="small text-body-secondary">${esc(act.reasons.join(' · '))}</div>
    </div></div></div>`).join('');
}

function renderHourly(a) {
  $('hourlyTitle').textContent = `${a.win.label}'s School-Day Forecast`;
  $('hourlyBody').innerHTML = a.win.rows.map(r => {
    const [desc, icon] = describeCode(r.code);
    const hot = r.rain >= 60 ? 'bg-danger' : r.rain >= 30 ? 'bg-warning' : 'bg-success';
    const cls = [r.past ? 'cc-past' : '', (r === a.peak && r.rain >= 30) ? 'table-warning' : ''].join(' ').trim();
    const note = r.hour === 16 ? ' <span class="badge text-bg-secondary">Dismissal ~4 PM</span>' : '';
    return `<tr class="${cls}">
      <td class="fw-semibold">${formatHour(r.hour)}${note}</td>
      <td><span aria-hidden="true">${icon}</span> ${esc(desc)}</td>
      <td>${round(r.temp)}°C</td>
      <td>${round(r.feels)}°C</td>
      <td><div class="d-flex align-items-center gap-2"><div class="progress flex-grow-1" style="height:8px" role="progressbar" aria-valuenow="${r.rain}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar ${hot}" style="width:${r.rain}%"></div></div><span class="small">${r.rain}%</span></div></td>
      <td>${round(r.wind)} km/h</td>
    </tr>`;
  }).join('');
}

function renderAccessMethod() {
  const rows = [
    ['Access method', `<span class="badge text-bg-success">${esc(ACCESS_METHOD.type)}</span>`],
    ['API key / token', esc(ACCESS_METHOD.key)],
    ['Request headers', esc(ACCESS_METHOD.headers)],
    ['Third-party sign-in', esc(ACCESS_METHOD.signIn)],
    ['Private credentials', esc(ACCESS_METHOD.secrets)],
    ['Usage limits', esc(ACCESS_METHOD.limits)],
    ['Terms of use', esc(ACCESS_METHOD.terms)],
    ['License / attribution', esc(ACCESS_METHOD.license)],
    ['Source', `<a href="${esc(ACCESS_METHOD.source)}" target="_blank" rel="noopener">${esc(ACCESS_METHOD.source)}</a>`]
  ];
  $('accessTable').innerHTML = rows.map(([k, v]) => `<tr><th scope="row" class="text-nowrap">${k}</th><td>${v}</td></tr>`).join('');
}

function renderInspector() {
  const g = lastApiDebug.geocoding, f = lastApiDebug.forecast;
  $('geoUrl').textContent = g ? decodeURIComponent(g.url) : '—';
  $('geoJson').textContent = g ? JSON.stringify(g.sample, null, 2) : '—';
  $('fcUrl').textContent = f ? decodeURIComponent(f.url) : '—';
  $('fcJson').textContent = f ? JSON.stringify(f.sample, null, 2) : '—';
}

/* =====================================================================
   INIT
   ===================================================================== */
function onSearch(e) {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (q.length < 2) { showAlert('Search too short.', 'Please type at least 2 characters.', 'warning'); return; }
  const menu = $('navMenu');
  if (menu.classList.contains('show')) bootstrap.Collapse.getOrCreateInstance(menu).hide();
  loadLocation(q, false);
}

function init() {
  $('searchForm').addEventListener('submit', onSearch);
  $('retryBtn').addEventListener('click', () => { if (lastRequest) lastRequest(); });
  renderAccessMethod();
  loadLocation(DEFAULT_QUERY, true);   // proposal's example location: General Trias
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { analyze, pickSchoolWindow, rateActivity, describeCode, formatHour, ACCESS_METHOD, buildRequestOptions };
} else {
  document.addEventListener('DOMContentLoaded', init);
}
