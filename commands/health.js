// .bmi 70 175            (aliases .bodymass)    weight in kg, height in cm
//   .bmi 70 1.75          height in metres also works      .bmi 154lb 5'9  is NOT supported (kg / cm only)
// .age 2000-05-17         (aliases .myage .dob)  age calculator
//   .age 17/05/2000       DD/MM/YYYY (day first)           .age 17 May 2000
// Pure maths, no network.
import { PREFIX, TIMEZONE } from '../lib/config.js';

/* ------------------------------- BMI ------------------------------- */
const BMI_USAGE = `⚖️ *BMI calculator*\n\n${PREFIX}bmi <kg> <cm>\n\nExample: ${PREFIX}bmi 70 175\n_(height in metres also works: ${PREFIX}bmi 70 1.75)_`;

export function parseBmi(args) {
  const nums = String(Array.isArray(args) ? args.join(' ') : args || '')
    .toLowerCase().replace(/,/g, '.').replace(/kg|cm|m\b/g, ' ').match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length !== 2) return null;
  const kg = Number(nums[0]);
  let cm = Number(nums[1]);
  if (cm > 0 && cm < 3) cm *= 100; // 1.75 -> 175 cm
  if (!(kg >= 2 && kg <= 500) || !(cm >= 50 && cm <= 272)) return null;
  return { kg, cm };
}

export function bmiCategory(bmi) {
  if (bmi < 16) return { label: 'Severe thinness', emoji: '🔴' };
  if (bmi < 17) return { label: 'Moderate thinness', emoji: '🟠' };
  if (bmi < 18.5) return { label: 'Mild thinness (Underweight)', emoji: '🟡' };
  if (bmi < 25) return { label: 'Normal weight', emoji: '🟢' };
  if (bmi < 30) return { label: 'Overweight', emoji: '🟡' };
  if (bmi < 35) return { label: 'Obese (Class I)', emoji: '🟠' };
  if (bmi < 40) return { label: 'Obese (Class II)', emoji: '🔴' };
  return { label: 'Obese (Class III)', emoji: '🔴' };
}

export function bmiText({ kg, cm }) {
  const m = cm / 100;
  const bmi = kg / (m * m);
  const cat = bmiCategory(bmi);
  const lo = 18.5 * m * m;
  const hi = 24.9 * m * m;
  const lines = [
    '⚖️ *BMI Result*', '',
    `👤 Weight: *${+kg.toFixed(1)} kg*`,
    `📏 Height: *${+cm.toFixed(1)} cm*`, '',
    `📊 BMI: *${bmi.toFixed(1)}*`,
    `${cat.emoji} Category: *${cat.label}*`, '',
    `✅ Healthy weight for your height: *${lo.toFixed(1)} – ${hi.toFixed(1)} kg*`
  ];
  if (kg < lo) lines.push(`⬆️ About *${(lo - kg).toFixed(1)} kg* below the healthy range.`);
  else if (kg > hi) lines.push(`⬇️ About *${(kg - hi).toFixed(1)} kg* above the healthy range.`);
  lines.push('', '_BMI is only a rough guide (not for children, athletes or pregnancy). Ask a doctor for real advice._');
  return lines.join('\n');
}

/* ------------------------------- AGE ------------------------------- */
const AGE_USAGE = `🎂 *Age calculator*\n\n${PREFIX}age <date of birth>\n\nExamples:\n${PREFIX}age 2000-05-17\n${PREFIX}age 17/05/2000  _(day / month / year)_\n${PREFIX}age 17 May 2000`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
const validDate = (y, m, d) => y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const dayNumber = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);

// "2000-05-17" / "17/05/2000" / "17.5.2000" / "17 May 2000" / "May 17 2000" -> { y, m, d } or null
export function parseDob(args) {
  const s = String(Array.isArray(args) ? args.join(' ') : args || '').toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let y; let m; let d; let r;
  if ((r = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { d = +r[1]; m = +r[2]; y = +r[3]; }
  else if ((r = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s*-?\s*([a-z]{3,9})\s*-?\s*(\d{4})$/))) { d = +r[1]; m = MONTHS.indexOf(r[2].slice(0, 3)) + 1; y = +r[3]; }
  else if ((r = s.match(/^([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/))) { m = MONTHS.indexOf(r[1].slice(0, 3)) + 1; d = +r[2]; y = +r[3]; }
  else return null;
  if (!validDate(y, m, d)) return null;
  return { y, m, d };
}

export function todayIn(tz = TIMEZONE, now = new Date()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day };
  } catch { return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() }; }
}

