// =============================================================  (v1.2)
//  吃什麼 Food Finder — 後端（Cloudflare Worker）
//  作用：藏住 API 金鑰、快取結果、每日次數上限（確保不超過免費額度）
//
//  需要的設定（Cloudflare 後台 → Worker → Settings）：
//    Secret  GOOGLE_KEY      Google Places API (New) 金鑰
//    Secret  ORS_KEY         OpenRouteService 金鑰
//    Text    ALLOWED_ORIGIN  前端網址，例如 https://你的帳號.github.io（可留空 = 全開）
//    KV 綁定 KV              一個 KV namespace（快取與計數用）
// =============================================================

const DAILY_SEARCH_LIMIT = 30;   // 每天最多打幾次 Google 搜尋
const DAILY_DETAIL_LIMIT = 30;   // 每天最多打幾次 Google 店家詳細資訊
const PLACE_CACHE_TTL = 7 * 24 * 3600;   // 店家資料快取 7 天
const ISO_CACHE_TTL = 30 * 24 * 3600;    // 可到達範圍快取 30 天
const GEO_CACHE_TTL = 365 * 24 * 3600;   // 地址轉座標快取 1 年

// 搜尋要抓的店家類型
const FOOD_TYPES = ['restaurant', 'meal_takeaway', 'cafe', 'bakery'];

// 列表需要的欄位（欄位越少越省，評分與營業時間屬於 Enterprise 級，每月免費 1,000 次）
const NEARBY_FIELDS = [
  'places.id', 'places.displayName', 'places.location',
  'places.primaryType', 'places.primaryTypeDisplayName', 'places.types',
  'places.rating', 'places.userRatingCount', 'places.priceLevel',
  'places.regularOpeningHours', 'places.shortFormattedAddress',
  'places.googleMapsUri', 'places.businessStatus',
].join(',');

const DETAIL_FIELDS = [
  'id', 'displayName', 'location', 'primaryTypeDisplayName',
  'formattedAddress', 'nationalPhoneNumber', 'websiteUri', 'googleMapsUri',
  'rating', 'userRatingCount', 'priceLevel', 'regularOpeningHours', 'reviews',
].join(',');

// 交通方式 → ORS 路線設定。機車不走國道（avoid highways）
const PROFILES = {
  scooter: { profile: 'driving-car', options: { avoid_features: ['highways'] } },
  car:     { profile: 'driving-car' },
  bike:    { profile: 'cycling-regular' },
  walk:    { profile: 'foot-walking' },
};

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    try {
      let result;
      switch (url.pathname) {
        case '/usage':     result = await usage(env); break;
        case '/geocode':   result = await geocode(await req.json(), env); break;
        case '/isochrone': result = await isochrone(await req.json(), env); break;
        case '/nearby':    result = await nearby(await req.json(), env); break;
        case '/text':      result = await textSearch(await req.json(), env); break;
        case '/details':   result = await details(url.searchParams.get('id'), env); break;
        default: return json({ error: '找不到這個功能' }, 404, cors);
      }
      return json(result, 200, cors);
    } catch (e) {
      return json({ error: e.message || String(e), code: e.code || 'ERROR' }, e.status || 500, cors);
    }
  },
};

// ---------- 各功能 ----------

async function usage(env) {
  const date = taipeiDate();
  const s = parseInt(await env.KV.get(`quota:search:${date}`) || '0', 10);
  const d = parseInt(await env.KV.get(`quota:detail:${date}`) || '0', 10);
  return {
    search: { used: s, limit: DAILY_SEARCH_LIMIT },
    detail: { used: d, limit: DAILY_DETAIL_LIMIT },
  };
}

// 地址 → 座標（用 Places 文字搜尋，算在搜尋次數內，結果快取一年）
async function geocode({ text }, env) {
  if (!text) throw httpError(400, '請輸入地址');
  const key = `geo:${text.trim()}`;
  const hit = await env.KV.get(key, 'json');
  if (hit) return hit;

  const commit = await takeQuota(env, 'search', DAILY_SEARCH_LIMIT);
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: googleHeaders(env, 'places.location,places.formattedAddress'),
    body: JSON.stringify({ textQuery: text, languageCode: 'zh-TW', regionCode: 'TW', pageSize: 1 }),
  });
  const data = await googleJson(r);
  await commit();
  const p = data.places && data.places[0];
  if (!p) throw httpError(404, '找不到這個地址，請換個寫法試試');
  const out = { lat: p.location.latitude, lng: p.location.longitude, address: p.formattedAddress };
  await env.KV.put(key, JSON.stringify(out), { expirationTtl: GEO_CACHE_TTL });
  return out;
}

