const fs = require("fs");
const path = require("path");
const express = require("express");
const { ApifyClient } = require("apify-client");
require("dotenv").config({ path: path.join(__dirname, ".env.local") });
require("dotenv").config();

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 3000);
const MAX_LEADS = 500;
const SCORE_THRESHOLD = Number(process.env.LEAD_QUALIFICATION_THRESHOLD || 65);
const DEFAULT_WAIT_SECS = toPositiveInt(process.env.APIFY_WAIT_SECS) || 180;
const DEFAULT_MEMORY_MBYTES = toPositiveInt(process.env.APIFY_DEFAULT_MEMORY_MBYTES) || 1024;
const API_RATE_LIMIT_MAX = toPositiveInt(process.env.APP_API_MAX_REQUESTS) || 30;
const API_RATE_LIMIT_WINDOW_MS =
  (toPositiveInt(process.env.APP_API_WINDOW_MINUTES) || 15) * 60 * 1000;
const rateLimitStore = new Map();
const LAST_RUN_SNAPSHOT_PATH = path.join(__dirname, ".last-run-results.json");
const LAST_RUN_EXPORT_PATH = path.join(__dirname, "last-run-results.csv");

const TIME_WINDOWS = {
  any: { label: "Any time", ms: 0 },
  "24h": { label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  "7d": { label: "Last week", ms: 7 * 24 * 60 * 60 * 1000 },
  "14d": { label: "Last 2 weeks", ms: 14 * 24 * 60 * 60 * 1000 },
  "30d": { label: "Last month", ms: 30 * 24 * 60 * 60 * 1000 },
  "60d": { label: "Last 2 months", ms: 60 * 24 * 60 * 60 * 1000 },
  "90d": { label: "Last 3 months", ms: 90 * 24 * 60 * 60 * 1000 },
  "180d": { label: "Last 6 months", ms: 180 * 24 * 60 * 60 * 1000 },
};

const TIME_WINDOW_ALIASES = {
  last_week: "7d",
  "1_week": "7d",
  week: "7d",
  two_weeks: "14d",
  last_month: "30d",
  "1_month": "30d",
  month: "30d",
  two_months: "60d",
  "2_months": "60d",
  last_2_months: "60d",
  three_months: "90d",
  "3_months": "90d",
  six_months: "180d",
  "6_months": "180d",
};

const INTENT_PHRASES = [
  "looking for",
  "need",
  "need a",
  "need an",
  "need help",
  "any recommendations",
  "anyone recommend",
  "can someone",
  "who can",
  "someone to",
  "hire",
  "quote",
  "estimate",
  "help with",
  "searching for",
  "recommend",
];

const POSITIVE_TOKENS = [
  "great",
  "awesome",
  "excellent",
  "love",
  "good",
  "amazing",
  "happy",
  "recommended",
  "recommend",
];

const NEGATIVE_TOKENS = [
  "bad",
  "terrible",
  "issue",
  "issues",
  "problem",
  "problems",
  "frustrated",
  "urgent",
  "struggling",
  "broken",
  "help",
];

const SERVICE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "my",
  "near",
  "of",
  "on",
  "or",
  "someone",
  "the",
  "to",
  "want",
  "we",
  "with",
  "you",
  "your",
]);

const GOOGLE_MAPS_SOURCE = "google_maps";
const SOURCE_CONFIG = {
  google_maps: {
    key: "google_maps",
    label: "Google Maps",
    actorEnv: "APIFY_ACTOR_GOOGLE_MAPS",
  },
};

const SOURCE_KEYS = Object.keys(SOURCE_CONFIG);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get("/api/sources", (req, res) => {
  const sources = SOURCE_KEYS.map((key) => {
    const config = SOURCE_CONFIG[key];
    const actorId = process.env[config.actorEnv] || "";
    return {
      key,
      label: config.label,
      configured: Boolean(actorId),
      actorId: actorId || null,
    };
  });

  res.json({ sources });
});

app.get("/api/leads/last", (req, res) => {
  const snapshot = readLatestRunSnapshot();
  if (!snapshot) {
    return res.status(404).json({ error: "No saved run results found yet." });
  }

  return res.json(snapshot);
});

