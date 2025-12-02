/**
 * search-vehicles-tool.js
 * Server-side vehicle search for Sakai Car Dealership Assistant
 */

import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import OpenAI from "openai";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize OpenAI client for embeddings
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DATOCMS_API_TOKEN = process.env.DATOCMS_READONLY_API_TOKEN;
const DATOCMS_API_ENDPOINT =
  process.env.DATOCMS_API_ENDPOINT || "https://graphql.datocms.com/";
const DATOCMS_ENVIRONMENT = process.env.DATOCMS_ENVIRONMENT;
const MAX_FETCH = 500;

const VEHICLE_FIELDS_FRAGMENT = `
fragment VehicleFields on VehicleRecord {
  id
  slug
  name
  description
  make
  model
  year
  color
  srp
  discountValue
  discounted
  percentDiscount
  downpayment
  monthlyPayment
  bestDeal
  featuredBestDeal
  limitedTimeOffer
  offerEndsAt
  engineType
  displacement
  maxHorsePower
  maxTorque
  transmission
  fuelSystem
  fuelCapacity
  ignitionType
  startingSystem
  brakeSystem
  frontTire
  rearTire
  wheelsType
  seatHeight
  seatingCapacity
  minGroundClearance
  overallDimensions
  vcategory
  vtype
  electricVehicleRange
  brand {
    id
    name
  }
  distributor {
    id
    name
  }
  unitConfiguration {
    ... on VehicleConfigurationRecord {
      id
      name
      srp
      downpayment
      monthlyPayment
      features
      images {
        id
        url
        alt
      }
    }
  }
  images {
    id
    url
    alt
  }
}
`;

const ALL_VEHICLES_QUERY = `
  ${VEHICLE_FIELDS_FRAGMENT}
  query AllVehicles($first: IntType) {
    allVehicles(first: $first) {
      ...VehicleFields
    }
  }
`;

/**
 * Fetch all vehicles from DatoCMS
 */
async function fetchVehiclesFromDatoCMS() {
  if (!DATOCMS_API_TOKEN) {
    throw new Error("DATOCMS_READONLY_API_TOKEN not set in env");
  }

  const res = await fetch(DATOCMS_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DATOCMS_API_TOKEN}`,
      ...(DATOCMS_ENVIRONMENT && { "X-Environment": DATOCMS_ENVIRONMENT }),
    },
    body: JSON.stringify({
      query: ALL_VEHICLES_QUERY,
      variables: { first: MAX_FETCH },
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DatoCMS fetch error: ${res.status} ${txt}`);
  }

  const body = await res.json();
  if (body.errors) {
    throw new Error("DatoCMS GraphQL errors: " + JSON.stringify(body.errors));
  }

  return body.data?.allVehicles ?? [];
}

/**
 * Build strict-filtered candidate list for vehicles
 */