// 可到達範圍（等時圈）
async function isochrone({ lat, lng, mode = 'scooter', minutes = 15 }, env) {
  const cfg = PROFILES[mode];
  if (!cfg) throw httpError(400, '不支援的交通方式');
  minutes = Math.max(1, Math.min(60, Math.round(minutes)));
  const key = `iso:${mode}:${minutes}:${round(lat)}:${round(lng)}`;
  const hit = await env.KV.get(key, 'json');
  if (hit) return { ...hit, cached: true };

  const body = { locations: [[lng, lat]], range: [minutes * 60], range_type: 'time', smoothing: 15 };
  if (cfg.options) body.options = cfg.options;
  const r = await fetch(`https://api.openrouteservice.org/v2/isochrones/${cfg.profile}`, {
    method: 'POST',
    headers: { 'Authorization': env.ORS_KEY, 'Content-Type': 'application/json',
               'Accept': 'application/geo+json, application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw httpError(502, `範圍計算失敗（OpenRouteService ${r.status}）：${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const geometry = data.features && data.features[0] && data.features[0].geometry;
  if (!geometry) throw httpError(502, '範圍計算沒有回傳結果');
  const out = { geometry };
  await env.KV.put(key, JSON.stringify(out), { expirationTtl: ISO_CACHE_TTL });
  return out;
}

// 搜尋一個圓形區域內的店家（最多 20 筆）
async function nearby({ lat, lng, radius }, env) {
  radius = Math.max(200, Math.min(50000, Math.round(radius)));
  const key = `nb:${round(lat)}:${round(lng)}:${Math.round(radius / 100) * 100}`;
  const hit = await env.KV.get(key, 'json');
  if (hit) return { places: hit, cached: true };

  const commit = await takeQuota(env, 'search', DAILY_SEARCH_LIMIT);
  const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: googleHeaders(env, NEARBY_FIELDS),
    body: JSON.stringify({
      includedTypes: FOOD_TYPES,
      maxResultCount: 20,
      rankPreference: 'POPULARITY',
      languageCode: 'zh-TW',
      regionCode: 'TW',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
    }),
  });
  const data = await googleJson(r);
  await commit();
  const places = data.places || [];
  await env.KV.put(key, JSON.stringify(places), { expirationTtl: PLACE_CACHE_TTL });
  return { places, cached: false };
}

// 依關鍵字搜尋一個區域內的店家（種類篩選用，例如「日式 飯」）
async function textSearch({ query, lat, lng, radius }, env) {
  query = String(query || '').trim().slice(0, 40);
  if (!query) throw httpError(400, '缺少搜尋關鍵字');
  radius = Math.max(200, Math.min(50000, Math.round(radius)));
  const key = `tx:${query}:${round(lat)}:${round(lng)}:${Math.round(radius / 100) * 100}`;
  const hit = await env.KV.get(key, 'json');
  if (hit) return { places: hit, cached: true };

  const commit = await takeQuota(env, 'search', DAILY_SEARCH_LIMIT);
  const dLat = radius / 111320, dLng = radius / (111320 * Math.cos(lat * Math.PI / 180));
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: googleHeaders(env, NEARBY_FIELDS),
    body: JSON.stringify({
      textQuery: query,
      pageSize: 20,
      languageCode: 'zh-TW',
      regionCode: 'TW',
      locationRestriction: { rectangle: {
        low:  { latitude: lat - dLat, longitude: lng - dLng },
        high: { latitude: lat + dLat, longitude: lng + dLng },
      } },
    }),
  });
  const data = await googleJson(r);
  await commit();
  const places = data.places || [];
  await env.KV.put(key, JSON.stringify(places), { expirationTtl: PLACE_CACHE_TTL });
  return { places, cached: false };
}

// 單一店家詳細資訊（含評論）
async function details(id, env) {
  if (!id || !/^[\w-]+$/.test(id)) throw httpError(400, '店家編號錯誤');
  const key = `det:${id}`;
  const hit = await env.KV.get(key, 'json');
  if (hit) return { ...hit, cached: true };

  const commit = await takeQuota(env, 'detail', DAILY_DETAIL_LIMIT);
  const r = await fetch(`https://places.googleapis.com/v1/places/${id}?languageCode=zh-TW&regionCode=TW`, {
    headers: googleHeaders(env, DETAIL_FIELDS),
  });
  const data = await googleJson(r);
  await commit();
  await env.KV.put(key, JSON.stringify(data), { expirationTtl: PLACE_CACHE_TTL });
  return data;
}

// ---------- 工具 ----------

// 先檢查是否還有次數；Google 呼叫成功後才扣次數（失敗的呼叫 Google 不收費）
async function takeQuota(env, kind, limit) {
  const key = `quota:${kind}:${taipeiDate()}`;
  const used = parseInt(await env.KV.get(key) || '0', 10);
  if (used >= limit) {
    const label = kind === 'search' ? '搜尋' : '店家詳細資訊';
    throw httpError(429, `今天的${label}次數已用完（${limit} 次），明天再試。已查過的區域仍可使用。`, 'QUOTA');
  }
  return () => env.KV.put(key, String(used + 1), { expirationTtl: 3 * 24 * 3600 });
}

function googleHeaders(env, fieldMask) {
  return { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_KEY, 'X-Goog-FieldMask': fieldMask };
}

async function googleJson(r) {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = data.error || {};
    const reasons = (err.details || []).map(d => d.reason).filter(Boolean);
    const msg = err.message || `HTTP ${r.status}`;
    const tag = [err.status, ...reasons].filter(Boolean).join(' / ');
    throw httpError(502, `Google 回傳錯誤：${msg}${tag ? `（${tag}）` : ''}`);
  }
  return data;
}

function taipeiDate() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

function round(n) { return Number(n).toFixed(3); }

function httpError(status, message, code) {
  const e = new Error(message); e.status = status; e.code = code; return e;
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes('*') ? '*'
    : (allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) ? origin
    : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
