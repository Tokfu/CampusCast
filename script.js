const GEOCODING_API = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';
const forecastCache = new Map();

let currentPlace = null;
let currentForecast = null;
let commuteState = {
  origin: { place: null, forecast: null, loading: false, error: null },
  destination: { place: null, forecast: null, loading: false, error: null }
};

const pageTitles = {
  today: 'Today',
  commute: 'Commute',
  preparedness: 'Weather tips',
  about: 'About'
};

function escapeHtml(value) {
  const safeValue = value != null ? value : '';
  return String(safeValue).replace(/[&<>"']/g, function(character) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character];
  });
}

function formatValue(value, suffix) {
  suffix = suffix || '';
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Unavailable';
  }
  return Math.round(value) + suffix;
}

function placeName(place) {
  if (!place) return 'Location';
  return [place.name, place.admin1, place.country].filter(Boolean).join(', ');
}

function conditionDescription(code) {
  const descriptions = {
    0: 'Clear sky',
    1: 'Mostly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Freezing fog',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Heavy drizzle',
    56: 'Freezing drizzle',
    57: 'Freezing drizzle',
    61: 'Light rain',
    63: 'Rain',
    65: 'Heavy rain',
    66: 'Freezing rain',
    67: 'Freezing rain',
    71: 'Light snow',
    73: 'Snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Light showers',
    81: 'Showers',
    82: 'Heavy showers',
    85: 'Snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Severe thunderstorm'
  };
  return descriptions[code] || 'Conditions unavailable';
}

function weatherIcon(code) {
  if (typeof code !== 'number') return '◌';
  if (code >= 95) return '⛈';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '🌧';
  if (code >= 71 && code <= 86) return '❄';
  if (code === 45 || code === 48) return '🌫';
  if (code === 0) return '☀';
  if (code === 1 || code === 2) return '🌤';
  return '☁';
}

function getDailyIndex(forecast, date) {
  const dates = (forecast && forecast.daily && forecast.daily.time) ? forecast.daily.time : [];
  const index = dates.indexOf(date);
  return index >= 0 ? index : 0;
}

function getHourlyRows(forecast) {
  const hourly = forecast && forecast.hourly ? forecast.hourly : null;
  const times = hourly && hourly.time ? hourly.time : [];
  if (!Array.isArray(times)) return [];

  const currentTime = (forecast && forecast.current && forecast.current.time) ? forecast.current.time : (times[0] || '');
  const currentDate = currentTime.slice(0, 10);
  const currentHour = Number(currentTime.slice(11, 13));
  let targetDate = currentDate;

  if (currentHour >= 18) {
    const nextDate = new Date(currentDate + 'T12:00:00Z');
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    targetDate = nextDate.toISOString().slice(0, 10);
  }

  const rows = [];
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    const date = time.slice(0, 10);
    const hour = Number(time.slice(11, 13));

    if (date !== targetDate || hour < 6 || hour > 18) continue;

    rows.push({
      time: time,
      date: date,
      hour: hour,
      temperature: hourly.temperature_2m ? hourly.temperature_2m[index] : undefined,
      feelsLike: hourly.apparent_temperature ? hourly.apparent_temperature[index] : undefined,
      rain: hourly.precipitation_probability ? hourly.precipitation_probability[index] : undefined,
      code: hourly.weather_code ? hourly.weather_code[index] : undefined,
      wind: hourly.wind_speed_10m ? hourly.wind_speed_10m[index] : undefined,
      past: date === currentDate && hour < currentHour
    });
  }
  return rows;
}