// Years / months / days between dob and today (dob must not be in the future).
export function calcAge(dob, today) {
  let total = (today.y - dob.y) * 12 + (today.m - dob.m);
  if (today.d < dob.d) total -= 1;
  // the date `total` months after the dob (day clamped to the month length, e.g. 31 Jan + 1 month = 28 Feb)
  const ay = dob.y + Math.floor((dob.m - 1 + total) / 12);
  const am = ((dob.m - 1 + total) % 12) + 1;
  const ad = Math.min(dob.d, daysIn(ay, am));
  return {
    years: Math.floor(total / 12), months: total % 12,
    days: dayNumber(today.y, today.m, today.d) - dayNumber(ay, am, ad),
    totalDays: dayNumber(today.y, today.m, today.d) - dayNumber(dob.y, dob.m, dob.d)
  };
}

// Days until the next birthday (0 = today). 29 Feb is celebrated on 28 Feb in non-leap years.
export function nextBirthday(dob, today) {
  const at = (y) => (dob.m === 2 && dob.d === 29 && daysIn(y, 2) === 28 ? { y, m: 2, d: 28 } : { y, m: dob.m, d: dob.d });
  let n = at(today.y);
  let diff = dayNumber(n.y, n.m, n.d) - dayNumber(today.y, today.m, today.d);
  if (diff < 0) { n = at(today.y + 1); diff = dayNumber(n.y, n.m, n.d) - dayNumber(today.y, today.m, today.d); }
  return { days: diff, turning: n.y - dob.y, date: n };
}

export function ageText(dob, today) {
  const dobNum = dayNumber(dob.y, dob.m, dob.d);
  const todayNum = dayNumber(today.y, today.m, today.d);
  const dobStr = `${pad(dob.d)} ${MONTH_NAMES[dob.m - 1]} ${dob.y}`;
  if (dobNum > todayNum) return `❌ *${dobStr}* is in the future. Check the date of birth.\n\n${AGE_USAGE}`;
  const a = calcAge(dob, today);
  const weekday = DAY_NAMES[new Date(Date.UTC(dob.y, dob.m - 1, dob.d)).getUTCDay()];
  const nb = nextBirthday(dob, today);
  const lines = [
    '🎂 *Age Calculator*', '',
    `📅 Born: *${dobStr}* _(${weekday})_`, '',
    `🧮 Age: *${a.years} years, ${a.months} months, ${a.days} days*`,
    `📆 Months lived: *${(a.years * 12 + a.months).toLocaleString('en-US')}*`,
    `🗓️ Weeks lived: *${Math.floor(a.totalDays / 7).toLocaleString('en-US')}*`,
    `☀️ Days lived: *${a.totalDays.toLocaleString('en-US')}*`,
    `⏳ Hours lived: *${(a.totalDays * 24).toLocaleString('en-US')}*`, ''
  ];
  if (nb.days === 0) lines.push(`🎉 *Happy Birthday!* You turn *${nb.turning}* today! 🥳`);
  else lines.push(`🎁 Next birthday (turning *${nb.turning}*): in *${nb.days} day${nb.days === 1 ? '' : 's'}* _(${pad(nb.date.d)} ${MONTH_NAMES[nb.date.m - 1]})_`);
  return lines.join('\n');
}

export default [
  {
    name: 'bmi', aliases: ['bodymass'], react: '⚖️',
    async run({ args, reply }) {
      const q = parseBmi(args);
      if (!q) return reply(args?.length ? `❌ Could not read that. Send weight in *kg* and height in *cm*.\n\n${BMI_USAGE}` : BMI_USAGE);
      return reply(bmiText(q));
    }
  },
  {
    name: 'age', aliases: ['myage', 'dob', 'agecalc'], react: '🎂',
    async run({ args, reply }) {
      const dob = parseDob(args);
      if (!dob) return reply(args?.length ? `❌ Could not read that date.\n\n${AGE_USAGE}` : AGE_USAGE);
      return reply(ageText(dob, todayIn()));
    }
  }
];