app.get("/api/leads/last.csv", (req, res) => {
  const snapshot = readLatestRunSnapshot();
  if (!snapshot) {
    return res.status(404).json({ error: "No saved run results found yet." });
  }

  const csv = buildLeadsCsv(snapshot.leads || []);
  const stamp = new Date(snapshot.savedAt || Date.now()).toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="lead-results-${stamp}.csv"`);
  return res.send(csv);
});

app.post(
  "/api/leads",
  createRateLimitMiddleware("api", API_RATE_LIMIT_MAX, API_RATE_LIMIT_WINDOW_MS),
  async (req, res) => {
    const useCompanyType = parseBoolean(req.body.useCompanyType, true);
    const inputCompanyType = sanitizeText(req.body.companyType);
    const companyType = useCompanyType ? inputCompanyType : "";
    const serviceNeed = sanitizeText(req.body.serviceNeed);
    const location = sanitizeText(req.body.location);
    const leadCount = Number(req.body.leadCount);
    const timeWindow = normalizeTimeWindow(req.body.timeWindow);
    const timeContext = resolveTimeContext(timeWindow);
    const source = GOOGLE_MAPS_SOURCE;
    const sourceOptions = parseSourceOptions(req.body.sourceOptions);
    const searchTopic =
      serviceNeed ||
      companyType ||
      sourceOptions.googleMapsSearchTerms[0] ||
      sourceOptions.googleMapsSearchString;

    if (!Number.isInteger(leadCount) || leadCount < 1 || leadCount > MAX_LEADS) {
      return res.status(400).json({
        error: `leadCount must be an integer between 1 and ${MAX_LEADS}.`,
      });
    }

    const sourceValidationError = validateSourceInput({
      companyType,
      serviceNeed,
      location,
      sourceOptions,
    });
    if (sourceValidationError) {
      return res.status(400).json({ error: sourceValidationError });
    }
    if (!process.env.APIFY_TOKEN) {
      return res.status(500).json({
        error: "APIFY_TOKEN is missing. Add it to your .env file.",
      });
    }

    const config = SOURCE_CONFIG[source];
    const actorId = process.env[config.actorEnv] || "";
    if (!actorId) {
      return res.status(500).json({
        error: `No actor configured for Google Maps. Set ${config.actorEnv} in .env.`,
      });
    }

    try {
      const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
      const scrapeResult = await scrapeSource({
        client,
        source,
        actorId,
        companyType,
        serviceNeed,
        searchTopic,
        useCompanyType,
        location,
        target: leadCount,
        timeContext,
        sourceOptions,
      });

      const merged = dedupeLeads(scrapeResult.leads);
      const ranked = merged.sort((a, b) => {
        if (b.qualificationScore !== a.qualificationScore) {
          return b.qualificationScore - a.qualificationScore;
        }
        return b.intentScore - a.intentScore;
      });
      const limited = ranked.slice(0, leadCount).map(stripInternalFields);
      const qualifiedCount = limited.filter((lead) => lead.qualified).length;
      const warnings = scrapeResult.error ? [`Google Maps: ${scrapeResult.error}`] : [];

      const payload = {
        meta: {
          companyType,
          useCompanyType,
          serviceNeed,
          searchTopic,
          location,
          timeWindow: timeContext.key,
          timeWindowLabel: timeContext.label,
          sinceDate: timeContext.sinceDateIso || null,
          requestedLeads: leadCount,
          returnedLeads: limited.length,
          qualifiedLeads: qualifiedCount,
          selectedSource: source,
          sourceOptions: {
            googleMapsSearchTerms: sourceOptions.googleMapsSearchTerms,
            googleMapsSearchString: sourceOptions.googleMapsSearchString || "",
            googleMapsLocationQuery: sourceOptions.googleMapsLocationQuery || "",
            googleMapsMaxCrawledPlacesPerSearch:
              sourceOptions.googleMapsMaxCrawledPlacesPerSearch || null,
            googleMapsLanguage: sourceOptions.googleMapsLanguage || "en",
          },
          warnings,
        },
        sourceResults: [
          {
            source: scrapeResult.source,
            actorId: scrapeResult.actorId,
            target: scrapeResult.target,
            scraped: scrapeResult.scraped,
            normalized: scrapeResult.leads.length,
            error: scrapeResult.error || null,
          },
        ],
        leads: limited,
      };

      saveLatestRunSnapshot(payload);

      return res.json(payload);
    } catch (error) {
      const message = error && error.message ? error.message : "Unknown scrape error.";
      return res.status(500).json({ error: message });
    }
  }
);

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBoolean(value, defaultValue) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
      return false;
    }
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return defaultValue;
}

function parseSourceOptions(rawValue) {
  const raw = rawValue && typeof rawValue === "object" ? rawValue : {};
  const googleMapsSearchTerms = Array.from(
    new Set(parseStringArray(raw.googleMapsSearchTerms))
  );
  const googleMapsSearchString = sanitizeText(raw.googleMapsSearchString);
  const googleMapsLocationQuery = sanitizeText(raw.googleMapsLocationQuery);
  const googleMapsMaxCrawledPlacesPerSearch =
    toPositiveInt(raw.googleMapsMaxCrawledPlacesPerSearch) ||
    toPositiveInt(raw.googleMapsMaxCrawledPlaces);
  const googleMapsLanguage = sanitizeText(raw.googleMapsLanguage);

  return {
    googleMapsSearchTerms,
    googleMapsSearchString,
    googleMapsLocationQuery,
    googleMapsMaxCrawledPlacesPerSearch,
    googleMapsLanguage,
  };
}

function validateSourceInput({ companyType, serviceNeed, location, sourceOptions }) {
  const hasTopic = Boolean(
    sourceOptions.googleMapsSearchTerms.length > 0 ||
      sourceOptions.googleMapsSearchString ||
      serviceNeed ||
      companyType
  );
  const effectiveLocation = sourceOptions.googleMapsLocationQuery || location;
  if (!effectiveLocation) {
    return "Google Maps needs a location or location query.";
  }
  if (!hasTopic) {
    return "Google Maps needs at least one search term, company type, service need, or search string.";
  }

  return "";
}

function parseStringArray(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeText(item))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((item) => sanitizeText(item))
      .filter(Boolean);
  }

  return [];
}

function normalizeTimeWindow(rawValue) {
  const raw = String(rawValue || "any")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  const normalized = TIME_WINDOW_ALIASES[raw] || raw;
  return TIME_WINDOWS[normalized] ? normalized : "any";
}

function resolveTimeContext(timeWindow) {
  const config = TIME_WINDOWS[timeWindow] || TIME_WINDOWS.any;
  if (!config.ms) {
    return {
      key: "any",
      label: config.label,
      sinceMs: 0,
      sinceSec: 0,
      sinceDateIso: "",
    };
  }

  const sinceMs = Date.now() - config.ms;
  return {
    key: timeWindow,
    label: config.label,
    sinceMs,
    sinceSec: Math.floor(sinceMs / 1000),
    sinceDateIso: new Date(sinceMs).toISOString(),
  };
}

async function scrapeSource({
  client,
  source,
  actorId,
  companyType,
  serviceNeed,
  searchTopic,
  useCompanyType,
  location,
  target,
  timeContext,
  sourceOptions,
}) {
  const actorLimit = timeContext.sinceMs
    ? Math.min(Math.max(target * 8, target), 1000)
    : Math.min(Math.max(target * 4, target), 1000);
  const searchQuery = buildSearchQuery({ companyType, serviceNeed, location });
  const intentQueries = buildIntentSearchQueries({
    companyType,
    serviceNeed,
    location,
    query: searchQuery,
  });
  const actorInput = buildActorInput(source, {
    companyType,
    serviceNeed,
    location,
    limit: actorLimit,
    query: searchQuery,
    searchQuery,
    searchTopic,
    useCompanyType,
    intentQueries,
    timeWindow: timeContext.key,
    timeWindowLabel: timeContext.label,
    sinceDateIso: timeContext.sinceDateIso,
    sinceEpochMs: timeContext.sinceMs,
    sinceEpochSec: timeContext.sinceSec,
    sourceOptions,
  });
  const runOptions = buildRunOptions(source);

  try {
    const run = await client.actor(actorId).call(actorInput, runOptions);
    const datasetId = run.defaultDatasetId;
    if (!datasetId) {
      return {
        source,
        actorId,
        target,
        scraped: 0,
        leads: [],
        error: "Actor finished without a dataset.",
      };
    }

    const { items } = await client.dataset(datasetId).listItems({
      limit: Math.min(actorLimit * 4, 2000),
      clean: true,
    });

    const leads = (items || [])
      .map((item) =>
        normalizeLead(item, {
          source,
          fallbackType: companyType,
          fallbackLocation: location,
          serviceNeed,
          searchTopic,
        })
      )
      .filter(Boolean);

    return {
      source,
      actorId,
      target,
      scraped: items ? items.length : 0,
      leads,
    };
  } catch (error) {
    return {
      source,
      actorId,
      target,
      scraped: 0,
      leads: [],
      error: error && error.message ? error.message : "Actor run failed.",
    };
  }
}

function buildActorInput(source, params) {
  const envKey = `APIFY_INPUT_TEMPLATE_${source.toUpperCase()}`;
  const template = process.env[envKey];

  if (template) {
    try {
      const parsed = JSON.parse(template);
      const templatedInput = applyTemplate(parsed, params);
      return ensureSourceRequiredFields(source, templatedInput, params);
    } catch (error) {
      throw new Error(`${envKey} must be valid JSON.`);
    }
  }

  return ensureSourceRequiredFields(source, buildDefaultActorInput(source, params), params);
}

function buildDefaultActorInput(source, params) {
  const { companyType, location, limit, query, searchTopic, sourceOptions } = params;
  const options = sourceOptions || {};

  if (source === "google_maps") {
    const searchStringsArray =
      Array.isArray(options.googleMapsSearchTerms) && options.googleMapsSearchTerms.length > 0
        ? options.googleMapsSearchTerms
        : [options.googleMapsSearchString || companyType || searchTopic || query].filter(Boolean);
    const locationQuery = options.googleMapsLocationQuery || location;
    const input = {
      searchStringsArray,
      maxCrawledPlacesPerSearch: options.googleMapsMaxCrawledPlacesPerSearch || limit,
      language: options.googleMapsLanguage || "en",
    };

    if (locationQuery) {
      input.locationQuery = locationQuery;
    }

    return input;
  }

  return {
    query,
    maxItems: limit,
  };
}

function ensureSourceRequiredFields(source, input, params) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  if (source === "google_maps") {
    const hasSearchStrings =
      Array.isArray(input.searchStringsArray) && input.searchStringsArray.length > 0;

    if (!hasSearchStrings) {
      if (input.searchString) {
        input.searchStringsArray = parseStringArray(input.searchString);
      } else {
        const fallbackSearchStrings =
          params.sourceOptions &&
          Array.isArray(params.sourceOptions.googleMapsSearchTerms) &&
          params.sourceOptions.googleMapsSearchTerms.length > 0
            ? params.sourceOptions.googleMapsSearchTerms
            : [params.searchTopic || params.query || ""].filter(Boolean);

        input.searchStringsArray = fallbackSearchStrings;
      }
    }

    if (!input.locationQuery) {
      const fallbackLocation =
        (params.sourceOptions && params.sourceOptions.googleMapsLocationQuery) || params.location;
      if (fallbackLocation) {
        input.locationQuery = fallbackLocation;
      }
    }

    if (!input.maxCrawledPlacesPerSearch) {
      input.maxCrawledPlacesPerSearch = input.maxCrawledPlaces || params.limit;
    }

    if (!input.language) {
      input.language =
        (params.sourceOptions && params.sourceOptions.googleMapsLanguage) || "en";
    }
  }

  return input;
}

function buildRunOptions(source) {
  const sourceMemory = toPositiveInt(
    process.env[`APIFY_MEMORY_MBYTES_${source.toUpperCase()}`]
  );

  const options = {
    waitSecs: DEFAULT_WAIT_SECS,
    memory: sourceMemory || DEFAULT_MEMORY_MBYTES,
  };

  return options;
}

function buildSearchQuery({ companyType, serviceNeed, location }) {
  const topic = sanitizeText(serviceNeed) || sanitizeText(companyType);
  return [topic, sanitizeText(location)].filter(Boolean).join(" ").trim();
}

function buildIntentSearchQueries({ companyType, serviceNeed, location, query }) {
  const topic = sanitizeText(serviceNeed) || sanitizeText(companyType);
  const base = [topic, sanitizeText(location)].filter(Boolean).join(" ").trim();
  const candidates = [
    `${base} looking for`,
    `${base} need help`,
    `${base} recommendation`,
    `${base} who can`,
    query,
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

function applyTemplate(value, params) {
  if (typeof value === "string") {
    const tokenOnlyMatch = value.match(/^\{\{(\w+)\}\}$/);
    if (tokenOnlyMatch) {
      const key = tokenOnlyMatch[1];
      if (key === "companyType" && !params.companyType && params.searchTopic) {
        return params.searchTopic;
      }
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        return params[key];
      }
    }

    return value.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (key === "companyType" && !params.companyType && params.searchTopic) {
        return String(params.searchTopic);
      }
      if (params[key] === undefined || params[key] === null) {
        return match;
      }
      return String(params[key]);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyTemplate(item, params));
  }

  if (value && typeof value === "object") {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = applyTemplate(nested, params);
    }
    return result;
  }

  return value;
}

function normalizeLead(
  item,
  { source, fallbackType, fallbackLocation, serviceNeed, searchTopic }
) {
  const companyName = pickText(
    item.name,
    item.title,
    item.businessName,
    item.companyName,
    item.displayName
  );
  const personName = pickText(
    item.contactName,
    item.ownerName
  );
  const username = "";
  const content = pickContent(item);
  const createdAt = normalizeDate(pickCreatedAt(item));

  const leadName = companyName || personName || username || pickText(item.subject);
  if (!leadName && !content) {
    return null;
  }

  const phoneNumber = normalizePhone(
    pickText(
      item.phone,
      item.phoneNumber,
      item.contactPhone,
      item.telephone,
      item.mobile,
      item.contact && item.contact.phone
    )
  );

  const type = pickText(
    item.type,
    item.businessType,
    item.category,
    item.categoryName,
    item.industry,
    fallbackType
  );

  const address = pickAddress(item, fallbackLocation);
  const website = pickText(
    item.website,
    item.websiteUrl,
    item.webSite,
    item.site,
    item.businessWebsite
  );
  const needsWebsite = !website;
  const sourceUrl = normalizeSourceUrl(
    pickText(
      item.googleMapsUrl,
      item.mapsUrl,
      item.placeUrl,
      item.url,
      item.link,
      item.topLevelUrl,
      item.inputUrl,
      item.website
    )
  );
  const sentiment = analyzeSentiment(content);
  const intent = analyzeIntent({
    content,
    serviceNeed,
    searchTopic,
  });
  const impliedNeedContent =
    extractNeedEvidence(content, intent.matchedPhrases, intent.matchedServiceTokens) || "N/A";

  const lead = {
    companyName: leadName || "N/A",
    personName: personName || "N/A",
    username: username || "N/A",
    phoneNumber: phoneNumber || "N/A",
    type: type || "Unknown",
    address: address || "N/A",
    source,
    website: website || "N/A",
    needsWebsite,
    sourceUrl: sourceUrl || "N/A",
    content: content || "N/A",
    impliedNeedContent,
    createdAt: createdAt ? createdAt.iso : "N/A",
    sentimentLabel: sentiment.label,
    sentimentScore: sentiment.score,
    intentScore: intent.score,
  };

  const score = scoreLead(lead);
  return {
    ...lead,
    qualificationScore: score,
    qualified: isQualifiedLead(lead, score),
    raw: item,
  };
}

function pickText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function pickAddress(item, fallbackLocation) {
  const direct = pickText(
    item.address,
    item.fullAddress,
    item.streetAddress,
    item.formattedAddress,
    item.placeAddress
  );
  if (direct) {
    return direct;
  }

  const nestedLocation = item.location || item.addressObject || {};
  const nested = pickText(
    nestedLocation.address,
    nestedLocation.fullAddress,
    nestedLocation.formattedAddress,
    nestedLocation.street
  );

  return nested || fallbackLocation || "";
}

function pickContent(item) {
  const details = item.details || item.meta || {};
  return pickText(
    item.description,
    item.content,
    item.excerpt,
    item.snippet,
    details.text,
    details.description
  );
}

function pickCreatedAt(item) {
  return pickDefined(
    item.createdAt,
    item.created_at,
    item.createdUtc,
    item.created_utc,
    item.timestamp,
    item.time,
    item.date,
    item.insertedAt,
    item.updatedAt
  );
}

function pickDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  let epochMs = 0;

  if (typeof value === "number") {
    if (value > 1_000_000_000_000) {
      epochMs = value;
    } else if (value > 1_000_000_000) {
      epochMs = value * 1000;
    }
  } else if (typeof value === "string") {
    const text = value.trim();
    if (/^\d+$/.test(text)) {
      const asNumber = Number(text);
      if (asNumber > 1_000_000_000_000) {
        epochMs = asNumber;
      } else if (asNumber > 1_000_000_000) {
        epochMs = asNumber * 1000;
      }
    } else {
      const parsed = Date.parse(text);
      if (Number.isFinite(parsed)) {
        epochMs = parsed;
      }
    }
  } else if (value instanceof Date && !Number.isNaN(value.getTime())) {
    epochMs = value.getTime();
  }

  if (!Number.isFinite(epochMs) || epochMs < 1) {
    return null;
  }

  return {
    epochMs,
    iso: new Date(epochMs).toISOString(),
  };
}

function normalizePhone(value) {
  if (!value) {
    return "";
  }

  const cleaned = value.replace(/[^\d+]/g, "");
  if (!cleaned) {
    return "";
  }

  const digitsOnly = cleaned.replace(/\D/g, "");
  if (digitsOnly.length < 7) {
    return "";
  }

  if (cleaned.startsWith("+")) {
    return cleaned;
  }

  return digitsOnly;
}

function normalizeSourceUrl(value) {
  const text = sanitizeText(value);
  if (!text) {
    return "";
  }

  let url = text;
  if (url.startsWith("//")) {
    url = `https:${url}`;
  } else if (!/^https?:\/\//i.test(url) && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(url)) {
    url = `https://${url}`;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    return "";
  } catch (error) {
    return "";
  }
}