function getRainNow(forecast) {
  const times = (forecast && forecast.hourly && forecast.hourly.time) ? forecast.hourly.time : [];
  const currentTime = (forecast && forecast.current && forecast.current.time) ? forecast.current.time : null;
  if (!currentTime) return undefined;

  let index = times.indexOf(currentTime);
  if (index < 0) {
    const date = currentTime.slice(0, 10);
    const hour = currentTime.slice(11, 13);
    index = times.findIndex(function(time) {
      return time.slice(0, 10) === date && time.slice(11, 13) === hour;
    });
  }

  return (index >= 0 && forecast.hourly && forecast.hourly.precipitation_probability) ? forecast.hourly.precipitation_probability[index] : undefined;
}

function getAdvice(forecast) {
  const schoolRows = getHourlyRows(forecast);
  const rows = schoolRows.filter(function(row) { return !row.past; });

  const rainValues = rows.map(function(row) { return row.rain; }).filter(Number.isFinite);
  const feelsValues = rows.map(function(row) { return row.feelsLike; }).filter(Number.isFinite);
  const temperatureValues = rows.map(function(row) { return row.temperature; }).filter(Number.isFinite);
  const weatherCodes = rows.map(function(row) { return row.code; }).filter(Number.isFinite);

  const currentDate = (forecast && forecast.current && forecast.current.time) ? forecast.current.time.slice(0, 10) : null;
  const dailyIndex = getDailyIndex(forecast, currentDate);
  const uv = (forecast && forecast.daily && forecast.daily.uv_index_max) ? forecast.daily.uv_index_max[dailyIndex] : undefined;

  const maxRain = rainValues.length ? Math.max.apply(null, rainValues) : undefined;
  const maxFeels = feelsValues.length ? Math.max.apply(null, feelsValues) : undefined;
  const minTemp = temperatureValues.length ? Math.min.apply(null, temperatureValues) : undefined;
  const maxTemp = temperatureValues.length ? Math.max.apply(null, temperatureValues) : undefined;

  const thunderstorm = weatherCodes.some(function(code) { return code >= 95; });
  const dataCount = [maxRain, maxFeels, minTemp, uv].filter(Number.isFinite).length;

  let rain;
  if (!Number.isFinite(maxRain)) {
    rain = 'Rain probability is unavailable for the school-day hours.';
  } else if (thunderstorm) {
    rain = 'Thunderstorms appear in the available forecast. Bring rain protection and avoid exposed outdoor areas.';
  } else if (maxRain >= 60) {
    rain = 'Rain protection is a good idea. The highest available hourly rain chance is ' + Math.round(maxRain) + '%.';
  } else if (maxRain >= 30) {
    rain = 'Consider a compact umbrella. An available hour reaches ' + Math.round(maxRain) + '% rain probability.';
  } else {
    rain = 'Available hourly rain probabilities are low. Keep in mind forecasts can change.';
  }

  let clothing;
  if (!Number.isFinite(minTemp) || !Number.isFinite(maxFeels)) {
    clothing = 'Temperature details are incomplete. Check again closer to departure.';
  } else if (minTemp <= 22) {
    clothing = 'A light layer may help during cooler hours.';
  } else if (maxFeels >= 30) {
    clothing = 'Choose light, breathable clothing for warmer-feeling hours.';
  } else {
    clothing = 'Comfortable everyday layers should suit the available temperatures.';
  }

  let heat;
  if (!Number.isFinite(maxFeels)) {
    heat = 'Feels-like temperature is unavailable in the school-day forecast.';
  } else if (maxFeels >= 33) {
    heat = 'Feels-like temperatures may reach ' + Math.round(maxFeels) + '°C. Carry water, seek shade and take breaks.';
  } else if (maxFeels >= 28) {
    heat = 'Warm conditions are possible, with feels-like temperatures up to ' + Math.round(maxFeels) + '°C. Bring water.';
  } else {
    heat = 'No strong heat signal in available feels-like temperatures. Bring water as usual.';
  }

  let outdoor;
  if (thunderstorm) {
    outdoor = 'Consider moving strenuous outdoor plans indoors if thunderstorms develop.';
  } else if (!Number.isFinite(maxRain)) {
    outdoor = 'Rain outlook is incomplete. Check again before outdoor classes or activities.';
  } else if (maxRain >= 50) {
    outdoor = 'Keep a flexible indoor option for outdoor classes and activities.';
  } else {
    outdoor = 'Outdoor plans look more workable from the available rain data. Conditions may change.';
  }

  return { rows: schoolRows, rain: rain, clothing: clothing, heat: heat, outdoor: outdoor, maxRain: maxRain, maxFeels: maxFeels, minTemp: minTemp, maxTemp: maxTemp, uv: uv, dataCount: dataCount };
}