async function buildStrictCandidates(items, criteria, excludedIds = [], limit = 3) {
  const candidates = [];

  const excludedSet = new Set((excludedIds || []).map((id) => String(id)));

  const normalizeList = (value, { lowercase = false } = {}) => {
    if (value == null) return [];
    let raw = [];
    if (Array.isArray(value)) {
      raw = value;
    } else if (typeof value === "string") {
      raw = value.split(",");
    } else {
      raw = [value];
    }
    const cleaned = raw
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
    return lowercase ? cleaned.map((item) => item.toLowerCase()) : cleaned;
  };

  const distributorFilters = normalizeList(criteria.filter_distributor, {
    lowercase: true,
  });
  const brandFilters = normalizeList(criteria.filter_brand, {
    lowercase: true,
  });
  const featureFilters = normalizeList(criteria.must_have_features, {
    lowercase: true,
  });
  const locationTokens = normalizeList(criteria.filter_location, {
    lowercase: true,
  });
  const modelFilters = normalizeList(criteria.filter_model, {
    lowercase: true,
  });
  const fuelTypeFilters = normalizeList(criteria.filter_fuel_type, {
    lowercase: true,
  });
  const categoryFilters = normalizeList(criteria.filter_category, {
    lowercase: true,
  });

  // Deterministic helpers
  const vehicleMeetsPrice = (vehicle) => {
    if (criteria.min_price == null && criteria.max_price == null) return true;
    
    // Extract prices from unitConfiguration
    const unitPrices = Array.isArray(vehicle.unitConfiguration)
      ? vehicle.unitConfiguration
          .map((u) => Number(u.srp))
          .filter(Number.isFinite)
      : [];
    
    const meets = (val) => {
      if (criteria.min_price != null && criteria.max_price != null)
        return val >= criteria.min_price && val <= criteria.max_price;
      if (criteria.min_price != null) return val >= criteria.min_price;
      if (criteria.max_price != null) return val <= criteria.max_price;
      return true;
    };
    
    // Check unit prices first
    if (unitPrices.length > 0) {
      return unitPrices.some(meets);
    }
    
    // Fallback: Check vehicle-level price
    const p = Number.isFinite(Number(vehicle.srp))
      ? Number(vehicle.srp)
      : undefined;
    return p != null ? meets(p) : false;
  };

  const vehicleMeetsCategory = (vehicle) => {
    if (!categoryFilters.length) return true;
    const vcategory = String(vehicle.vcategory || "").toLowerCase();
    // Try exact match first, then substring match
    const matches = categoryFilters.some((filter) => {
      const filterLower = filter.toLowerCase();
      // Exact match
      if (vcategory === filterLower) return true;
      // Substring match (either direction)
      if (vcategory.includes(filterLower) || filterLower.includes(vcategory)) return true;
      // Handle underscore vs hyphen variations
      const normalizedVcategory = vcategory.replace(/[_-]/g, '');
      const normalizedFilter = filterLower.replace(/[_-]/g, '');
      if (normalizedVcategory === normalizedFilter) return true;
      // Special handling: "sedan" should match "compact_sedan" and "mid_sized_sedan"
      if (filterLower === "sedan" && (vcategory.includes("sedan") || normalizedVcategory.includes("sedan"))) {
        return true;
      }
      if (vcategory === "sedan" && (filterLower.includes("sedan") || normalizedFilter.includes("sedan"))) {
        return true;
      }
      return false;
    });
    return matches;
  };

  const vehicleMeetsFuelType = (vehicle) => {
    if (!fuelTypeFilters.length) return true;
    const fuelSystem = String(vehicle.fuelSystem || "").toLowerCase();
    return fuelTypeFilters.some((filter) => fuelSystem.includes(filter) || filter.includes(fuelSystem));
  };

  const vehicleMeetsSeating = (vehicle) => {
    if (criteria.min_seating == null && criteria.max_seating == null) return true;
    
    // Extract seating capacity from string like "4-seater" or "7-seater"
    const seatingStr = String(vehicle.seatingCapacity || "").toLowerCase();
    const seatingMatch = seatingStr.match(/(\d+)[-\s]?seater/i);
    const seating = seatingMatch ? parseInt(seatingMatch[1], 10) : null;
    
    // If seating capacity is not available, don't exclude the vehicle
    // (seating might not be set for all vehicles, but category/other filters still apply)
    if (seating == null) return true;
    
    const meets = (val) => {
      if (criteria.min_seating != null && criteria.max_seating != null)
        return val >= criteria.min_seating && val <= criteria.max_seating;
      if (criteria.min_seating != null) return val >= criteria.min_seating;
      if (criteria.max_seating != null) return val <= criteria.max_seating;
      return true;
    };
    
    return meets(seating);
  };

  const collectDistributorTokens = (vehicle) => {
    const tokens = new Set();
    const add = (value) => {
      if (!value) return;
      const str = String(value).toLowerCase().trim();
      if (str) tokens.add(str);
    };
    add(vehicle.distributor?.name);
    return Array.from(tokens);
  };

  const collectBrandTokens = (vehicle) => {
    const tokens = new Set();
    const add = (value) => {
      if (!value) return;
      const str = String(value).toLowerCase().trim();
      if (str) tokens.add(str);
    };
    add(vehicle.brand?.name);
    add(vehicle.make);
    return Array.from(tokens);
  };

  const collectModelTokens = (vehicle) => {
    const tokens = new Set();
    const add = (value) => {
      if (!value) return;
      const str = String(value).toLowerCase().trim();
      if (str) tokens.add(str);
    };
    add(vehicle.name);
    add(vehicle.model);
    add(vehicle.make);
    return Array.from(tokens);
  };

  const collectFeatureTokens = (vehicle) => {
    const tokens = new Set();
    const addTokens = (value) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(addTokens);
        return;
      }
      const str = String(value).toLowerCase();
      str
        .split(/[,.;\n]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .forEach((part) => tokens.add(part));
    };
    
    // Check unit configuration features
    if (Array.isArray(vehicle.unitConfiguration)) {
      vehicle.unitConfiguration.forEach((unit) => {
        if (unit.features) {
          addTokens(unit.features);
        }
      });
    }
    
    // Check description for features
    addTokens(vehicle.description);
    
    return Array.from(tokens);
  };

  const vehicleMeetsDistributor = (vehicle) => {
    if (!distributorFilters.length) return true;
    const tokens = collectDistributorTokens(vehicle);
    return distributorFilters.some((filter) =>
      tokens.some(
        (token) => token.includes(filter) || filter.includes(token)
      )
    );
  };

  const vehicleMeetsBrand = (vehicle) => {
    if (!brandFilters.length) return true;
    const tokens = collectBrandTokens(vehicle);
    return brandFilters.some((filter) =>
      tokens.some(
        (token) => token.includes(filter) || filter.includes(token)
      )
    );
  };

  const vehicleMeetsModel = (vehicle) => {
    if (!modelFilters.length) return true;
    const tokens = collectModelTokens(vehicle);
    return modelFilters.some((filter) =>
      tokens.some(
        (token) => token.includes(filter) || filter.includes(token)
      )
    );
  };

  const vehicleHasRequiredFeatures = (vehicle) => {
    if (!featureFilters.length) return true;
    const tokens = collectFeatureTokens(vehicle);
    return featureFilters.every((filter) => {
      const normalizedFilter = filter.toLowerCase();
      return tokens.some((token) => token.includes(normalizedFilter) || normalizedFilter.includes(token));
    });
  };

  const vehicleTextContainsAnyLocation = (vehicle, locations) => {
    const text = (
      (vehicle.distributor?.name || "") +
      " " +
      (vehicle.name || "") +
      " " +
      (vehicle.description || "")
    ).toLowerCase();
    return locations.some((loc) => text.includes(loc));
  };

  // First pass: strict text location match if provided
  const locations = locationTokens.length ? locationTokens : null;

  console.log(`[Build Candidates] Starting filter with ${items.length} vehicles`);
  console.log(`[Build Candidates] Category filters: ${JSON.stringify(categoryFilters)}`);
  console.log(`[Build Candidates] Seating filters: min=${criteria.min_seating}, max=${criteria.max_seating}`);
  
  let filteredByPrice = 0;
  let filteredByCategory = 0;
  let filteredByFuelType = 0;
  let filteredBySeating = 0;
  let filteredByDistributor = 0;
  let filteredByBrand = 0;
  let filteredByModel = 0;
  let filteredByFeatures = 0;
  let filteredByLocation = 0;

  for (const it of items) {
    if (excludedSet.has(String(it.id))) continue;
    if (!vehicleMeetsPrice(it)) { filteredByPrice++; continue; }
    if (!vehicleMeetsCategory(it)) { filteredByCategory++; continue; }
    if (!vehicleMeetsFuelType(it)) { filteredByFuelType++; continue; }
    if (!vehicleMeetsSeating(it)) { filteredBySeating++; continue; }
    if (!vehicleMeetsDistributor(it)) { filteredByDistributor++; continue; }
    if (!vehicleMeetsBrand(it)) { filteredByBrand++; continue; }
    if (!vehicleMeetsModel(it)) { filteredByModel++; continue; }
    if (!vehicleHasRequiredFeatures(it)) { filteredByFeatures++; continue; }
    if (locations && !vehicleTextContainsAnyLocation(it, locations)) { filteredByLocation++; continue; }

    candidates.push(it);
  }
  
  console.log(`[Build Candidates] Filter results: ${candidates.length} candidates`);
  console.log(`[Build Candidates] Filtered out: price=${filteredByPrice}, category=${filteredByCategory}, fuel=${filteredByFuelType}, seating=${filteredBySeating}, distributor=${filteredByDistributor}, brand=${filteredByBrand}, model=${filteredByModel}, features=${filteredByFeatures}, location=${filteredByLocation}`);

  // Dedupe by id
  const seen = new Set();
  const deduped = [];
  for (const it of candidates) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    deduped.push(it);
  }

  // Apply sorting
  if (criteria.sort_by === "price_asc") {
    deduped.sort((a, b) => {
      const unitPricesA = Array.isArray(a.unitConfiguration)
        ? a.unitConfiguration
            .map((u) => Number(u.srp))
            .filter(Number.isFinite)
        : [];
      const unitPricesB = Array.isArray(b.unitConfiguration)
        ? b.unitConfiguration
            .map((u) => Number(u.srp))
            .filter(Number.isFinite)
        : [];
      const minPriceA = unitPricesA.length
        ? Math.min(...unitPricesA)
        : a.srp || Infinity;
      const minPriceB = unitPricesB.length
        ? Math.min(...unitPricesB)
        : b.srp || Infinity;
      return minPriceA - minPriceB;
    });
  } else if (criteria.sort_by === "price_desc") {
    deduped.sort((a, b) => {
      const unitPricesA = Array.isArray(a.unitConfiguration)
        ? a.unitConfiguration
            .map((u) => Number(u.srp))
            .filter(Number.isFinite)
        : [];
      const unitPricesB = Array.isArray(b.unitConfiguration)
        ? b.unitConfiguration
            .map((u) => Number(u.srp))
            .filter(Number.isFinite)
        : [];
      const maxPriceA = unitPricesA.length
        ? Math.max(...unitPricesA)
        : a.srp || 0;
      const maxPriceB = unitPricesB.length
        ? Math.max(...unitPricesB)
        : b.srp || 0;
      return maxPriceB - maxPriceA;
    });
  }

  // Cap for cost control
  const K = Math.min(limit, 12);
  const capped = deduped.slice(0, K);
  console.log(`[Build Candidates] Capping to ${K} vehicles (requested: ${limit}, max: 12)`);

  // Build slim payload for reranker
  const slim = capped.map((v) => {
    const unitPrices = Array.isArray(v.unitConfiguration)
      ? v.unitConfiguration
          .map((u) => Number(u.srp))
          .filter(Number.isFinite)
      : [];
    const minUnitPrice = unitPrices.length ? Math.min(...unitPrices) : null;
    const maxUnitPrice = unitPrices.length ? Math.max(...unitPrices) : null;
    
    // Extract features from unit configurations
    const allFeatures = [];
    if (Array.isArray(v.unitConfiguration)) {
      v.unitConfiguration.forEach((unit) => {
        if (unit.features) {
          if (Array.isArray(unit.features)) {
            allFeatures.push(...unit.features);
          } else {
            allFeatures.push(String(unit.features));
          }
        }
      });
    }
    const featuresTags = allFeatures.slice(0, 8).map((tag) => String(tag).slice(0, 100));

    return {
      id: v.id,
      name: v.name || "",
      make: v.make || "",
      model: v.model || "",
      distributor: v.distributor?.name || null,
      brand: v.brand?.name || null,
      srp: Number.isFinite(Number(v.srp)) ? Number(v.srp) : null,
      minUnitPrice,
      maxUnitPrice,
      fuelSystem: v.fuelSystem || null,
      seatingCapacity: v.seatingCapacity || null,
      vcategory: v.vcategory || null,
      featuresTags,
    };
  });

  return {
    candidates: slim,
  };
}

