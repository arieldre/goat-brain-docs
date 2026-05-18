const FB_BASE = 'https://graph.facebook.com/v21.0';

export const ACCOUNTS = {
  inv:     { account: 'act_1121972276790088', token: () => process.env.INV_FB_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN },
  inv_old: { account: 'act_798330533329649',  token: () => process.env.INV_FB_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN },
  uh:      { account: 'act_816445786671331',  token: () => process.env.FB_ACCESS_TOKEN },
};

export function getCreds(game) {
  const creds = ACCOUNTS[game];
  if (!creds) throw new Error(`Unknown game: ${game}. Valid: ${Object.keys(ACCOUNTS).join(', ')}`);
  const token = creds.token();
  if (!token) throw new Error(`No FB token for game=${game}. Set FB_ACCESS_TOKEN or INV_FB_ACCESS_TOKEN in .env`);
  return { token, account: creds.account };
}

export async function fbGetAll(token, urlPath, params = {}) {
  const items = [];
  const qs = new URLSearchParams({ limit: '500', ...params }); // token via header, not URL param
  let url = `${FB_BASE}/${urlPath}?${qs}`;
  const hdrs = { 'Authorization': `Bearer ${token}` };
  while (url) {
    const res  = await fetch(url, { headers: hdrs });
    const data = await res.json();
    if (data.error) throw new Error(`FB API: ${data.error.message} (code=${data.error.code})`);
    if (!Array.isArray(data.data)) throw new Error(`FB API: unexpected response shape, keys=${Object.keys(data).join(',')}`);
    items.push(...data.data);
    // Strip access_token from paging.next — token travels via header only
    const next = data.paging?.next;
    if (next) { const u = new URL(next); u.searchParams.delete('access_token'); url = u.toString(); }
    else url = null;
  }
  return items;
}

export function adBaseName(n) {
  return n
    .replace(/\.mp4$/i, '')
    .replace(/_(1080x1920|1920x1080|1080x1080)$/gi, '')
    .replace(/_[A-Z0-9]{6,12}(-[A-Za-z0-9]+){2,}$/gi, '')
    .replace(/_+$/g, '').trim();
}

export function adPlatform(campaignName = '') {
  if (/_iOS_/i.test(campaignName))          return 'iOS';
  if (/_(GP|Android)_/i.test(campaignName)) return 'Android';
  return 'All';
}

export function adObjective(campaignName = '') {
  if (/_AEO_Purchase/i.test(campaignName) || /_AEO_/i.test(campaignName)) return 'AEO';
  if (/_MAI_Install/i.test(campaignName)  || /_MAI_/i.test(campaignName) || /_Install_/i.test(campaignName)) return 'MAI';
  return 'Other';
}

export function adInstalls(ad) {
  const a = (ad.actions || []).find(a => a.action_type === 'mobile_app_install');
  return a ? parseFloat(a.value) : 0;
}

export function adRetention(ad) {
  const p25arr = ad.video_p25_watched_actions;
  if (!p25arr?.[0]) return null;
  const p25 = parseFloat(p25arr[0].value);
  if (p25 < 100) return null;
  const imp  = parseInt(ad.impressions);
  if (!imp || imp < 100) return null;
  const p75  = parseFloat(ad.video_p75_watched_actions?.[0]?.value  || 0);
  return {
    hookRate: p25 / imp,
    holdRate: p25 > 0 ? p75 / p25 : 0,
  };
}

export function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