function formatForecastDate(time) {
  if (!time) return 'Local forecast';
  const date = time.slice(0, 10);
  const parsedDate = new Date(date + 'T12:00:00Z');
  return parsedDate.toLocaleDateString('en', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

function formatHour(hour) {
  if (hour === 0) return '12 AM';
  if (hour < 12) return hour + ' AM';
  if (hour === 12) return '12 PM';
  return (hour - 12) + ' PM';
}

async function requestJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error('The weather service returned an unreadable response.');
  }
  if (!response.ok || (data && data.error)) {
    throw new Error((data && data.reason) ? data.reason : 'Open-Meteo is temporarily unavailable. Please try again.');
  }
  return data;
}

async function searchLocations(query) {
  const url = GEOCODING_API + '?' + new URLSearchParams({
    name: query,
    count: '6',
    language: 'en',
    format: 'json'
  }).toString();
  const data = await requestJson(url);
  return Array.isArray(data.results) ? data.results : [];
}

async function getForecast(place) {
  const key = Number(place.latitude).toFixed(2) + ',' + Number(place.longitude).toFixed(2);
  const cached = forecastCache.get(key);
  if (cached && Date.now() - cached.savedAt < 5 * 60 * 1000) {
    return cached.forecast;
  }

  const url = FORECAST_API + '?' + new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max',
    timezone: 'auto',
    forecast_days: '2'
  }).toString();

  const forecast = await requestJson(url);
  forecastCache.set(key, { forecast: forecast, savedAt: Date.now() });
  return forecast;
}

function showSearchMessage(resultsElement, message) {
  resultsElement.innerHTML = '<div class="search-message">' + escapeHtml(message) + '</div>';
}

function renderLocationOptions(resultsElement, locations, onSelect) {
  if (!locations.length) {
    showSearchMessage(resultsElement, 'No locations found. Try a nearby city or a different spelling.');
    return;
  }

  resultsElement.innerHTML = locations.map(function(place, index) {
    const adminDetails = [place.admin1, place.country].filter(Boolean).join(' · ') || 'Location';
    return '<button class="location-option" type="button" data-location-index="' + index + '">' +
      '<span><strong>' + escapeHtml(place.name) + '</strong><small>' + escapeHtml(adminDetails) + '</small></span>' +
      '<span class="location-arrow">→</span>' +
    '</button>';
  }).join('');

  const buttons = resultsElement.querySelectorAll('[data-location-index]');
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function() {
      const place = locations[Number(this.dataset.locationIndex)];
      resultsElement.innerHTML = '';
      onSelect(place);
    });
  }
}

function setupLocationSearch(formId, inputId, resultsId, onSelect) {
  const form = document.getElementById(formId);
  const input = document.getElementById(inputId);
  const results = document.getElementById(resultsId);

  form.addEventListener('submit', async function(event) {
    event.preventDefault();
    const query = input.value.trim();

    if (query.length < 2) {
      showSearchMessage(results, 'Enter at least two characters to search.');
      return;
    }

    showSearchMessage(results, 'Searching Open-Meteo locations…');
    const submitButton = form.querySelector('button[type="submit"]');
    const oldButtonText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Searching';

    try {
      const locations = await searchLocations(query);
      renderLocationOptions(results, locations, function(place) {
        input.value = place.name;
        onSelect(place);
      });
    } catch (error) {
      showSearchMessage(results, error.message || 'Search failed. Please try again.');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = oldButtonText;
    }
  });

  input.addEventListener('input', function() {
    results.innerHTML = '';
  });
}

