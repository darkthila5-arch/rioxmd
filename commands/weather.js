// .weather <city>   (alias .wx)   Current weather + 3 day forecast.
// Uses Open-Meteo (https://open-meteo.com): free, no API key. City names are looked up with their geocoding API.
import { PREFIX } from '../lib/config.js';

const TIMEOUT_MS = 12000;
const COOLDOWN_MS = 4000;
const lastUse = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of lastUse) if (t - v > 60e3) lastUse.delete(k); }, 5 * 60e3).unref();

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// WMO weather codes -> [emoji, text]
export const WMO = {
  0: ['☀️', 'Clear sky'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Freezing fog'],
  51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
  56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
  61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
  66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
  71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
  80: ['🌦️', 'Light showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Violent showers'],
  85: ['🌨️', 'Snow showers'], 86: ['🌨️', 'Heavy snow showers'],
  95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm with hail'], 99: ['⛈️', 'Thunderstorm with hail']
};
export const wmo = (code) => WMO[code] || ['🌡️', 'Unknown'];
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v).toFixed(d) : '-');

// Pure formatter (tested without network).
export function weatherText(place, data) {
  const c = data?.current || {}, d = data?.daily || {};
  const [icon, label] = wmo(c.weather_code);
  const where = [place.name, place.admin1 && place.admin1 !== place.name ? place.admin1 : null, place.country].filter(Boolean).join(', ');
  const lines = [
    `${icon} *Weather in ${where}*`,
    '',
    `🌡️ Now: *${num(c.temperature_2m, 1)}°C* (feels ${num(c.apparent_temperature, 1)}°C)`,
    `📝 ${label}`,
    `💧 Humidity: ${num(c.relative_humidity_2m)}%`,
    `💨 Wind: ${num(c.wind_speed_10m)} km/h`,
    `🌧️ Rain now: ${num(c.precipitation, 1)} mm`
  ];
  const days = d.time || [];
  if (days.length) {
    lines.push('', '*Next days*');
    days.slice(0, 3).forEach((day, i) => {
      const [ic] = wmo(d.weather_code?.[i]);
      const name = i === 0 ? 'Today' : new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
      lines.push(`${ic} ${name}: ${num(d.temperature_2m_min?.[i])}° - ${num(d.temperature_2m_max?.[i])}°C, rain ${num(d.precipitation_probability_max?.[i])}%`);
    });
  }
  return lines.join('\n');
}

export async function lookupWeather(query) {
  const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`);
  const place = geo?.results?.[0];
  if (!place) return null;
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${place.latitude}&longitude=${place.longitude}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&timezone=auto&forecast_days=3';
  const data = await getJson(url);
  return { place, text: weatherText(place, data) };
}

export default [
  {
    name: 'weather', aliases: ['wx', 'forecast'], react: '🌤️',
    async run({ args, reply, sessionId, jid }) {
      const query = args.join(' ').trim().slice(0, 80);
      if (!query) return reply(`🌤️ *Weather*\n\nUsage: ${PREFIX}weather <city>\nExample: ${PREFIX}weather Colombo`);
      const key = `${sessionId}:${jid}`;
      if (Date.now() - (lastUse.get(key) || 0) < COOLDOWN_MS) return reply('⏳ Wait a few seconds and try again.');
      lastUse.set(key, Date.now());
      try {
        const found = await lookupWeather(query);
        if (!found) return reply(`❌ I could not find a place called *${query}*. Try the English name, for example ${PREFIX}weather Kandy`);
        return reply(found.text);
      } catch (err) {
        console.error('weather error:', err?.message || err);
        return reply('❌ Could not get the weather right now. Try again in a minute.');
      }
    }
  }
];