function analyzeSentiment(text) {
  if (!text) {
    return { label: "unknown", score: 0 };
  }

  const normalized = normalizeForMatching(text);
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return { label: "unknown", score: 0 };
  }

  let positiveHits = 0;
  let negativeHits = 0;
  for (const token of tokens) {
    if (POSITIVE_TOKENS.includes(token)) {
      positiveHits += 1;
    }
    if (NEGATIVE_TOKENS.includes(token)) {
      negativeHits += 1;
    }
  }

  const score = clamp((positiveHits - negativeHits) * 14, -100, 100);
  let label = "neutral";
  if (score >= 15) {
    label = "positive";
  } else if (score <= -15) {
    label = "negative";
  }

  return { label, score };
}

function analyzeIntent({ content, serviceNeed, searchTopic }) {
  if (!content) {
    return { score: 0, matchedPhrases: [], matchedServiceTokens: [] };
  }

  const normalized = normalizeForMatching(content);
  let score = 0;
  const matchedPhrases = [];

  for (const phrase of INTENT_PHRASES) {
    if (normalized.includes(phrase)) {
      matchedPhrases.push(phrase);
      score += 13;
    }
  }

  if (content.includes("?")) {
    score += 6;
  }

  if (/\b(quote|estimate|budget|price|cost|hire|contractor|agency|freelancer)\b/.test(normalized)) {
    score += 16;
  }

  if (/\b(urgent|asap|soon|immediately|this week)\b/.test(normalized)) {
    score += 10;
  }

  const matchedServiceTokens = matchServiceTokens(
    normalized,
    extractServiceTokens(serviceNeed || searchTopic)
  );
  if (matchedServiceTokens.length > 0) {
    const totalTokens = Math.max(extractServiceTokens(serviceNeed || searchTopic).length, 1);
    const ratio = matchedServiceTokens.length / totalTokens;
    if (ratio >= 0.6) {
      score += 35;
    } else if (ratio >= 0.35) {
      score += 24;
    } else {
      score += 12;
    }
  }

  score = Math.min(score, 40);

  return {
    score: Math.min(score, 100),
    matchedPhrases,
    matchedServiceTokens,
  };
}

