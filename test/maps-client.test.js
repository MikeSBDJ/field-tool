const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const maps = require('../maps-client.js');

// If production code reaches for the real network, fail the test instead of billing Google.
global.fetch = async function refuseNetwork() {
  throw new Error('Refusing network: tests must not call Google');
};

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); }
  };
}

function okGeocodeResponse(address) {
  return {
    json: async () => ({
      status: 'OK',
      results: [{
        formatted_address: address,
        geometry: { location: { lat: -27.47, lng: 153.02 } }
      }]
    })
  };
}

test('committed source has no Google API key', () => {
  const root = path.join(__dirname, '..');
  const files = ['index.html', 'maps-client.js', 'package.json', 'test/maps-client.test.js'];
  const keyPattern = /AIza[0-9A-Za-z\-_]{10,}/;
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(keyPattern.test(text), false, file + ' contains a Google API key');
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const jsonKey = html.match(/"GOOGLE_API_KEY"\s*:\s*"([^"]*)"/);
  assert.ok(jsonKey, 'config JSON should still declare GOOGLE_API_KEY');
  assert.equal(jsonKey[1], '');
  assert.equal(html.includes('maps.googleapis.com'), false);
  assert.equal(html.includes(maps.ADDRESS_SEARCH_OFF), true);
  assert.equal(html.includes('maps-api-key-input'), true);
  assert.equal(html.includes('createAutocompleteController'), true);
  assert.equal(html.includes('iEnvi_Config'), true);
});

test('geocode does not call fetch when the key is missing', async () => {
  let calls = 0;
  const geo = maps.createGeocoder({
    storage: memoryStorage(),
    getKey: () => '',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('fetch should not run');
    }
  });
  const result = await geo.geocode('12 Creek Street, Brisbane');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_key');
  assert.equal(result.message, maps.ADDRESS_SEARCH_OFF);
  assert.equal(calls, 0);
});

test('geocode caches a result and does not refetch', async () => {
  let calls = 0;
  const geo = maps.createGeocoder({
    storage: memoryStorage(),
    getKey: () => 'test-maps-key',
    now: () => 1_000_000,
    fetchImpl: async (url) => {
      calls += 1;
      assert.match(url, /^https:\/\/maps\.googleapis\.com\/maps\/api\/geocode\/json\?/);
      assert.match(url, /key=test-maps-key/);
      assert.doesNotMatch(url, /AIza/);
      return okGeocodeResponse('12 Creek Street, Brisbane QLD');
    }
  });
  const first = await geo.geocode('12 Creek Street, Brisbane');
  const second = await geo.geocode('  12   creek street, brisbane ');
  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.result.lat, -27.47);
  assert.equal(second.result.formattedAddress, '12 Creek Street, Brisbane QLD');
});

test('expired geocode cache refetches', async () => {
  let calls = 0;
  let t = 0;
  const geo = maps.createGeocoder({
    storage: memoryStorage(),
    getKey: () => 'test-maps-key',
    now: () => t,
    geocodeTtlMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      return okGeocodeResponse('Somewhere');
    }
  });
  await geo.geocode('Somewhere');
  t = 500;
  await geo.geocode('Somewhere');
  t = 2000;
  await geo.geocode('Somewhere');
  assert.equal(calls, 2);
});

test('denied geocode responses are not cached', async () => {
  let calls = 0;
  const geo = maps.createGeocoder({
    storage: memoryStorage(),
    getKey: () => 'test-maps-key',
    fetchImpl: async () => {
      calls += 1;
      return { json: async () => ({ status: 'REQUEST_DENIED', results: [] }) };
    }
  });
  const first = await geo.geocode('Nowhere');
  const second = await geo.geocode('Nowhere');
  assert.equal(calls, 2);
  assert.equal(first.status, 'REQUEST_DENIED');
  assert.equal(maps.geocodeFailureMessage(first), 'Google rejected the Maps key. Check the key and its HTTP referrer restriction.');
  assert.equal(second.reason, 'no_results');
});

test('reverse geocode skips plus codes, caches, and skips the network without a key', async () => {
  let calls = 0;
  const storage = memoryStorage();
  const geo = maps.createGeocoder({
    storage,
    getKey: () => 'test-maps-key',
    now: () => 50,
    fetchImpl: async (url) => {
      calls += 1;
      assert.match(url, /latlng=/);
      assert.match(url, /key=test-maps-key/);
      return {
        json: async () => ({
          status: 'OK',
          results: [
            { formatted_address: '4RRH+3M' },
            { formatted_address: '12 Creek Street, Brisbane QLD 4000' }
          ]
        })
      };
    }
  });
  const first = await geo.reverseGeocode(-27.4705, 153.026);
  const second = await geo.reverseGeocode(-27.47051, 153.02601);
  assert.equal(calls, 1);
  assert.equal(first.result.formattedAddress, '12 Creek Street, Brisbane QLD 4000');
  assert.equal(second.cached, true);

  const blocked = maps.createGeocoder({
    storage: memoryStorage(),
    getKey: () => '',
    fetchImpl: async () => {
      throw new Error('fetch should not run');
    }
  });
  const missing = await blocked.reverseGeocode(-27.47, 153.02);
  assert.equal(missing.reason, 'no_key');
  const bad = await geo.reverseGeocode('nope', 153);
  assert.equal(bad.reason, 'bad_coords');
});

test('places results are cached by rounded coordinates', () => {
  const storage = memoryStorage();
  const hospital = { name: 'Royal Brisbane', address: 'Butterfield St' };
  assert.equal(maps.placesCacheGet(storage, 'hospital', -27.47, 153.02, 10), null);
  maps.placesCachePut(storage, 'hospital', -27.47, 153.02, hospital, 10);
  assert.deepEqual(maps.placesCacheGet(storage, 'hospital', -27.4704, 153.0204, 10), hospital);
  assert.equal(maps.placesCacheGet(storage, 'hospital', -27.47, 153.02, 10 + maps.PLACES_TTL_MS + 1), null);
});

