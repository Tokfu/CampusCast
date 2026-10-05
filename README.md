# CampusCast

A student-centered weather and daily preparedness web app (Laboratory Activity 2: first working part).

## Run it
No build step. Open `index.html` in a browser, or use the VS Code **Live Server** extension.
Internet access is required (Bootstrap CDN + Open-Meteo APIs).

## APIs and access method
| API | Endpoint | Purpose |
|---|---|---|
| Open-Meteo Geocoding | `GET https://geocoding-api.open-meteo.com/v1/search?name=...&count=5` | Place name → latitude/longitude |
| Open-Meteo Forecast | `GET https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=..&hourly=..&daily=..&timezone=auto&forecast_days=2` | Current + hourly + daily weather |

## Access method (Requirement 3)

**Access method: public access.** Open-Meteo's standard endpoints are free for non-commercial use and
need no API key, bearer token, or OAuth ([terms](https://open-meteo.com/en/terms)).

| Item | How CampusCast applies it |
|---|---|
| Authentication | None. No API key, bearer token, or OAuth flow exists in the app |
| Request | `GET` with `Accept: application/json`, `credentials: "omit"`, no `Authorization` header (`buildRequestOptions()` in `app.js`) |
| Third-party sign-in | Not used. The app has no user accounts, so a sign-in is not necessary |
| Secrets | None exist, so none are in the source code, repository, or screenshots |
| Usage limits | Free tier: under 10,000 calls/day, 5,000/hour, 600/minute. Handled by a 10-minute cache and an HTTP 429 cooldown |
| Terms | Non-commercial use only (no ads or subscriptions). This is a school project |
| License | Data is CC BY 4.0. Attribution to Open-Meteo is shown in the footer |

The same details appear in the app under **About & API → API access method**, generated from the
`ACCESS_METHOD` constant in `app.js`.

Response fields used: `results[].name/admin1/country/latitude/longitude`; `current.temperature_2m`,
`relative_humidity_2m`, `apparent_temperature`, `weather_code`, `wind_speed_10m`, `is_day`, `precipitation`;
`hourly.precipitation_probability`, `apparent_temperature`, `temperature_2m`, `weather_code`, `wind_speed_10m`;
`daily.temperature_2m_max/min`, `uv_index_max`.

## Request handling
- Loading spinner while requests run
- 10-second timeout, offline detection, server (5xx) and bad-request (400) messages
- HTTP 429 (rate limit): clear message, search paused with a countdown on the Retry button
- "Location not found" message for unknown places; input validation on the search box
- 10-minute in-memory cache to reduce repeated requests

## Recommendation rules (student readiness)
Evaluated over the remaining school hours (6 AM–6 PM, local time; after 6 PM it shows tomorrow).

| Item | Rule |
|---|---|
| Umbrella | rain chance ≥ 60% recommended, 30–59% optional, thunderstorm = required |
| Heat (feels-like) | ≥ 42 °C danger, ≥ 33 °C extreme caution, ≥ 28 °C bring water |
| Outdoor activity | per-activity thresholds for rain, heat, wind, UV (see `ACTIVITIES` in `app.js`) |
| Overall | score from rain + heat + wind: 0–1 Good, 2–4 Moderate, 5+ Needs Extra Prep |

Heat bands follow PAGASA heat-index categories, applied to the feels-like temperature as an approximation.

## Completed features
Responsive dashboard, navigation, location search (geocoding), student readiness, outdoor activity advisor,
hourly school-day forecast, live API inspector.

## Limitations / next tasks
- Celsius and km/h only
- No saved locations or favorites yet
- Heat index is approximated from feels-like temperature
- Next: save favorite locations, weekly outlook, PAGASA advisory link, automated tests

Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).
