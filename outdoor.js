(function (global) {
  'use strict';

  var CACHE_PREFIX = 'sunapp:outdoor:v1:';
  var CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  var SEARCH_RADII_KM = [15, 30, 50];
  var PROVIDER_TIMEOUT_MS = 14000;
  var MAX_CONCURRENT_REQUESTS = 1;
  var REQUEST_GAP_MS = 1500;
  var RATE_LIMIT_COOLDOWN_MS = 20 * 60 * 1000;
  var PLACE_BUCKET_STEP = 0.04;
  var OVERPASS_COOLDOWN_KEY = CACHE_PREFIX + 'overpass-cooldown-until';
  var OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  var memoryCache = new Map();
  var pendingQueue = [];
  var activeRequests = 0;
  var lastRequestStartedAt = 0;
  var endpointCursor = 0;
  var rawBucketPromiseCache = new Map();

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function compactText(value, maxLen) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (!maxLen || text.length <= maxLen) return text;
    return text.slice(0, Math.max(0, maxLen - 1)) + '...';
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var toRad = function (v) { return (v * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 6371 * c;
  }

  function safeNumber(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function roundCoord(value) {
    var n = safeNumber(value);
    return n == null ? null : Number(n.toFixed(5));
  }

  function bucketCoord(value, step) {
    var n = safeNumber(value);
    if (n == null) return null;
    var size = safeNumber(step) || PLACE_BUCKET_STEP;
    return Number((Math.round(n / size) * size).toFixed(3));
  }

  function getPlaceBucketKey(place, step) {
    var lat = bucketCoord(place && place.lat, step);
    var lng = bucketCoord(place && (place.lon != null ? place.lon : place.lng), step);
    return lat == null || lng == null ? 'unknown' : (lat + ',' + lng);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function pickTag(tags, keys) {
    var source = tags || {};
    for (var i = 0; i < keys.length; i += 1) {
      var raw = String(source[keys[i]] || '').trim();
      if (raw) return raw;
    }
    return '';
  }

  function normalizeUrl(value) {
    var raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/?#]|$)/i.test(raw)) return 'https://' + raw;
    return '';
  }

  function parseDistanceKm(value) {
    var raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    var cleaned = raw.replace(/,/g, '.');
    var kmMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*km/);
    if (kmMatch) {
      return safeNumber(kmMatch[1]);
    }
    var meterMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*m\b/);
    if (meterMatch) {
      var meters = safeNumber(meterMatch[1]);
      return meters == null ? null : meters / 1000;
    }
    var numberMatch = cleaned.match(/(\d+(?:\.\d+)?)/);
    if (!numberMatch) return null;
    var fallback = safeNumber(numberMatch[1]);
    if (fallback == null) return null;
    if (fallback > 200) return fallback / 1000;
    return fallback;
  }

  function parseDurationMin(value) {
    var raw = String(value || '').trim();
    if (!raw) return null;
    var normalized = raw.toLowerCase().replace(/,/g, '.');
    var iso = normalized.match(/pt(?:(\d+)h)?(?:(\d+)m)?/i);
    if (iso) {
      var isoHours = Number(iso[1] || 0);
      var isoMinutes = Number(iso[2] || 0);
      return (isoHours * 60) + isoMinutes || null;
    }
    var hhmm = normalized.match(/^(\d{1,2}):(\d{2})$/);
    if (hhmm) {
      return (Number(hhmm[1]) * 60) + Number(hhmm[2]);
    }
    var hours = normalized.match(/(\d+(?:\.\d+)?)\s*h/);
    var minutes = normalized.match(/(\d+)\s*min/);
    if (hours || minutes) {
      var total = 0;
      if (hours) total += Math.round(Number(hours[1]) * 60);
      if (minutes) total += Number(minutes[1]);
      return total || null;
    }
    var numberOnly = normalized.match(/^(\d+(?:\.\d+)?)$/);
    if (numberOnly) {
      var num = Number(numberOnly[1]);
      if (!Number.isFinite(num)) return null;
      if (num <= 12) return Math.round(num * 60);
      return Math.round(num);
    }
    return null;
  }

  function parseElevationGain(value) {
    var raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    var cleaned = raw.replace(/,/g, '.');
    var match = cleaned.match(/(-?\d+(?:\.\d+)?)/);
    if (!match) return null;
    var amount = safeNumber(match[1]);
    if (amount == null) return null;
    if (amount > 0 && amount < 20 && /km/.test(cleaned)) return null;
    return Math.round(Math.abs(amount));
  }

  function parseRating(value) {
    var raw = String(value || '').trim().replace(/,/g, '.');
    if (!raw) return null;
    var match = raw.match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    var rating = Number(match[1]);
    if (!Number.isFinite(rating)) return null;
    if (rating > 5 && rating <= 100) return clamp(rating / 20, 0, 5);
    return clamp(rating, 0, 5);
  }

  function parseReviewCount(value) {
    var raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    var digits = raw.replace(/[^\d]/g, '');
    if (!digits) return null;
    var count = Number(digits);
    return Number.isFinite(count) ? count : null;
  }

  function parseUpdatedAt(value) {
    var raw = String(value || '').trim();
    if (!raw) return '';
    var timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) return '';
    return new Date(timestamp).toISOString();
  }

  function formatDuration(durationMin) {
    var total = safeNumber(durationMin);
    if (total == null || total <= 0) return '';
    var hours = Math.floor(total / 60);
    var minutes = Math.round(total % 60);
    if (hours <= 0) return minutes + ' min';
    if (minutes <= 0) return hours + 'h';
    return hours + 'h' + String(minutes).padStart(2, '0');
  }

  function formatDifficulty(rawValue, activityType) {
    var raw = normalizeText(rawValue);
    if (!raw) return '';
    if (activityType === 'vtt') {
      if (/^0$/.test(raw)) return 'facile';
      if (/^(1|2)$/.test(raw)) return 'moyen';
      if (/^(3|4)$/.test(raw)) return 'sportif';
      if (/^(5|6)$/.test(raw)) return 'difficile';
    }
    if (activityType === 'rando') {
      if (raw === 'hiking') return 'facile';
      if (raw === 'mountain_hiking') return 'moyen';
      if (raw === 'demanding_mountain_hiking') return 'soutenu';
      if (raw === 'alpine_hiking') return 'difficile';
      if (raw === 'demanding_alpine_hiking' || raw === 'difficult_alpine_hiking') return 'expert';
    }
    return compactText(String(rawValue || ''), 24);
  }

  function makeCacheKey(key) {
    return CACHE_PREFIX + key;
  }

  function readLocalStorage(key) {
    try {
      if (!global.localStorage) return null;
      var raw = global.localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function writeLocalStorage(key, value) {
    try {
      if (!global.localStorage) return;
      global.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function makeRateLimitError(status) {
    var error = new Error('Overpass rate limited');
    error.code = 'rate_limited';
    error.status = status || 429;
    return error;
  }

  function getOverpassCooldownUntil() {
    var raw = 0;
    try {
      raw = Number(global.localStorage && global.localStorage.getItem(OVERPASS_COOLDOWN_KEY));
    } catch (_) {
      raw = 0;
    }
    return Number.isFinite(raw) ? raw : 0;
  }

  function setOverpassCooldownUntil(timestamp) {
    var until = Number(timestamp) || 0;
    try {
      if (global.localStorage) global.localStorage.setItem(OVERPASS_COOLDOWN_KEY, String(until));
    } catch (_) {}
    return until;
  }

  function hasActiveOverpassCooldown() {
    return getOverpassCooldownUntil() > Date.now();
  }

  function getCachedTrails(cacheKey) {
    var key = makeCacheKey(cacheKey);
    var memoryEntry = memoryCache.get(key);
    if (memoryEntry && memoryEntry.expiresAt > Date.now()) {
      return memoryEntry.data;
    }
    if (memoryEntry) {
      memoryCache.delete(key);
    }
    var stored = readLocalStorage(key);
    if (!stored || stored.expiresAt <= Date.now()) return null;
    memoryCache.set(key, stored);
    return stored.data;
  }

  function setCachedTrails(cacheKey, data, ttlMs) {
    var entry = {
      expiresAt: Date.now() + (ttlMs || CACHE_TTL_MS),
      data: data
    };
    var key = makeCacheKey(cacheKey);
    memoryCache.set(key, entry);
    writeLocalStorage(key, entry);
    return data;
  }

  function enqueueRequest(task) {
    return new Promise(function (resolve, reject) {
      pendingQueue.push({
        task: task,
        resolve: resolve,
        reject: reject
      });
      flushQueue();
    });
  }

  function flushQueue() {
    while (activeRequests < MAX_CONCURRENT_REQUESTS && pendingQueue.length > 0) {
      var next = pendingQueue.shift();
      activeRequests += 1;
      Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(function () {
          activeRequests -= 1;
          flushQueue();
        });
    }
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    var opts = options || {};
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, timeoutMs || PROVIDER_TIMEOUT_MS);
    var externalSignal = opts.signal;
    var onAbort = function () {
      controller.abort();
    };
    if (externalSignal && typeof externalSignal.addEventListener === 'function') {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    var nextOptions = Object.assign({}, opts, { signal: controller.signal });
    return fetch(url, nextOptions).finally(function () {
      clearTimeout(timeoutId);
      if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
        externalSignal.removeEventListener('abort', onAbort);
      }
    });
  }

  function postOverpass(query, signal) {
    var lastError = null;
    if (hasActiveOverpassCooldown()) {
      return Promise.reject(makeRateLimitError(429));
    }
    return enqueueRequest(function () {
      var orderedEndpoints = OVERPASS_ENDPOINTS
        .map(function (_, idx) {
          return OVERPASS_ENDPOINTS[(endpointCursor + idx) % OVERPASS_ENDPOINTS.length];
        });
      endpointCursor = (endpointCursor + 1) % OVERPASS_ENDPOINTS.length;
      var chain = Promise.resolve(null).then(function () {
        var waitMs = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastRequestStartedAt));
        if (waitMs <= 0) return null;
        return sleep(waitMs);
      });
      orderedEndpoints.forEach(function (endpoint) {
        chain = chain.then(function (payload) {
          if (payload) return payload;
          if (hasActiveOverpassCooldown()) throw makeRateLimitError(429);
          lastRequestStartedAt = Date.now();
          return fetchWithTimeout(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ data: query }),
            signal: signal
          }, PROVIDER_TIMEOUT_MS).then(function (response) {
            if (!response.ok) {
              if (response.status === 429) {
                setOverpassCooldownUntil(Date.now() + RATE_LIMIT_COOLDOWN_MS);
                throw makeRateLimitError(429);
              }
              var error = new Error('HTTP ' + response.status);
              error.status = response.status;
              throw error;
            }
            return response.json();
          }).catch(function (error) {
            if (error && error.code === 'rate_limited') throw error;
            lastError = error;
            return null;
          });
        });
      });
      return chain.then(function (payload) {
        if (payload) return payload;
        throw lastError || new Error('Outdoor provider unavailable');
      });
    });
  }

  function getWaymarkedUrl(activityType, osmType, osmId, lat, lng) {
    if (osmType === 'relation' && osmId) {
      if (activityType === 'vtt') {
        return 'https://cycling.waymarkedtrails.org/#route?id=' + encodeURIComponent(osmId);
      }
      return 'https://hiking.waymarkedtrails.org/#route?id=' + encodeURIComponent(osmId);
    }
    if (lat != null && lng != null) {
      return 'https://www.openstreetmap.org/?mlat=' + encodeURIComponent(lat) + '&mlon=' + encodeURIComponent(lng) + '#map=14/' + encodeURIComponent(lat) + '/' + encodeURIComponent(lng);
    }
    return '';
  }

  function buildTrailSummary(tags) {
    var summary = pickTag(tags, ['description', 'note', 'comment', 'desc']);
    if (summary) return compactText(summary, 180);
    var parts = [];
    var ref = pickTag(tags, ['ref']);
    var operator = pickTag(tags, ['operator']);
    var network = pickTag(tags, ['network']);
    if (ref) parts.push(ref);
    if (operator) parts.push(operator);
    if (network) parts.push(network);
    return compactText(parts.join(' • '), 120);
  }

  function inferActivityType(tags) {
    var routeType = normalizeText(tags && tags.route);
    var labelText = normalizeText([
      tags && tags.name,
      tags && tags.ref,
      tags && tags.network
    ].filter(Boolean).join(' '));
    if (routeType === 'mtb') return 'vtt';
    if (routeType === 'bicycle' && (String(tags && tags['mtb:scale'] || '').trim() || /\b(vtt|mtb|mountain bike)\b/.test(labelText))) {
      return 'vtt';
    }
    if (/^(hiking|foot|walking)$/.test(routeType)) return 'rando';
    return '';
  }

  function mapOverpassElementToTrail(element, activityType, placeLat, placeLng, sourceLabel) {
    var tags = element && element.tags ? element.tags : {};
    var lat = roundCoord(element && (element.lat != null ? element.lat : element.center && element.center.lat));
    var lng = roundCoord(element && (element.lon != null ? element.lon : element.center && element.center.lon));
    if (lat == null || lng == null) return null;
    var title = compactText(pickTag(tags, ['name', 'ref', 'official_name']), 90);
    if (!title || title.length < 3) return null;
    var distanceKm = parseDistanceKm(pickTag(tags, [
      'distance', 'length', 'distance:km', 'length_km', 'route_distance', 'trail:length'
    ]));
    var durationMin = parseDurationMin(pickTag(tags, [
      'duration', 'time', 'estimated_time', 'walking_time', 'ride_time'
    ]));
    var elevationGain = parseElevationGain(pickTag(tags, [
      'ascent', 'ele:gain', 'elevation_gain', 'climb'
    ]));
    var difficulty = formatDifficulty(
      pickTag(tags, ['difficulty', 'sac_scale', 'mtb:scale']),
      activityType
    );
    var rating = parseRating(pickTag(tags, ['rating', 'stars']));
    var reviewCount = parseReviewCount(pickTag(tags, ['rating:count', 'reviews']));
    var updatedAt = parseUpdatedAt(pickTag(tags, ['check_date', 'survey:date', 'updated_at', 'lastcheck']));
    var startDistanceKm = haversineKm(placeLat, placeLng, lat, lng);

    return {
      id: [
        activityType,
        element.type || 'relation',
        element.id || 0,
        normalizeText(title)
      ].join(':'),
      title: title,
      type: activityType,
      url: normalizeUrl(pickTag(tags, ['website', 'url'])) || getWaymarkedUrl(activityType, element.type, element.id, lat, lng),
      lat: lat,
      lng: lng,
      distanceKm: distanceKm,
      durationMin: durationMin,
      duration: formatDuration(durationMin),
      elevationGain: elevationGain,
      difficulty: difficulty,
      source: sourceLabel,
      summary: buildTrailSummary(tags),
      rating: rating,
      reviewCount: reviewCount,
      updatedAt: updatedAt,
      fromPlaceKm: Number(startDistanceKm.toFixed(1))
    };
  }

  function dedupeTrails(trails) {
    var kept = [];
    for (var i = 0; i < trails.length; i += 1) {
      var current = trails[i];
      var currentName = normalizeText(current.title);
      var duplicate = kept.some(function (existing) {
        var sameTitle = currentName && currentName === normalizeText(existing.title);
        var sameSpot = current.lat != null && current.lng != null && existing.lat != null && existing.lng != null &&
          haversineKm(current.lat, current.lng, existing.lat, existing.lng) <= 0.8;
        return sameTitle || (sameSpot && current.type === existing.type);
      });
      if (!duplicate) kept.push(current);
    }
    return kept;
  }

  function getMetadataRichness(trail) {
    var fields = [
      trail.distanceKm,
      trail.durationMin,
      trail.elevationGain,
      trail.difficulty,
      trail.summary,
      trail.url,
      trail.rating,
      trail.reviewCount,
      trail.updatedAt
    ];
    var count = fields.filter(function (field) {
      return field !== null && field !== undefined && field !== '';
    }).length;
    return Math.round((count / fields.length) * 100);
  }

  function getPopularityScore(trail) {
    if (trail.rating == null) return trail.reviewCount ? clamp(20 + Math.log10(trail.reviewCount + 1) * 18, 0, 100) : 0;
    var score = trail.rating * 16;
    if (trail.reviewCount) score += Math.min(20, Math.log10(trail.reviewCount + 1) * 10);
    return clamp(score, 0, 100);
  }

  function getFreshnessScore(trail) {
    if (!trail.updatedAt) return 0;
    var timestamp = Date.parse(trail.updatedAt);
    if (!Number.isFinite(timestamp)) return 0;
    var ageDays = (Date.now() - timestamp) / (24 * 60 * 60 * 1000);
    if (ageDays <= 30) return 100;
    if (ageDays <= 180) return 70;
    if (ageDays <= 365) return 40;
    return 15;
  }

  function rankTrails(trails, place, options) {
    var opts = options || {};
    var radiusKm = safeNumber(opts.radiusKm) || 15;
    var filtered = (Array.isArray(trails) ? trails : [])
      .filter(function (trail) {
        if (!trail || !trail.title) return false;
        var fromPlaceKm = trail.fromPlaceKm;
        if (place && trail.lat != null && trail.lng != null) {
          fromPlaceKm = haversineKm(place.lat, place.lng, trail.lat, trail.lng);
        }
        if (fromPlaceKm == null) return true;
        return fromPlaceKm <= Math.max(55, radiusKm * 1.35);
      })
      .map(function (trail) {
        var fromPlaceKm = trail.fromPlaceKm;
        if (place && trail.lat != null && trail.lng != null) {
          fromPlaceKm = haversineKm(place.lat, place.lng, trail.lat, trail.lng);
        }
        var normalizedDistance = fromPlaceKm == null ? null : Number(fromPlaceKm.toFixed(1));
        var proximity = normalizedDistance == null ? 25 : clamp(100 - (normalizedDistance * 6), 0, 100);
        var richness = getMetadataRichness(trail);
        var popularity = getPopularityScore(trail);
        var freshness = getFreshnessScore(trail);
        var summaryBonus = trail.summary ? 100 : 0;
        var score =
          (proximity * 0.35) +
          (richness * 0.25) +
          (popularity * 0.20) +
          (freshness * 0.10) +
          (summaryBonus * 0.10);
        return Object.assign({}, trail, {
          fromPlaceKm: normalizedDistance,
          _trailScore: Math.round(score * 10) / 10
        });
      })
      .sort(function (a, b) {
        if (b._trailScore !== a._trailScore) return b._trailScore - a._trailScore;
        return (a.fromPlaceKm != null ? a.fromPlaceKm : Infinity) - (b.fromPlaceKm != null ? b.fromPlaceKm : Infinity);
      });
    return dedupeTrails(filtered);
  }

  function buildCombinedSearchQuery(place, radiusKm) {
    var radiusM = Math.round(radiusKm * 1000);
    var lat = place.lat;
    var lng = place.lng;
    return '[out:json][timeout:18];(' +
      'rel(around:' + radiusM + ',' + lat + ',' + lng + ')["type"="route"]["route"="mtb"]["name"];' +
      'rel(around:' + radiusM + ',' + lat + ',' + lng + ')["type"="route"]["route"="bicycle"]["mtb:scale"]["name"];' +
      'rel(around:' + radiusM + ',' + lat + ',' + lng + ')["type"="route"]["route"="bicycle"]["name"~"vtt|mtb|mountain bike",i];' +
      'rel(around:' + radiusM + ',' + lat + ',' + lng + ')["type"="route"]["route"~"hiking|foot|walking"]["name"];' +
      ');out tags center 80;';
  }

  function fetchGroupedTrailsFromOverpass(place, signal) {
    var bucketKey = getPlaceBucketKey(place, PLACE_BUCKET_STEP);
    var cacheKey = [
      'raw-grouped',
      bucketKey,
      SEARCH_RADII_KM[SEARCH_RADII_KM.length - 1]
    ].join(':');
    var cached = getCachedTrails(cacheKey);
    if (cached) return Promise.resolve(cached);
    var pending = rawBucketPromiseCache.get(cacheKey);
    if (pending) return pending;

    var query = buildCombinedSearchQuery(place, SEARCH_RADII_KM[SEARCH_RADII_KM.length - 1]);
    var request = postOverpass(query, signal).then(function (payload) {
      var elements = Array.isArray(payload && payload.elements) ? payload.elements : [];
      var trails = elements
        .map(function (element) {
          var inferredType = inferActivityType(element && element.tags ? element.tags : {});
          if (!inferredType) return null;
          return mapOverpassElementToTrail(element, inferredType, place.lat, place.lng, 'OpenStreetMap');
        })
        .filter(Boolean);
      setCachedTrails(cacheKey, trails);
      rawBucketPromiseCache.delete(cacheKey);
      return trails;
    }).catch(function (error) {
      rawBucketPromiseCache.delete(cacheKey);
      throw error;
    });
    rawBucketPromiseCache.set(cacheKey, request);
    return request;
  }

  function fetchBikeTrailsFromUtagawaCompatibleSource(place, radiusKm, signal) {
    // Provider kept isolated on purpose: if a public UtagawaVTT endpoint is added later,
    // only this function needs to change.
    return fetchGroupedTrailsFromOverpass(place, signal).then(function (trails) {
      return trails.filter(function (trail) { return trail.type === 'vtt'; });
    });
  }

  function fetchHikesFromSimpleProvider(place, radiusKm, signal) {
    return fetchGroupedTrailsFromOverpass(place, signal).then(function (trails) {
      return trails.filter(function (trail) { return trail.type === 'rando'; });
    });
  }

  function resolvePlaceCoordinates(place, signal) {
    if (place && safeNumber(place.lat) != null && safeNumber(place.lon != null ? place.lon : place.lng) != null) {
      return Promise.resolve({
        lat: Number(Number(place.lat).toFixed(5)),
        lng: Number(Number(place.lon != null ? place.lon : place.lng).toFixed(5))
      });
    }

    var placeName = compactText(place && place.name, 120);
    if (!placeName) return Promise.resolve(null);

    var cacheKey = 'geo:' + normalizeText(placeName);
    var cached = getCachedTrails(cacheKey);
    if (cached && cached.lat != null && cached.lng != null) {
      return Promise.resolve(cached);
    }

    var searchUrl = 'https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(placeName) + '&limit=5';
    return enqueueRequest(function () {
      return fetchWithTimeout(searchUrl, { signal: signal }, 8000)
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (payload) {
          var features = Array.isArray(payload && payload.features) ? payload.features : [];
          var best = features.find(function (feature) {
            var coords = feature && feature.geometry && feature.geometry.coordinates;
            return Array.isArray(coords) && safeNumber(coords[0]) != null && safeNumber(coords[1]) != null;
          });
          if (!best) return null;
          var coords = {
            lat: Number(Number(best.geometry.coordinates[1]).toFixed(5)),
            lng: Number(Number(best.geometry.coordinates[0]).toFixed(5))
          };
          setCachedTrails(cacheKey, coords);
          return coords;
        })
        .catch(function () {
          return null;
        });
    });
  }

  function createSectionResult(status, trails, radiusKm) {
    return {
      status: status,
      trails: Array.isArray(trails) ? trails : [],
      radiusKm: radiusKm || null
    };
  }

  function getTopTrails(place, activityType, limit, signal) {
    var maxItems = limit || 3;
    var topCacheKey = [
      'top',
      activityType,
      normalizeText(place && place.name),
      roundCoord(place && place.lat),
      roundCoord(place && (place.lon != null ? place.lon : place.lng))
    ].join(':');
    var cached = getCachedTrails(topCacheKey);
    if (cached) return Promise.resolve(cached);

    return resolvePlaceCoordinates(place, signal).then(function (coords) {
      if (!coords) {
        var unlocatable = createSectionResult('unlocatable', [], null);
        setCachedTrails(topCacheKey, unlocatable);
        return unlocatable;
      }

      var placeWithCoords = {
        name: place && place.name,
        lat: coords.lat,
        lng: coords.lng
      };
      var provider = activityType === 'vtt'
        ? fetchBikeTrailsFromUtagawaCompatibleSource
        : fetchHikesFromSimpleProvider;
      var hadSuccessfulResponse = false;
      var shouldStopSearch = false;

      var sequence = Promise.resolve(null);
      SEARCH_RADII_KM.forEach(function (radiusKm) {
        sequence = sequence.then(function (result) {
          if (result || shouldStopSearch) return result;
          return provider(placeWithCoords, radiusKm, signal)
            .then(function (trails) {
              hadSuccessfulResponse = true;
              var ranked = rankTrails(trails, placeWithCoords, { radiusKm: radiusKm }).slice(0, maxItems);
              if (ranked.length === 0) return null;
              return createSectionResult('ready', ranked, radiusKm);
            })
            .catch(function (error) {
              if (error && error.code === 'rate_limited') shouldStopSearch = true;
              return null;
            });
        });
      });

      return sequence.then(function (result) {
        if (result) {
          setCachedTrails(topCacheKey, result);
          return result;
        }
        if (hadSuccessfulResponse) {
          var empty = createSectionResult('empty', [], SEARCH_RADII_KM[SEARCH_RADII_KM.length - 1]);
          setCachedTrails(topCacheKey, empty);
          return empty;
        }
        var errorResult = createSectionResult('error', [], null);
        setCachedTrails(topCacheKey, errorResult, 15 * 60 * 1000);
        return errorResult;
      });
    });
  }

  function fetchBikeTrailsForPlace(place, signal) {
    return getTopTrails(place, 'vtt', 3, signal);
  }

  function fetchHikesForPlace(place, signal) {
    return getTopTrails(place, 'rando', 3, signal);
  }

  global.SunAppOutdoor = {
    fetchBikeTrailsForPlace: fetchBikeTrailsForPlace,
    fetchHikesForPlace: fetchHikesForPlace,
    fetchOverpassJson: postOverpass,
    hasActiveOverpassCooldown: hasActiveOverpassCooldown,
    getTopTrails: getTopTrails,
    rankTrails: rankTrails,
    getCachedTrails: getCachedTrails,
    setCachedTrails: setCachedTrails
  };
}(typeof window !== 'undefined' ? window : globalThis));
