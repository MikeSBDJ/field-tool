/*
 * Google Maps helper for the Field Tool.
 *
 * The Maps API key is not stored in this file. On the public GitHub Pages
 * site the key is whatever the user saved in this browser (localStorage
 * iEnvi_Config.GOOGLE_API_KEY). A browser key is always visible to the page
 * once it is used; HTTP-referrer restriction in Google Cloud is the control
 * that actually limits who can spend the budget.
 *
 * This module never reads a hard-coded key and never calls the network itself.
 * Callers pass fetchImpl / a Places library. Tests pass fakes.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IenviMaps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var CACHE_STORAGE_KEY = 'iEnvi_mapsCache_v1';
  var CONFIG_STORAGE_KEY = 'iEnvi_Config';
  var GEOCODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var PLACES_TTL_MS = 24 * 60 * 60 * 1000;
  var MAX_CACHE_ENTRIES = 200;
  var ADDRESS_SEARCH_OFF = 'Address search is off. No Google Maps API key is saved in this browser. GPS, the map, and coordinates still work.';

  function mapsKey(config) {
    return String((config && config.GOOGLE_API_KEY) || '').trim();
  }

  function hasMapsKey(config) {
    return mapsKey(config).length > 0;
  }

  function normalizeAddress(address) {
    return String(address || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function roundCoord(value, digits) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n.toFixed(digits);
  }

  function forwardCacheId(address) {
    return 'fwd:' + normalizeAddress(address);
  }

  function reverseCacheId(lat, lng) {
    return 'rev:' + roundCoord(lat, 4) + ',' + roundCoord(lng, 4);
  }

  function placesCacheId(kind, lat, lng) {
    return 'plc:' + String(kind || 'place') + ':' + roundCoord(lat, 3) + ',' + roundCoord(lng, 3);
  }

  function isPlusCode(str) {
    if (!str) return false;
    var first = String(str).trim().split(',')[0].trim();
    return /^[2-9A-Z]{2,8}\+[2-9A-Z]{2,}$/i.test(first);
  }

  function readCache(storage) {
    try {
      var raw = storage && storage.getItem(CACHE_STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeCache(storage, cache) {
    if (!storage || typeof storage.setItem !== 'function') return;
    var entries = Object.keys(cache).map(function (key) {
      return [key, cache[key]];
    });
    entries.sort(function (a, b) {
      return (a[1] && a[1].ts || 0) - (b[1] && b[1].ts || 0);
    });
    while (entries.length > MAX_CACHE_ENTRIES) entries.shift();
    var next = {};
    entries.forEach(function (pair) { next[pair[0]] = pair[1]; });
    try {
      storage.setItem(CACHE_STORAGE_KEY, JSON.stringify(next));
    } catch (e) { /* quota or private mode */ }
  }

  function getFresh(storage, id, now, ttl) {
    var cache = readCache(storage);
    var hit = cache[id];
    if (!hit || typeof hit.ts !== 'number') return null;
    if ((now - hit.ts) > ttl) return null;
    return hit.value;
  }

  function putEntry(storage, id, value, now) {
    var cache = readCache(storage);
    cache[id] = { ts: now, value: value };
    writeCache(storage, cache);
  }

  function rememberForward(storage, address, result, now) {
    if (!storage || !address || !result) return;
    var lat = Number(result.lat);
    var lng = Number(result.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    putEntry(storage, forwardCacheId(address), {
      lat: lat,
      lng: lng,
      formattedAddress: result.formattedAddress || String(address).trim()
    }, now || Date.now());
  }

  function placesCacheGet(storage, kind, lat, lng, now, ttlMs) {
    if (!storage) return null;
    return getFresh(storage, placesCacheId(kind, lat, lng), typeof now === 'number' ? now : Date.now(), ttlMs || PLACES_TTL_MS);
  }

  function placesCachePut(storage, kind, lat, lng, value, now) {
    if (!storage || value == null) return;
    putEntry(storage, placesCacheId(kind, lat, lng), value, typeof now === 'number' ? now : Date.now());
  }

  function createGeocoder(options) {
    var opts = options || {};
    var fetchImpl = opts.fetchImpl;
    var storage = opts.storage;
    var now = opts.now || function () { return Date.now(); };
    var getKey = opts.getKey || function () { return ''; };
    var geocodeTtl = opts.geocodeTtlMs || GEOCODE_TTL_MS;
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetchImpl is required');
    }

    function currentKey() {
      return String(getKey() || '').trim();
    }

    async function geocode(address) {
      var query = String(address || '').trim();
      if (!query) return { ok: false, reason: 'empty' };
      var key = currentKey();
      if (!key) return { ok: false, reason: 'no_key', message: ADDRESS_SEARCH_OFF };
      var id = forwardCacheId(query);
      var cached = getFresh(storage, id, now(), geocodeTtl);
      if (cached) return { ok: true, cached: true, result: cached };
      var url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
        encodeURIComponent(query) + '&key=' + encodeURIComponent(key);
      var data;
      try {
        var resp = await fetchImpl(url);
        data = await resp.json();
      } catch (e) {
        return { ok: false, reason: 'network' };
      }
      var hit = data && data.results && data.results[0];
      var loc = hit && hit.geometry && hit.geometry.location;
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
        return { ok: false, reason: 'no_results', status: data && data.status };
      }
      var result = {
        lat: loc.lat,
        lng: loc.lng,
        formattedAddress: hit.formatted_address || query
      };
      putEntry(storage, id, result, now());
      return { ok: true, cached: false, result: result };
    }

    async function reverseGeocode(lat, lng) {
      var key = currentKey();
      if (!key) return { ok: false, reason: 'no_key', message: ADDRESS_SEARCH_OFF };
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
        return { ok: false, reason: 'bad_coords' };
      }
      var id = reverseCacheId(lat, lng);
      var cached = getFresh(storage, id, now(), geocodeTtl);
      if (cached) return { ok: true, cached: true, result: cached };
      var url = 'https://maps.googleapis.com/maps/api/geocode/json?latlng=' +
        encodeURIComponent(lat) + ',' + encodeURIComponent(lng) + '&key=' + encodeURIComponent(key);
      var data;
      try {
        var resp = await fetchImpl(url);
        data = await resp.json();
      } catch (e) {
        return { ok: false, reason: 'network' };
      }
      var results = (data && data.results) || [];
      var formatted = '';
      for (var i = 0; i < results.length; i++) {
        var candidate = results[i] && results[i].formatted_address;
        if (candidate && !isPlusCode(candidate)) {
          formatted = candidate;
          break;
        }
      }
      if (!formatted) return { ok: false, reason: 'no_results', status: data && data.status };
      var value = { formattedAddress: formatted, lat: Number(lat), lng: Number(lng) };
      putEntry(storage, id, value, now());
      return { ok: true, cached: false, result: value };
    }

    return { geocode: geocode, reverseGeocode: reverseGeocode };
  }

  function geocodeFailureMessage(looked) {
    var status = looked && looked.status;
    if (status === 'REQUEST_DENIED') {
      return 'Google rejected the Maps key. Check the key and its HTTP referrer restriction.';
    }
    if (status === 'OVER_QUERY_LIMIT' || status === 'RESOURCE_EXHAUSTED') {
      return 'Google Maps quota was reached for this key.';
    }
    if (looked && looked.reason === 'no_results') return 'No results found';
    return '';
  }

  function createAutocompleteSession(tokenFactory) {
    if (typeof tokenFactory !== 'function') throw new Error('tokenFactory is required');
    var token = tokenFactory();
    return {
      current: function () { return token; },
      request: function (input, extra) {
        var body = {};
        if (extra) {
          Object.keys(extra).forEach(function (key) { body[key] = extra[key]; });
        }
        body.input = String(input || '');
        body.sessionToken = token;
        return body;
      },
      conclude: function () {
        token = tokenFactory();
        return token;
      }
    };
  }

  function createAutocompleteController(options) {
    var opts = options || {};
    var getKey = opts.getKey || function () { return ''; };
    var tokenFactory = opts.tokenFactory;
    var fetchSuggestions = opts.fetchSuggestions;
    var fetchPlace = opts.fetchPlace;
    var onPlace = opts.onPlace;
    var ensureReady = opts.ensureReady;
    var session = null;
    var seq = 0;

    function key() {
      return String(getKey() || '').trim();
    }

    function ensureSession() {
      if (!session) session = createAutocompleteSession(tokenFactory);
      return session;
    }

    function rotate() {
      if (!session) session = createAutocompleteSession(tokenFactory);
      session.conclude();
    }

    async function ready() {
      if (typeof ensureReady !== 'function') return true;
      await ensureReady();
      return true;
    }

    return {
      query: async function (text) {
        var q = String(text || '').trim();
        if (!key()) return { ok: false, reason: 'no_key' };
        if (q.length < 3) return { ok: false, reason: 'short' };
        try {
          await ready();
        } catch (e) {
          return { ok: false, reason: 'unavailable' };
        }
        var request = ensureSession().request(q);
        var my = ++seq;
        var suggestions = await fetchSuggestions(request);
        if (my !== seq) return { ok: false, reason: 'stale', suggestions: [] };
        return { ok: true, suggestions: suggestions || [], request: request };
      },
      select: async function (suggestion) {
        if (!key()) return { ok: false, reason: 'no_key' };
        seq += 1;
        try {
          await ready();
        } catch (e) {
          return { ok: false, reason: 'unavailable' };
        }
        var place = null;
        try {
          place = await fetchPlace(suggestion);
          if (place && typeof onPlace === 'function') onPlace(place);
          return { ok: true, place: place };
        } finally {
          if (session) rotate();
        }
      }
    };
  }

  function mapsScriptUrl(key) {
    var k = String(key || '').trim();
    if (!k) return '';
    return 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(k) +
      '&libraries=places&v=weekly&callback=ienviMapsPlacesReady';
  }

  function installMapsLoader(key, doc, win) {
    var url = mapsScriptUrl(key);
    if (!url) return false;
    var d = doc || (typeof document !== 'undefined' ? document : null);
    var w = win || (typeof window !== 'undefined' ? window : null);
    if (!d || !w || !d.head || typeof d.createElement !== 'function') return false;
    if (typeof d.getElementById === 'function' && d.getElementById('ienvi-maps-js')) return true;
    var rejectReady = null;
    if (!w.__ienviMapsReady) {
      w.__ienviMapsReady = new Promise(function (resolve, reject) {
        rejectReady = reject;
        w.ienviMapsPlacesReady = function () {
          var places = w.google && w.google.maps && w.google.maps.places;
          if (places) resolve(places);
          else reject(new Error('places-missing'));
        };
      });
    }
    var script = d.createElement('script');
    script.id = 'ienvi-maps-js';
    script.async = true;
    script.src = url;
    script.onerror = function () {
      if (rejectReady) rejectReady(new Error('maps-script-failed'));
    };
    d.head.appendChild(script);
    return true;
  }

  function dedupeHit(state, key, now, windowMs) {
    if (!state) return false;
    if (state.key === key && (now - state.at) < windowMs) return true;
    state.key = key;
    state.at = now;
    return false;
  }

  return {
    CACHE_STORAGE_KEY: CACHE_STORAGE_KEY,
    CONFIG_STORAGE_KEY: CONFIG_STORAGE_KEY,
    GEOCODE_TTL_MS: GEOCODE_TTL_MS,
    PLACES_TTL_MS: PLACES_TTL_MS,
    ADDRESS_SEARCH_OFF: ADDRESS_SEARCH_OFF,
    mapsKey: mapsKey,
    hasMapsKey: hasMapsKey,
    normalizeAddress: normalizeAddress,
    forwardCacheId: forwardCacheId,
    reverseCacheId: reverseCacheId,
    placesCacheId: placesCacheId,
    isPlusCode: isPlusCode,
    rememberForward: rememberForward,
    placesCacheGet: placesCacheGet,
    placesCachePut: placesCachePut,
    createGeocoder: createGeocoder,
    geocodeFailureMessage: geocodeFailureMessage,
    createAutocompleteSession: createAutocompleteSession,
    createAutocompleteController: createAutocompleteController,
    mapsScriptUrl: mapsScriptUrl,
    installMapsLoader: installMapsLoader,
    dedupeHit: dedupeHit
  };
});