/**
 * Query Analyzer Tool for Vehicles
 * Extracts search criteria from user queries
 */
export const queryAnalyzerTool = tool({
  name: "analyze_query",
  description: `Analyze a vehicle query and extract structured search criteria.
    
Use this tool to understand what the user is looking for before searching vehicles.
For follow-up queries, include the conversation history in the query parameter.
Returns a JSON object with extracted criteria like price, location, fuel type, model, etc.`,
  parameters: z.object({
    query: z
      .string()
      .describe(
        "The user's vehicle search query. For follow-ups, include conversation history."
      ),
  }),
  execute: async ({ query }) => {
    console.log("[Query Analyzer Tool] Analyzing query:", query);

    const prompt = fs.readFileSync(path.join(__dirname, '../prompts/vehicle-query-analyzer.md'), 'utf-8');

    // Create a simple agent for query analysis
    const analyzerAgent = new Agent({
      name: "Vehicle Query Analyzer",
      instructions: prompt,
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 1000,
    });

    const result = await run(analyzerAgent, query);
    const output = result.finalOutput || "";

    // Extract JSON from response
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");

    const parsed = JSON.parse(jsonMatch[0]);

    const sanitizeNumber = (value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
      }
      if (typeof value === "string") {
        const cleaned = value.replace(/[^0-9.-]/g, "");
        if (!cleaned || cleaned === "-" || cleaned === ".") return null;
        const num = Number(cleaned);
        return Number.isFinite(num) ? num : null;
      }
      return null;
    };

    const normalizeList = (value) => {
      if (!value) return null;
      const list = Array.isArray(value)
        ? value
        : String(value)
            .split(/[,\/]| and | & /i)
            .map((entry) => entry.trim())
            .filter(Boolean);
      if (list.length === 0) return null;
      return list.map((entry) => entry.toLowerCase());
    };

    const DEFAULT_FLAGS = {
      needsClarification: false,
      clarificationReason: null,
      clarificationOptions: [],
      unrealisticPrice: false,
      priceOutlier: null,
      rangeIssue: null,
      softNotes: [],
    };

    const structured = {
      apiSearchParams: parsed.apiSearchParams || {},
      isFollowUp: Boolean(parsed.isFollowUp),
      flags: {
        ...DEFAULT_FLAGS,
        ...(parsed.flags || {}),
      },
    };

    // Normalize clarification options
    structured.flags.clarificationOptions = Array.isArray(structured.flags.clarificationOptions)
      ? structured.flags.clarificationOptions.map((option) => String(option))
      : [];

    if (structured.flags.needsClarification && !structured.flags.clarificationReason) {
      structured.flags.clarificationReason = "UNSPECIFIED";
    }

    // Normalize apiSearchParams fields
    const params = structured.apiSearchParams;
    params.query = params.query ? String(params.query) : "";
    params.filter_location = params.filter_location
      ? String(params.filter_location)
      : null;
    params.filter_category = params.filter_category
      ? String(params.filter_category)
      : null;
    params.filter_fuel_type = normalizeList(params.filter_fuel_type);
    params.filter_distributor = normalizeList(params.filter_distributor);
    params.filter_brand = normalizeList(params.filter_brand);
    params.filter_model = normalizeList(params.filter_model);
    params.must_have_features = Array.isArray(params.must_have_features)
      ? params.must_have_features.map((item) => String(item))
      : params.must_have_features
      ? [String(params.must_have_features)]
      : null;

    params.sort_by =
      params.sort_by === "price_asc" || params.sort_by === "price_desc"
        ? params.sort_by
        : null;

    params.requested_count = sanitizeNumber(params.requested_count);
    if (
      params.requested_count !== null &&
      (!Number.isFinite(params.requested_count) || params.requested_count <= 0)
    ) {
      params.requested_count = null;
    }

    // Price normalization
    params.min_price = sanitizeNumber(params.min_price);
    params.max_price = sanitizeNumber(params.max_price);

    const LOW_PRICE_THRESHOLD = 50000;
    const HIGH_PRICE_THRESHOLD = 50000000;

    const flagPrice = (value) => {
      if (value == null) return null;
      if (value < LOW_PRICE_THRESHOLD) return "TOO_LOW";
      if (value > HIGH_PRICE_THRESHOLD) return "TOO_HIGH";
      return null;
    };

    let priceFlag = structured.flags.priceOutlier;
    if (!priceFlag) {
      priceFlag = flagPrice(params.min_price) || flagPrice(params.max_price);
    }

    if (priceFlag) {
      structured.flags.unrealisticPrice = true;
      structured.flags.priceOutlier = priceFlag;
      params.min_price = null;
      params.max_price = null;
    } else {
      structured.flags.unrealisticPrice = Boolean(structured.flags.unrealisticPrice);
    }

    // Seating normalization
    params.min_seating = sanitizeNumber(params.min_seating);
    params.max_seating = sanitizeNumber(params.max_seating);

    const normalizeRange = (minValue, maxValue, negativeKey) => {
      let min = sanitizeNumber(minValue);
      let max = sanitizeNumber(maxValue);
      let issue = null;
      if ((min !== null && min < 0) || (max !== null && max < 0)) {
        issue = issue || negativeKey;
        min = null;
        max = null;
      }
      if (min !== null && max !== null && min > max) {
        issue = issue || "MIN_GREATER_THAN_MAX";
        min = null;
        max = null;
      }
      return { min, max, issue };
    };

    const seatingRange = normalizeRange(
      params.min_seating,
      params.max_seating,
      "NEGATIVE_SEATING"
    );
    params.min_seating = seatingRange.min;
    params.max_seating = seatingRange.max;

    if (!structured.flags.rangeIssue) {
      structured.flags.rangeIssue = seatingRange.issue;
    }

    // Ensure softNotes is array of strings
    structured.flags.softNotes = Array.isArray(structured.flags.softNotes)
      ? structured.flags.softNotes.map((note) => String(note))
      : [];

    console.log("[Query Analyzer Tool] Extracted criteria:", structured);

    return JSON.stringify(structured);
  },
});