function showHomeStatus(message, isError, showRetry) {
  const status = document.getElementById('home-status');
  status.hidden = false;
  if (isError) {
    status.classList.add('error');
  } else {
    status.classList.remove('error');
  }
  status.textContent = message;

  if (showRetry) {
    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.textContent = 'Try again';
    retryButton.addEventListener('click', function() {
      if (currentPlace) selectHomeLocation(currentPlace);
      else loadDefaultLocation();
    });
    status.appendChild(document.createTextNode(' '));
    status.appendChild(retryButton);
  }
}

async function selectHomeLocation(place) {
  currentPlace = place;
  currentForecast = null;
  document.getElementById('weather-dashboard').hidden = true;
  showHomeStatus('Loading forecast for ' + place.name + '…', false, false);
  renderPreparedness();

  try {
    currentForecast = await getForecast(place);
    document.getElementById('home-status').hidden = true;
    updateHomeDashboard();
    renderPreparedness();
  } catch (error) {
    showHomeStatus(error.message || 'Could not load the forecast.', true, true);
  }
}

function updateHomeDashboard() {
  if (!currentPlace || !currentForecast) return;

  const forecast = currentForecast;
  const current = forecast.current || {};
  const advice = getAdvice(forecast);
  const date = current.time ? current.time.slice(0, 10) : null;
  const dailyIndex = getDailyIndex(forecast, date);
  const high = (forecast.daily && forecast.daily.temperature_2m_max) ? forecast.daily.temperature_2m_max[dailyIndex] : undefined;
  const low = (forecast.daily && forecast.daily.temperature_2m_min) ? forecast.daily.temperature_2m_min[dailyIndex] : undefined;
  const rainNow = getRainNow(forecast);

  document.getElementById('weather-dashboard').hidden = false;
  document.getElementById('current-place').textContent = placeName(currentPlace);
  document.getElementById('current-date').textContent = formatForecastDate(current.time);
  document.getElementById('current-symbol').textContent = weatherIcon(current.weather_code);
  document.getElementById('current-temperature').textContent = formatValue(current.temperature_2m);
  document.getElementById('current-condition').textContent = conditionDescription(current.weather_code);
  document.getElementById('feels-like').textContent = formatValue(current.apparent_temperature);
  document.getElementById('today-high').textContent = formatValue(high, '°');
  document.getElementById('today-low').textContent = formatValue(low, '°');
  document.getElementById('metric-rain').textContent = formatValue(rainNow, '%');
  document.getElementById('metric-wind').textContent = formatValue(current.wind_speed_10m, ' km/h');
  document.getElementById('metric-humidity').textContent = formatValue(current.relative_humidity_2m, '%');
  document.getElementById('metric-uv').textContent = Number.isFinite(advice.uv) ? advice.uv.toFixed(1) : 'Unavailable';
  document.getElementById('rain-summary').textContent = advice.rain;
  document.getElementById('range-low').textContent = formatValue(low, '°');
  document.getElementById('range-high').textContent = formatValue(high, '°');

  const hourlyStrip = document.getElementById('hourly-strip');
  if (!advice.rows.length) {
    hourlyStrip.innerHTML = '<div class="empty-inline">No school-hour data was returned. Current conditions remain available above.</div>';
  } else {
    hourlyStrip.innerHTML = advice.rows.map(function(row) {
      return '<article class="hour-card ' + (row.past ? 'past' : '') + '">' +
        '<span class="hour-time">' + formatHour(row.hour) + '</span>' +
        '<span class="hour-icon">' + weatherIcon(row.code) + '</span>' +
        '<strong>' + formatValue(row.temperature, '°') + '</strong>' +
        '<span class="hour-rain">☂ ' + formatValue(row.rain, '%') + '</span>' +
      '</article>';
    }).join('');
  }
}