test('autocomplete session token is reused for a session and rotated after selection', async () => {
  const tokens = [];
  let suggestionCalls = 0;
  let placeCalls = 0;
  const controller = maps.createAutocompleteController({
    getKey: () => 'test-maps-key',
    tokenFactory: () => {
      const token = { id: tokens.length + 1 };
      tokens.push(token);
      return token;
    },
    fetchSuggestions: async (request) => {
      suggestionCalls += 1;
      assert.ok(request.sessionToken);
      assert.equal(typeof request.input, 'string');
      return [{ placePrediction: { text: request.input } }];
    },
    fetchPlace: async (suggestion) => {
      placeCalls += 1;
      return { lat: -27.47, lng: 153.02, formattedAddress: suggestion.placePrediction.text };
    }
  });

  const tooShort = await controller.query('ab');
  assert.equal(tooShort.reason, 'short');
  assert.equal(suggestionCalls, 0);

  const first = await controller.query('bris');
  const second = await controller.query('brisbane');
  assert.equal(suggestionCalls, 2);
  assert.equal(first.request.sessionToken, second.request.sessionToken);

  const selected = await controller.select(second.suggestions[0]);
  assert.equal(placeCalls, 1);
  assert.equal(selected.place.formattedAddress, 'brisbane');

  const third = await controller.query('sydney');
  assert.notEqual(third.request.sessionToken, first.request.sessionToken);
  assert.equal(tokens.length, 2);
});

test('autocomplete does not call Places when the key is missing or the library is unavailable', async () => {
  let calls = 0;
  const missing = maps.createAutocompleteController({
    getKey: () => '   ',
    tokenFactory: () => ({ id: 1 }),
    fetchSuggestions: async () => { calls += 1; return []; },
    fetchPlace: async () => { calls += 1; return null; }
  });
  assert.equal((await missing.query('brisbane')).reason, 'no_key');
  assert.equal((await missing.select({})).reason, 'no_key');
  assert.equal(calls, 0);

  const unavailable = maps.createAutocompleteController({
    getKey: () => 'test-maps-key',
    ensureReady: async () => { throw new Error('offline'); },
    tokenFactory: () => ({ id: 1 }),
    fetchSuggestions: async () => { calls += 1; return []; },
    fetchPlace: async () => { calls += 1; return null; }
  });
  assert.equal((await unavailable.query('brisbane')).reason, 'unavailable');
  assert.equal((await unavailable.select({})).reason, 'unavailable');
  assert.equal(calls, 0);
});

test('a failed place selection still rotates the session token', async () => {
  const seen = [];
  const controller = maps.createAutocompleteController({
    getKey: () => 'test-maps-key',
    tokenFactory: () => {
      const token = { id: seen.length + 1 };
      seen.push(token);
      return token;
    },
    fetchSuggestions: async (request) => {
      seen.push(request.sessionToken);
      return [{}];
    },
    fetchPlace: async () => { throw new Error('details failed'); }
  });
  await controller.query('brisbane city');
  const firstToken = seen[seen.length - 1];
  await assert.rejects(() => controller.select({}));
  await controller.query('south bank');
  const secondToken = seen[seen.length - 1];
  assert.notEqual(firstToken, secondToken);
});

test('maps loader URL is empty without a key and is not fetched while installing', () => {
  assert.equal(maps.mapsScriptUrl(''), '');
  assert.equal(maps.mapsScriptUrl('   '), '');
  const url = maps.mapsScriptUrl('test-maps-key');
  assert.match(url, /key=test-maps-key/);
  assert.match(url, /libraries=places/);
  assert.match(url, /callback=ienviMapsPlacesReady/);
  assert.doesNotMatch(url, /AIza/);

  const appended = [];
  const byId = {};
  const doc = {
    getElementById(id) { return byId[id] || null; },
    createElement() { return {}; },
    head: {
      appendChild(el) {
        if (el && el.id) byId[el.id] = el;
        appended.push(el);
      }
    }
  };
  const win = {};
  assert.equal(maps.installMapsLoader('', doc, win), false);
  assert.equal(appended.length, 0);
  assert.equal(maps.installMapsLoader('test-maps-key', doc, win), true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].src, url);
  assert.equal(typeof win.ienviMapsPlacesReady, 'function');
  assert.equal(maps.installMapsLoader('test-maps-key', doc, win), true);
  assert.equal(appended.length, 1);
});

test('duplicate address searches inside the window are collapsed', () => {
  const state = { key: '', at: 0 };
  assert.equal(maps.dedupeHit(state, 'brisbane', 1000, 800), false);
  assert.equal(maps.dedupeHit(state, 'brisbane', 1500, 800), true);
  assert.equal(maps.dedupeHit(state, 'brisbane', 1900, 800), false);
});

test('rememberForward satisfies the next geocode without a fetch', async () => {
  const storage = memoryStorage();
  maps.rememberForward(storage, '12 Creek Street', { lat: -27.47, lng: 153.02, formattedAddress: '12 Creek Street' }, 10);
  let calls = 0;
  const geo = maps.createGeocoder({
    storage,
    getKey: () => 'test-maps-key',
    now: () => 10,
    fetchImpl: async () => { calls += 1; throw new Error('should use cache'); }
  });
  const looked = await geo.geocode('12 Creek Street');
  assert.equal(calls, 0);
  assert.equal(looked.cached, true);
  assert.equal(looked.result.lng, 153.02);
});