function extractServiceTokens(text) {
  return normalizeForMatching(text)
    .split(" ")
    .filter((token) => token.length >= 3 && !SERVICE_STOPWORDS.has(token));
}

function matchServiceTokens(normalizedText, serviceTokens) {
  const matches = [];
  for (const token of serviceTokens) {
    if (normalizedText.includes(token)) {
      matches.push(token);
    }
  }
  return matches;
}

function extractNeedEvidence(content, matchedPhrases, matchedServiceTokens) {
  if (!content) {
    return "";
  }

  const sentences = content
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const searchTerms = [...matchedPhrases, ...matchedServiceTokens].filter(Boolean);

  if (searchTerms.length > 0) {
    const sentence = sentences.find((candidate) => {
      const normalized = normalizeForMatching(candidate);
      return searchTerms.some((term) => normalized.includes(term));
    });

    if (sentence) {
      return truncateText(sentence, 260);
    }
  }

  return truncateText(content, 260);
}

function normalizeForMatching(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, maxLength) {
  const safe = String(text || "").trim();
  if (safe.length <= maxLength) {
    return safe;
  }
  return `${safe.slice(0, maxLength - 3)}...`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreLead(lead) {
  let score = 0;

  if (lead.companyName && lead.companyName !== "N/A") {
    score += 10;
  }
  if (lead.personName && lead.personName !== "N/A") {
    score += 12;
  }
  if (lead.username && lead.username !== "N/A") {
    score += 10;
  }
  if (lead.content && lead.content !== "N/A") {
    score += 10;
  }
  if (lead.impliedNeedContent && lead.impliedNeedContent !== "N/A") {
    score += 14;
  }
  if (lead.phoneNumber && lead.phoneNumber !== "N/A") {
    score += 15;
  }
  if (lead.address && lead.address !== "N/A") {
    score += 10;
  }
  if (lead.type && lead.type !== "Unknown") {
    score += 6;
  }
  if (lead.needsWebsite) {
    score += 25;
  } else if (lead.website && lead.website !== "N/A") {
    score += 0;
  }
  if (lead.sentimentLabel === "negative") {
    score += 8;
  } else if (lead.sentimentLabel === "neutral") {
    score += 4;
  }
  score += Math.round((lead.intentScore || 0) * 0.2);

  return Math.min(score, 100);
}

function isQualifiedLead(lead, score) {
  return lead.needsWebsite && score >= SCORE_THRESHOLD;
}

function dedupeLeads(leads) {
  const map = new Map();

  for (const lead of leads) {
    const key = dedupeKey(lead);
    const existing = map.get(key);

    if (!existing || lead.qualificationScore > existing.qualificationScore) {
      map.set(key, lead);
    }
  }

  return Array.from(map.values());
}

function dedupeKey(lead) {
  const name = normalizeToken(lead.companyName);
  const phone = normalizeToken(lead.phoneNumber);
  const address = normalizeToken(lead.address);
  const username = normalizeToken(lead.username);
  const content = normalizeToken(lead.impliedNeedContent).slice(0, 64);
  return `${name}|${phone}|${address}|${username}|${content}`;
}

function normalizeToken(value) {
  if (!value || value === "N/A") {
    return "";
  }
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toPositiveInt(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 0;
  }
  return parsed;
}

function stripInternalFields(lead) {
  return {
    companyName: lead.companyName,
    personName: lead.personName,
    username: lead.username,
    phoneNumber: lead.phoneNumber,
    type: lead.type,
    address: lead.address,
    source: lead.source,
    qualified: lead.qualified,
    qualificationScore: lead.qualificationScore,
    website: lead.website,
    needsWebsite: lead.needsWebsite,
    sourceUrl: lead.sourceUrl,
    content: lead.content,
    impliedNeedContent: lead.impliedNeedContent,
    createdAt: lead.createdAt,
    sentimentLabel: lead.sentimentLabel,
    sentimentScore: lead.sentimentScore,
    intentScore: lead.intentScore,
  };
}

function saveLatestRunSnapshot(payload) {
  const snapshot = {
    savedAt: new Date().toISOString(),
    meta: payload.meta || {},
    sourceResults: payload.sourceResults || [],
    leads: Array.isArray(payload.leads) ? payload.leads : [],
  };

  try {
    fs.writeFileSync(LAST_RUN_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (error) {
    console.error(`Unable to save latest run results: ${error.message}`);
  }
}

function readLatestRunSnapshot() {
  try {
    if (fs.existsSync(LAST_RUN_SNAPSHOT_PATH)) {
      const snapshot = JSON.parse(fs.readFileSync(LAST_RUN_SNAPSHOT_PATH, "utf8"));
      if (snapshot && Array.isArray(snapshot.leads)) {
        return snapshot;
      }
    }
  } catch (error) {
    console.error(`Unable to read latest run results: ${error.message}`);
  }

  return readLegacyCsvSnapshot();
}

function readLegacyCsvSnapshot() {
  try {
    if (!fs.existsSync(LAST_RUN_EXPORT_PATH)) {
      return null;
    }

    const rows = parseCsv(fs.readFileSync(LAST_RUN_EXPORT_PATH, "utf8"));
    if (rows.length < 2) {
      return null;
    }

    const headers = rows[0];
    const leads = rows.slice(1).map((row) => csvRowToLead(headers, row)).filter(Boolean);
    if (leads.length === 0) {
      return null;
    }

    return {
      savedAt: fs.statSync(LAST_RUN_EXPORT_PATH).mtime.toISOString(),
      meta: {
        returnedLeads: leads.length,
        requestedLeads: leads.length,
        qualifiedLeads: leads.filter((lead) => lead.qualified).length,
        selectedSource: GOOGLE_MAPS_SOURCE,
        warnings: [],
      },
      sourceResults: [],
      leads,
    };
  } catch (error) {
    console.error(`Unable to read last-run CSV fallback: ${error.message}`);
    return null;
  }
}

function csvRowToLead(headers, row) {
  const record = {};
  headers.forEach((header, index) => {
    record[header] = row[index] || "";
  });

  const companyName = record.Name || record["Company Name"] || "";
  if (!companyName) {
    return null;
  }

  const website = record.Website || "";
  const needsWebsite = !website;

  return {
    companyName,
    personName: "N/A",
    username: "N/A",
    phoneNumber: record.Phone || record["Phone Number"] || "N/A",
    type: record.Category || record.Type || "Unknown",
    address: record.Address || "N/A",
    source: GOOGLE_MAPS_SOURCE,
    qualified: false,
    qualificationScore: Number(record["Qualification Score"]) || 0,
    website: website || "N/A",
    needsWebsite,
    sourceUrl: record.Maps || record["Google Maps URL"] || "N/A",
    content: "N/A",
    impliedNeedContent: "N/A",
    createdAt: "N/A",
    sentimentLabel: "unknown",
    sentimentScore: 0,
    intentScore: 0,
  };
}

function buildLeadsCsv(leads) {
  const headers = [
    "#",
    "Company Name",
    "Phone Number",
    "Type",
    "Address",
    "Needs Website",
    "Website",
    "Google Maps URL",
  ];

  const rows = leads.map((lead, index) => [
    index + 1,
    lead.companyName || "",
    lead.phoneNumber || "",
    lead.type || "",
    lead.address || "",
    lead.needsWebsite ? "Yes" : "No",
    lead.website === "N/A" ? "" : lead.website || "",
    lead.sourceUrl === "N/A" ? "" : lead.sourceUrl || "",
  ]);

  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

function csvEscape(value) {
  const text = String(value === undefined || value === null ? "" : value).replace(/\r?\n/g, " ");
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (insideQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        insideQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      insideQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function createRateLimitMiddleware(namespace, maxRequests, windowMs) {
  return (req, res, next) => {
    clearExpiredRateLimits();

    const ip = extractClientIp(req);
    const key = `${namespace}:${ip}`;
    const now = Date.now();
    const existing = rateLimitStore.get(key);

    if (!existing || existing.resetAt <= now) {
      rateLimitStore.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      return next();
    }

    if (existing.count >= maxRequests) {
      const retryAfterSeconds = Math.max(Math.ceil((existing.resetAt - now) / 1000), 1);
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: "Too many requests. Try again shortly.",
      });
    }

    existing.count += 1;
    rateLimitStore.set(key, existing);
    return next();
  };
}

function clearExpiredRateLimits() {
  const now = Date.now();

  for (const [key, bucket] of rateLimitStore.entries()) {
    if (!bucket || bucket.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

function extractClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || req.socket.remoteAddress || "unknown";
}

app.listen(PORT, () => {
  console.log(`Lead generation server running at http://localhost:${PORT}`);
});