/**
 * Search Vehicles Tool
 * Searches DatoCMS for vehicles matching the criteria
 */
export const searchVehiclesTool = tool({
  name: "search_vehicles",
  description: `Search for vehicles in the Philippines based on search criteria.

Use this tool AFTER analyzing the query with analyze_query tool.
Takes structured criteria and returns matching vehicles (default: 3 results, max: 10 if requested_count is specified).

CRITICAL: Pass ALL fields from apiSearchParams using EXACT field names:
- query, filter_location, filter_category, filter_fuel_type, filter_distributor, filter_brand, filter_model
- min_price, max_price
- min_seating, max_seating
- must_have_features, sort_by, requested_count
- excludedVehicleIds (optional array to avoid repeating vehicles)

Example: { "query": "...", "filter_location": "Quezon City", "max_price": 1200000, "excludedVehicleIds": ["id1"] }`,
  parameters: z.object({
    criteria: z
      .string()
      .describe(
        "JSON string with ALL fields from apiSearchParams (exact names) plus optional excludedVehicleIds array."
      ),
  }),
  execute: async ({ criteria }) => {
    console.log("[Search Vehicles Tool] Searching with criteria:", criteria);

    let parsedCriteria;
    try {
      parsedCriteria =
        typeof criteria === "string" ? JSON.parse(criteria) : criteria;
    } catch (error) {
      console.error("[Search Vehicles Tool] Invalid criteria JSON");
      parsedCriteria = { query: criteria };
    }

    const arrayify = (value) => {
      if (value == null) return [];
      return Array.isArray(value) ? value : [value];
    };

    const sanitizeNumber = (value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
      }
      if (typeof value === "string") {
        const cleaned = value.replace(/[^0-9.-]/g, "");
        if (!cleaned || cleaned === "-" || cleaned === ".") return null;
        const num = Number(cleaned);
        return Number.isFinite(num) ? num : null;
      }
      return null;
    };

    const normalizeString = (value) => {
      if (value == null) return null;
      const str = String(value).trim();
      return str.length ? str : null;
    };

    const normalizeList = (value, { lowercase = false } = {}) => {
      const list = arrayify(value)
        .map((item) => normalizeString(item))
        .filter(Boolean);
      if (!list.length) return null;
      return lowercase ? list.map((item) => item.toLowerCase()) : list;
    };

    const mergeAnalyzerShape = (input) => {
      let flags = {};
      let searchParams = {};
      let excludedVehicleIds = [];

      if (input && typeof input === "object") {
        if (input.apiSearchParams) {
          flags = input.flags || {};
          excludedVehicleIds = arrayify(input.excludedVehicleIds);
          searchParams = { ...input.apiSearchParams };
        } else {
          flags = input.flags || {};
          excludedVehicleIds = arrayify(input.excludedVehicleIds);
          searchParams = { ...input };
        }
      } else if (input != null) {
        searchParams = { query: input };
      }

      excludedVehicleIds = excludedVehicleIds.concat(
        arrayify(searchParams.excludedVehicleIds)
      );
      delete searchParams.excludedVehicleIds;

      return {
        searchParams,
        flags,
        excludedVehicleIds,
      };
    };

    const {
      searchParams,
      flags: incomingFlags,
      excludedVehicleIds: rawExcludedIds,
    } = mergeAnalyzerShape(parsedCriteria);

    let structuredCriteria = { ...searchParams };

    const defaultFlags = {
      needsClarification: false,
      clarificationReason: null,
      clarificationOptions: [],
      unrealisticPrice: false,
      priceOutlier: null,
      rangeIssue: null,
      softNotes: [],
    };

    const analyzerFlags = {
      ...defaultFlags,
      ...(incomingFlags && typeof incomingFlags === "object"
        ? incomingFlags
        : {}),
    };

    analyzerFlags.clarificationOptions = normalizeList(
      analyzerFlags.clarificationOptions
    ) || [];
    analyzerFlags.softNotes = normalizeList(analyzerFlags.softNotes) || [];

    structuredCriteria.query = normalizeString(structuredCriteria.query) || "";

    const normalizedLocations = normalizeList(structuredCriteria.filter_location);
    structuredCriteria.filter_location = normalizedLocations
      ? normalizedLocations.join(", ")
      : null;

    structuredCriteria.filter_category = normalizeString(
      structuredCriteria.filter_category
    );

    structuredCriteria.filter_fuel_type = normalizeList(
      structuredCriteria.filter_fuel_type,
      { lowercase: true }
    );

    structuredCriteria.filter_distributor = normalizeList(
      structuredCriteria.filter_distributor,
      { lowercase: true }
    );

    structuredCriteria.filter_brand = normalizeList(
      structuredCriteria.filter_brand,
      { lowercase: true }
    );

    structuredCriteria.filter_model = normalizeList(
      structuredCriteria.filter_model,
      { lowercase: true }
    );

    structuredCriteria.must_have_features = normalizeList(
      structuredCriteria.must_have_features,
      { lowercase: true }
    );

    structuredCriteria.min_price = sanitizeNumber(
      structuredCriteria.min_price
    );
    structuredCriteria.max_price = sanitizeNumber(
      structuredCriteria.max_price
    );

    structuredCriteria.min_seating = sanitizeNumber(
      structuredCriteria.min_seating
    );
    structuredCriteria.max_seating = sanitizeNumber(
      structuredCriteria.max_seating
    );

    const normalizeRange = (minValue, maxValue, negativeKey) => {
      let min = sanitizeNumber(minValue);
      let max = sanitizeNumber(maxValue);
      let issue = null;
      if ((min != null && min < 0) || (max != null && max < 0)) {
        issue = issue || negativeKey;
        min = null;
        max = null;
      }
      if (min != null && max != null && min > max) {
        issue = issue || "MIN_GREATER_THAN_MAX";
        min = null;
        max = null;
      }
      return { min, max, issue };
    };

    const seatingRange = normalizeRange(
      structuredCriteria.min_seating,
      structuredCriteria.max_seating,
      "NEGATIVE_SEATING"
    );
    structuredCriteria.min_seating = seatingRange.min;
    structuredCriteria.max_seating = seatingRange.max;

    if (!analyzerFlags.rangeIssue) {
      analyzerFlags.rangeIssue = seatingRange.issue || null;
    }

    structuredCriteria.requested_count = sanitizeNumber(
      structuredCriteria.requested_count
    );
    if (
      structuredCriteria.requested_count != null &&
      structuredCriteria.requested_count > 0
    ) {
      structuredCriteria.requested_count = Math.round(
        structuredCriteria.requested_count
      );
    } else {
      structuredCriteria.requested_count = null;
    }

    structuredCriteria.sort_by =
      structuredCriteria.sort_by === "price_asc" ||
      structuredCriteria.sort_by === "price_desc"
        ? structuredCriteria.sort_by
        : null;

    const detectPriceOutlier = (value) => {
      if (value == null) return null;
      if (value < 50000) return "TOO_LOW";
      if (value > 50000000) return "TOO_HIGH";
      return null;
    };

    if (!analyzerFlags.priceOutlier) {
      analyzerFlags.priceOutlier =
        detectPriceOutlier(structuredCriteria.min_price) ||
        detectPriceOutlier(structuredCriteria.max_price);
    }

    if (analyzerFlags.priceOutlier) {
      analyzerFlags.unrealisticPrice = true;
      structuredCriteria.min_price = null;
      structuredCriteria.max_price = null;
    } else {
      analyzerFlags.unrealisticPrice = Boolean(
        analyzerFlags.unrealisticPrice
      );
    }

    const excludedIds = Array.from(
      new Set(
        arrayify(rawExcludedIds)
          .concat(arrayify(structuredCriteria.excludedVehicleIds))
          .map((id) => String(id))
      )
    );
    delete structuredCriteria.excludedVehicleIds;

    const limit = Math.min(
      Math.max(1, structuredCriteria.requested_count || 3),
      10
    );
    console.log("[Search Vehicles Tool] Using limit:", limit);

    if (analyzerFlags.needsClarification) {
      console.log(
        "[Search Vehicles Tool] Clarification needed, skipping search"
      );
      return JSON.stringify({
        results: [],
        message: "NEEDS_CLARIFICATION",
        flags: analyzerFlags,
      });
    }

    if (analyzerFlags.unrealisticPrice) {
      console.log(
        "[Search Vehicles Tool] Unrealistic price detected, skipping search"
      );
      return JSON.stringify({
        results: [],
        message: "UNREALISTIC_PRICE_QUERY",
        flags: analyzerFlags,
      });
    }

    if (analyzerFlags.rangeIssue) {
      console.log(
        "[Search Vehicles Tool] Invalid seating range, skipping search"
      );
      return JSON.stringify({
        results: [],
        message: "INVALID_RANGE_QUERY",
        flags: analyzerFlags,
      });
    }

    if (excludedIds.length > 0) {
      console.log(
        "[Search Vehicles Tool] Excluding",
        excludedIds.length,
        "previously shown vehicles"
      );
    }

    const allVehicles = await fetchVehiclesFromDatoCMS();

    // Build strict candidates
    const { candidates } = await buildStrictCandidates(
      allVehicles,
      structuredCriteria,
      excludedIds,
      limit
    );

    const out = {
      candidates,
      count: candidates.length,
      flags: analyzerFlags,
      requestedCount: limit,
    };

    console.log(
      `[Search Vehicles Tool] Returning ${out.count} candidates`
    );
    return JSON.stringify(out);
  },
});

