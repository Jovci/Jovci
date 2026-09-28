// Renders a GitHub-contribution-style grid of run days from Strava, with run streak and monthly mileage.
// Env: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN
// Optional: STRAVA_UNITS (mi|km, default mi), STRAVA_WEEKS (default 53), STRAVA_INCLUDE_PRIVATE (true|false, default true)
import { mkdir, writeFile } from 'node:fs/promises';

const RUN_TYPES = ['Run', 'TrailRun', 'VirtualRun'];
const UNITS = process.env.STRAVA_UNITS === 'km' ? 'km' : 'mi';
const PER_UNIT = UNITS === 'km' ? 1000 : 1609.344;
const WEEKS = Number(process.env.STRAVA_WEEKS) || 53;
const INCLUDE_PRIVATE = process.env.STRAVA_INCLUDE_PRIVATE !== 'false';
const OUT_DIR = new URL('../assets/', import.meta.url);

const THEMES = {
  light: { text: '#57606a', value: '#1f2328', ran: '#2da44e', missed: '#d0d7de' },
  dark: { text: '#8b949e', value: '#e6edf3', ran: '#34c759', missed: '#30363d' },
};

const dateKey = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

async function accessToken() {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.refresh_token && body.refresh_token !== process.env.STRAVA_REFRESH_TOKEN) {
    console.warn('::warning::Strava rotated the refresh token. Update the STRAVA_REFRESH_TOKEN secret.');
  }
  return body.access_token;
}

async function activities(token, after) {
  const all = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Activity fetch failed: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 200) return all;
  }
}

// Meters per local day. start_date_local is local wall-clock time labelled Z, so its date part is the local day.
function totals(list) {
  const out = {};
  for (const a of list) {
    if (!RUN_TYPES.includes(a.sport_type || a.type)) continue;
    if (a.private && !INCLUDE_PRIVATE) continue;
    const key = a.start_date_local.slice(0, 10);
    out[key] = (out[key] || 0) + a.distance;
  }
  return out;
}

// Columns are weeks (Sun-Sat, like GitHub), ending with the current week.
function grid(today) {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - end.getUTCDay() - (WEEKS - 1) * 7);
  const weeks = [];
  for (let w = 0; w < WEEKS; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const x = new Date(start);
      x.setUTCDate(x.getUTCDate() + w * 7 + d);
      days.push(x > end ? null : x);
    }
    weeks.push(days);
  }
  return { start, weeks };
}

const fmt = n => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));

// Consecutive run days ending today, or yesterday if today has no run yet.
function streak(byDay, today) {
  const d = new Date(today);
  if (!byDay[dateKey(d)]) d.setUTCDate(d.getUTCDate() - 1);
  let n = 0;
  while (byDay[dateKey(d)]) { n++; d.setUTCDate(d.getUTCDate() - 1); }
  return n;
}

function monthTotal(byDay, today) {
  const prefix = dateKey(today).slice(0, 7);
  let m = 0;
  for (const [key, meters] of Object.entries(byDay)) if (key.startsWith(prefix)) m += meters;
  return m / PER_UNIT;
}

function render(theme, { weeks }, byDay, today) {
  const t = THEMES[theme];
  const step = 13, r = 4.5;
  const left = 30, top = 76;
  const width = left + WEEKS * step + 10;
  const height = top + 7 * step + 22;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const todayKey = dateKey(today);
  const parts = [];
  let lastMonth = -1;

  const days = streak(byDay, today);
  const stats = [
    [`${days}`, `day run streak`],
    [`${fmt(monthTotal(byDay, today))} ${UNITS}`, `in ${months[today.getUTCMonth()]}`],
  ];
  stats.forEach(([value, label], i) => {
    const x = left + i * 170;
    parts.push(`<text x="${x}" y="34" font-size="26" font-weight="700" fill="${t.value}">${value}</text>`);
    parts.push(`<text x="${x}" y="50" font-size="11">${label}</text>`);
  });

  weeks.forEach((col, w) => {
    const first = col[0];
    if (first && first.getUTCMonth() !== lastMonth && first.getUTCDate() <= 7) {
      lastMonth = first.getUTCMonth();
      if (w < WEEKS - 2) parts.push(`<text x="${left + w * step}" y="${top - 6}">${months[lastMonth]}</text>`);
    }
    col.forEach((day, d) => {
      if (!day) return;
      const key = dateKey(day);
      const cx = left + w * step + r, cy = top + d * step + r;
      const units = (byDay[key] || 0) / PER_UNIT;
      const label = units > 0 ? `${fmt(units)} ${UNITS} on ${key}` : `No run on ${key}`;
      const shape = units > 0
        ? `fill="${t.ran}"`
        : key === todayKey
          ? `fill="none" stroke="${t.value}" stroke-width="1.5"`
          : `fill="none" stroke="${t.missed}" stroke-width="1.2"`;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" ${shape}><title>${label}</title></circle>`);
    });
  });

  for (const [d, name] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    parts.push(`<text x="0" y="${top + d * step + 8}">${name}</text>`);
  }
  parts.push(`<text x="${width - 10}" y="${height - 4}" text-anchor="end" font-size="8">updated ${todayKey}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="9" fill="${t.text}">
${parts.join('\n')}
</svg>
`;
}

const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
const layout = grid(today);
const after = Math.floor(layout.start.getTime() / 1000) - 86400;
const byDay = totals(await activities(await accessToken(), after));

await mkdir(OUT_DIR, { recursive: true });
for (const theme of Object.keys(THEMES)) {
  await writeFile(new URL(`strava-graph-${theme}.svg`, OUT_DIR), render(theme, layout, byDay, today));
}
console.log(`Rendered ${Object.keys(byDay).length} run days.`);