function renderPreparedness() {
  const locationElement = document.getElementById('prep-location');
  const dateElement = document.getElementById('prep-date');
  const noteElement = document.getElementById('prep-note');

  if (!currentPlace) {
    locationElement.textContent = 'Choose a location for today’s advice';
    dateElement.textContent = 'Waiting for a live forecast';
    noteElement.textContent = '';
    noteElement.hidden = true;
    return;
  }

  locationElement.textContent = placeName(currentPlace);

  if (!currentForecast) {
    dateElement.textContent = 'Loading a live forecast…';
    noteElement.textContent = '';
    noteElement.hidden = true;
    return;
  }

  let dateText = formatForecastDate(currentForecast.current ? currentForecast.current.time : null);
  if (currentForecast.timezone) {
    dateText += ' · ' + currentForecast.timezone.replace(/_/g, ' ');
  }
  dateElement.textContent = dateText;

  const advice = getAdvice(currentForecast);
  document.getElementById('prep-rain').textContent = advice.rain;
  document.getElementById('prep-clothing').textContent = advice.clothing;
  document.getElementById('prep-heat').textContent = advice.heat;
  document.getElementById('prep-outdoor').textContent = advice.outdoor;
  document.getElementById('prep-rain-value').textContent = Number.isFinite(advice.maxRain) ? Math.round(advice.maxRain) + '%' : 'Unavailable';
  document.getElementById('prep-heat-value').textContent = Number.isFinite(advice.maxFeels) ? Math.round(advice.maxFeels) + '°C' : 'Unavailable';

  noteElement.textContent = advice.dataCount < 3 ? 'Some forecast details are unavailable.' : '';
  noteElement.hidden = advice.dataCount >= 3;
}

function renderCommuteSide(side) {
  const state = commuteState[side];
  const weatherElement = document.getElementById(side + '-weather');
  const adviceElement = document.getElementById(side + '-advice');

  if (!state.place) {
    document.getElementById('comparison-callout').hidden = !(commuteState.origin.forecast && commuteState.destination.forecast);
    weatherElement.innerHTML = '<p class="mini-state">Search for a ' + (side === 'origin' ? 'starting point' : 'destination') + '.</p>';
    adviceElement.innerHTML = '<p class="mini-state">Weather tips will appear here.</p>';
    return;
  }

  if (state.loading) {
    document.getElementById('comparison-callout').hidden = true;
    weatherElement.innerHTML = '<p class="mini-state">Loading local weather…</p>';
    adviceElement.innerHTML = '<p class="mini-state">Loading weather tips…</p>';
    return;
  }

  if (state.error || !state.forecast) {
    document.getElementById('comparison-callout').hidden = true;
    const message = state.error || 'Could not load the forecast.';
    weatherElement.innerHTML = '<p class="mini-state mini-error">' + escapeHtml(message) + '</p><button class="text-link" type="button" data-retry-side="' + side + '">Try again →</button>';
    weatherElement.querySelector('[data-retry-side]').addEventListener('click', function() { selectCommuteLocation(side, state.place); });
    adviceElement.innerHTML = '<p class="mini-state">Weather tips are unavailable.</p>';
    return;
  }

  const forecast = state.forecast;
  const current = forecast.current || {};
  const rain = getRainNow(forecast);
  const advice = getAdvice(forecast);

  weatherElement.innerHTML =
    '<div class="mini-weather-card">' +
      '<div class="mini-weather-top"><div><p>' + escapeHtml(placeName(state.place)) + '</p><div class="mini-temperature">' + formatValue(current.temperature_2m, '°') + '</div><p class="mini-condition">' + escapeHtml(conditionDescription(current.weather_code)) + '</p></div><span class="mini-icon">' + weatherIcon(current.weather_code) + '</span></div>' +
      '<div class="mini-details"><span>Feels ' + formatValue(current.apparent_temperature, '°C') + '</span><span>Rain ' + formatValue(rain, '%') + '</span><span>Wind ' + formatValue(current.wind_speed_10m, ' km/h') + '</span></div>' +
    '</div>';

  adviceElement.innerHTML =
    '<h3>' + escapeHtml(state.place.name) + '</h3>' +
    '<p class="advice-lead">' + escapeHtml(advice.rain) + '</p>' +
    '<ul><li>' + escapeHtml(advice.clothing) + '</li><li>' + escapeHtml(advice.heat) + '</li><li>' + escapeHtml(advice.outdoor) + '</li></ul>';

  const originReady = Boolean(commuteState.origin.forecast);
  const destinationReady = Boolean(commuteState.destination.forecast);
  document.getElementById('comparison-callout').hidden = !(originReady && destinationReady);
}