/**
 * Rerank Vehicles Tool
 * Orders candidates by relevance and returns reasons per id
 */
export const rerankVehiclesTool = tool({
  name: "rerank_vehicles",
  description: `Given structured criteria and a list of candidate vehicles (slim), order them by relevance and provide short reasons per id. Use for tie-breaking, feature matching, intent nuances, and combining signals like price fit and feature availability.`,
  parameters: z.object({
    criteriaJson: z
      .string()
      .describe(
        "JSON string of search criteria used; same shape produced by analyze_query."
      ),
    candidatesJson: z
      .string()
      .describe("JSON string array of slim candidates from search_vehicles."),
  }),
  execute: async ({ criteriaJson, candidatesJson }) => {
    let criteria;
    let candidates;
    try {
      criteria = JSON.parse(criteriaJson);
    } catch {
      criteria = {};
    }
    try {
      candidates = JSON.parse(candidatesJson);
    } catch {
      candidates = [];
    }

    const params = criteria.apiSearchParams || criteria;
    
    console.log(
      `[Rerank Tool] Processing ${candidates.length} candidates`
    );

    const prompt = fs.readFileSync(path.join(__dirname, '../prompts/vehicle-reranker.md'), 'utf-8');

    const reranker = new Agent({
      name: "Vehicle Reranker",
      instructions: prompt,
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 1000,
    });

    const input = `CRITERIA\n${JSON.stringify(
      criteria
    )}\n\nCANDIDATES\n${JSON.stringify(candidates)}`;
    const result = await run(reranker, input);
    let output = result.finalOutput || "";

    // Strip markdown code blocks if present
    output = output.replace(/```(?:json)?\s*/g, "").trim();

    // Parse the JSON response
    try {
      const parsed = JSON.parse(output);
      // Validate that we have orderedIds array
      if (!Array.isArray(parsed.orderedIds)) {
        console.log(
          "[Rerank Vehicles Tool] Invalid orderedIds, using fallback"
        );
        return JSON.stringify({
          orderedIds: candidates.map((c) => c.id),
          reasonsById: parsed.reasonsById || {},
          scoresById: parsed.scoresById || {},
        });
      }
      return JSON.stringify(parsed);
    } catch (parseError) {
      console.log(
        "[Rerank Vehicles Tool] JSON parse error, using fallback:",
        parseError.message
      );
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed.orderedIds)) {
            return JSON.stringify(parsed);
          }
        } catch (e) {
          // Fall through to final fallback
        }
      }
      return JSON.stringify({
        orderedIds: candidates.map((c) => c.id),
        reasonsById: {},
        scoresById: {},
      });
    }
  },
});