async function selectCommuteLocation(side, place) {
  commuteState[side] = { place: place, forecast: null, loading: true, error: null };
  renderCommuteSide(side);

  try {
    commuteState[side].forecast = await getForecast(place);
    commuteState[side].loading = false;
    commuteState[side].error = null;
  } catch (error) {
    commuteState[side].loading = false;
    commuteState[side].error = error.message || 'Could not load the forecast.';
  }
  renderCommuteSide(side);
}

function setPage(page) {
  const sections = document.querySelectorAll('.page-section');
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const active = section.id === 'page-' + page;
    section.hidden = !active;
    if (active) {
      section.classList.add('active');
    } else {
      section.classList.remove('active');
    }
  }

  const navItems = document.querySelectorAll('.nav-item[data-page]');
  for (let i = 0; i < navItems.length; i++) {
    const button = navItems[i];
    if (button.dataset.page === page) {
      button.classList.add('active');
    } else {
      button.classList.remove('active');
    }
  }

  document.getElementById('breadcrumb').innerHTML = 'CampusCast <span>/</span> ' + (pageTitles[page] || 'Today');
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('menu-button').setAttribute('aria-expanded', 'false');
  document.getElementById('menu-button').setAttribute('aria-label', 'Open navigation');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadDefaultLocation() {
  document.getElementById('home-search-input').value = 'General Trias';
  showHomeStatus('Looking up the default location…', false, false);
  try {
    const locations = await searchLocations('General Trias');
    if (!locations.length) throw new Error('General Trias was not found. Search for a location to get a live forecast.');
    await selectHomeLocation(locations[0]);
  } catch (error) {
    showHomeStatus(error.message || 'Could not look up the default location. Search for a location to retry.', true, true);
  }
}

const pageButtons = document.querySelectorAll('[data-page]');
for (let i = 0; i < pageButtons.length; i++) {
  pageButtons[i].addEventListener('click', function() {
    setPage(this.dataset.page);
  });
}

const pageLinks = document.querySelectorAll('[data-page-link]');
for (let i = 0; i < pageLinks.length; i++) {
  pageLinks[i].addEventListener('click', function(event) {
    event.preventDefault();
    setPage(this.dataset.pageLink);
  });
}

document.getElementById('menu-button').addEventListener('click', function() {
  const sidebar = document.getElementById('sidebar');
  const isOpen = sidebar.classList.toggle('open');
  document.getElementById('menu-button').setAttribute('aria-expanded', String(isOpen));
  document.getElementById('menu-button').setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
});

setupLocationSearch('home-search-form', 'home-search-input', 'home-search-results', selectHomeLocation);
setupLocationSearch('prep-search-form', 'prep-search-input', 'prep-search-results', selectHomeLocation);
setupLocationSearch('origin-search-form', 'origin-search-input', 'origin-search-results', function(place) { selectCommuteLocation('origin', place); });
setupLocationSearch('destination-search-form', 'destination-search-input', 'destination-search-results', function(place) { selectCommuteLocation('destination', place); });

loadDefaultLocation();
