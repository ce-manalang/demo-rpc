/**
 * search-properties-tool.js
 * Server-side property search for Bahai Assistant
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

const PROPERTY_FIELDS_FRAGMENT = `
fragment PropertyFields on PropertyRecord {
  id
  name
  summary
  ptype
  purpose
  area
  minArea
  maxArea
  bedrooms
  bathrooms
  description
  amenitiesAndCommonFacilities
  buildingAmenities
  unitFeatures
	kitchenFeatures
	parkingAndAccess
	greenFeatures
	accessibilityFeatures
	safetyAndSecurity
  locationName
  location {
      latitude
      longitude
  }
  price
  photos {
      url
      alt
  }
  project {
      id
      name
      developer {
          id
          fullName
          shortName
          slug
      }
      slug
  }
  developer {
      id
      fullName
      slug
  }
  slug
  searchTags
  secondaryTags
  unitConfiguration {
      id
      unitName
      unitType
      configPrice
      floorArea
      bedrooms
      bathrooms
      lotArea
      unitFeatures
      unitImages {
          url
          alt
      }
  }
  developerName
  projectName
}
`;

const ALL_PROPERTIES_QUERY = `
  ${PROPERTY_FIELDS_FRAGMENT}
  query AllProperties($first: IntType) {
    allProperties(first: $first) {
      ...PropertyFields
    }
  }
`;

/**
 * Fetch all properties from DatoCMS
 */
async function fetchPropertiesFromDatoCMS() {
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
      query: ALL_PROPERTIES_QUERY,
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

  return body.data?.allProperties ?? [];
}

/**
 * Geocode a location using OpenStreetMap Nominatim API (free, no API key)
 */
async function geocodeLocation(locationQuery) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      locationQuery + ", Philippines"
    )}&format=json&limit=1`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "BahaiDealsPropertySearch/1.0", // Required by Nominatim
      },
    });

    const data = await response.json();

    if (data && data.length > 0) {
      return {
        latitude: parseFloat(data[0].lat),
        longitude: parseFloat(data[0].lon),
        displayName: data[0].display_name,
      };
    }

    return null;
  } catch (error) {
    console.error("[Geocode] Error geocoding location:", error);
    return null;
  }
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * Returns distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
}

/**
 * Build strict-filtered candidate list (no fuzzy scoring). Returns slim candidates.
 */
async function buildStrictCandidates(items, criteria, excludedIds = [], limit = 3) {
  const candidates = [];

  // Geocode the search location if provided (for distance fallback only)
  let queryCoords = null;
  if (criteria.filter_location) {
    const firstLocation = criteria.filter_location.split(",")[0].trim();
    console.log(`[Geocode] Attempting to geocode: ${firstLocation}`);
    queryCoords = await geocodeLocation(firstLocation);
    if (queryCoords) {
      console.log(
        `[Geocode] Success: ${queryCoords.displayName} (${queryCoords.latitude}, ${queryCoords.longitude})`
      );
    } else {
      console.log(`[Geocode] Failed to geocode: ${firstLocation}`);
    }
  }

  const HOUSE_UNIT_TYPES = ["house_and_lot"];
  const CONDO_UNIT_TYPES = [
    "bedroom_unit",
    "studio_open_plan",
    "loft",
    "bi_level",
    "penthouse",
  ];

  // Deterministic helpers
  const propertyMeetsPrice = (prop) => {
    if (criteria.min_price == null && criteria.max_price == null) return true;
    const p = Number.isFinite(Number(prop.price))
      ? Number(prop.price)
      : undefined;
    const unitPrices = Array.isArray(prop.unitConfiguration)
      ? prop.unitConfiguration
          .map((u) => Number(u.configPrice))
          .filter(Number.isFinite)
      : [];
    const meets = (val) => {
      if (criteria.min_price != null && criteria.max_price != null)
        return val >= criteria.min_price && val <= criteria.max_price;
      if (criteria.min_price != null) return val >= criteria.min_price;
      if (criteria.max_price != null) return val <= criteria.max_price;
      return true;
    };
    const propMeets = p != null ? meets(p) : false;
    const anyUnitMeets = unitPrices.some(meets);
    return propMeets || anyUnitMeets;
  };

  const propertyMeetsType = (prop) => {
    if (!criteria.filter_ptype) return true;
    const desiredType = String(criteria.filter_ptype).toLowerCase();
    const unitTypes = Array.isArray(prop.unitConfiguration)
      ? prop.unitConfiguration.map((u) =>
          String(u.unitType || "").toLowerCase()
        )
      : [];
    const unitHasLotArea = Array.isArray(prop.unitConfiguration)
      ? prop.unitConfiguration.some(
          (u) => typeof u.lotArea === "number" && u.lotArea > 0
        )
      : false;
    const isHouseByUnits =
      unitHasLotArea || unitTypes.some((t) => HOUSE_UNIT_TYPES.includes(t));
    const isCondoByUnits = unitTypes.some((t) => CONDO_UNIT_TYPES.includes(t));
    if (desiredType === "house") return isHouseByUnits;
    if (desiredType === "condo") return isCondoByUnits;
    return true;
  };

  const propertyMeetsBedrooms = (prop) => {
    if (criteria.min_bedrooms == null && criteria.max_bedrooms == null)
      return true;

    // Check property-level bedrooms
    const propBedrooms = Number.isFinite(Number(prop.bedrooms))
      ? Number(prop.bedrooms)
      : null;

    // Check unit-level bedrooms
    const unitBedrooms = Array.isArray(prop.unitConfiguration)
      ? prop.unitConfiguration
          .map((u) => Number(u.bedrooms))
          .filter(Number.isFinite)
      : [];

    const meets = (val) => {
      if (criteria.min_bedrooms != null && criteria.max_bedrooms != null) {
        return val >= criteria.min_bedrooms && val <= criteria.max_bedrooms;
      }
      if (criteria.min_bedrooms != null) return val >= criteria.min_bedrooms;
      if (criteria.max_bedrooms != null) return val <= criteria.max_bedrooms;
      return true;
    };

    const propMeets = propBedrooms != null ? meets(propBedrooms) : false;
    const anyUnitMeets = unitBedrooms.some(meets);
    return propMeets || anyUnitMeets;
  };

  const propertyTextContainsAnyLocation = (prop, locations) => {
    const text = (
      (prop.locationName || "") +
      " " +
      (prop.project?.name || "") +
      " " +
      (prop.developer?.fullName || "") +
      " " +
      (prop.name || "")
    ).toLowerCase();
    return locations.some((loc) => text.includes(loc));
  };

  // First pass: strict text location match if provided
  const locations = criteria.filter_location
    ? String(criteria.filter_location)
        .split(",")
        .map((loc) => loc.trim().toLowerCase())
    : null;

  for (const it of items) {
    if (excludedIds.includes(it.id)) continue;
    if (!propertyMeetsPrice(it)) continue;
    if (!propertyMeetsType(it)) continue;
    if (!propertyMeetsBedrooms(it)) continue;
    if (locations && !propertyTextContainsAnyLocation(it, locations)) continue;

    candidates.push(it);
  }

  // If location specified but nothing matched textually, and we have geocode, include within 100km
  if (locations && candidates.length === 0 && queryCoords) {
    for (const it of items) {
      if (excludedIds.includes(it.id)) continue;
      if (!propertyMeetsPrice(it)) continue;
      if (!propertyMeetsType(it)) continue;
      if (!propertyMeetsBedrooms(it)) continue;
      if (it.location?.latitude && it.location?.longitude) {
        const distanceKm = calculateDistance(
          queryCoords.latitude,
          queryCoords.longitude,
          it.location.latitude,
          it.location.longitude
        );
        if (distanceKm <= 100) {
          // Attach distance for reranker context
          it.__distanceKm = distanceKm;
          candidates.push(it);
        }
      }
    }
  }

  // Dedupe by id
  const seen = new Set();
  const deduped = [];
  for (const it of candidates) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    deduped.push(it);
  }

  // Apply sorting BEFORE capping to ensure we get the correct top K
  if (criteria.sort_by === "price_asc") {
    deduped.sort((a, b) => {
      const unitPricesA = Array.isArray(a.unitConfiguration)
        ? a.unitConfiguration
            .map((u) => Number(u.configPrice))
            .filter(Number.isFinite)
        : [];
      const unitPricesB = Array.isArray(b.unitConfiguration)
        ? b.unitConfiguration
            .map((u) => Number(u.configPrice))
            .filter(Number.isFinite)
        : [];
      const minPriceA = unitPricesA.length
        ? Math.min(...unitPricesA)
        : a.price || Infinity;
      const minPriceB = unitPricesB.length
        ? Math.min(...unitPricesB)
        : b.price || Infinity;
      return minPriceA - minPriceB;
    });
  } else if (criteria.sort_by === "price_desc") {
    deduped.sort((a, b) => {
      const unitPricesA = Array.isArray(a.unitConfiguration)
        ? a.unitConfiguration
            .map((u) => Number(u.configPrice))
            .filter(Number.isFinite)
        : [];
      const unitPricesB = Array.isArray(b.unitConfiguration)
        ? b.unitConfiguration
            .map((u) => Number(u.configPrice))
            .filter(Number.isFinite)
        : [];
      const maxPriceA = unitPricesA.length
        ? Math.max(...unitPricesA)
        : a.price || 0;
      const maxPriceB = unitPricesB.length
        ? Math.max(...unitPricesB)
        : b.price || 0;
      return maxPriceB - maxPriceA;
    });
  }

  // Cap for cost control and respect user's requested count
  // Max 12 for payload size, but use requested limit if smaller
  const K = Math.min(limit, 12);
  const capped = deduped.slice(0, K);
  console.log(`[Build Candidates] Capping to ${K} properties (requested: ${limit}, max: 12)`);

  // Build slim payload for reranker
  const slim = capped.map((p) => {
    const unitPrices = Array.isArray(p.unitConfiguration)
      ? p.unitConfiguration
          .map((u) => Number(u.configPrice))
          .filter(Number.isFinite)
      : [];
    const minUnitPrice = unitPrices.length ? Math.min(...unitPrices) : null;
    const maxUnitPrice = unitPrices.length ? Math.max(...unitPrices) : null;
    const unitTypeSummary = Array.isArray(p.unitConfiguration)
      ? [
          ...new Set(
            p.unitConfiguration
              .map((u) => String(u.unitType || "").toLowerCase())
              .filter(Boolean)
          ),
        ]
      : [];
    // Limit amenitiesTags to first 8 items and truncate each to max 100 chars to reduce payload size
    const amenitiesTagsFull = [
      ...(Array.isArray(p.searchTags)
        ? p.searchTags
        : p.searchTags
        ? [p.searchTags]
        : []),
      ...(Array.isArray(p.secondaryTags)
        ? p.secondaryTags
        : p.secondaryTags
        ? [p.secondaryTags]
        : []),
    ];
    const amenitiesTags = amenitiesTagsFull
      .slice(0, 8)
      .map((tag) => String(tag).slice(0, 100));

    return {
      id: p.id,
      name: p.name || "",
      locationName: p.locationName || "",
      price: Number.isFinite(Number(p.price)) ? Number(p.price) : null,
      minUnitPrice,
      maxUnitPrice,
      bedrooms: Number.isFinite(Number(p.bedrooms)) ? Number(p.bedrooms) : null,
      bathrooms: Number.isFinite(Number(p.bathrooms))
        ? Number(p.bathrooms)
        : null,
      developer:
        p.developer?.fullName || p.project?.developer?.shortName || null,
      unitTypeSummary,
      amenitiesTags,
      distanceKm: typeof p.__distanceKm === "number" ? p.__distanceKm : null,
    };
  });

  // Sorting already applied before capping, so slim array is already in the correct order

  return {
    candidates: slim,
    referenceLocation: queryCoords ? queryCoords.displayName : null,
  };
}

/**
 * Query Analyzer Tool
 * Extracts search criteria from user queries
 */
export const queryAnalyzerTool = tool({
  name: "analyze_query",
  description: `Analyze a real estate query and extract structured search criteria.
    
Use this tool to understand what the user is looking for before searching properties.
For follow-up queries, include the conversation history in the query parameter.
Returns a JSON object with extracted criteria like bedrooms, price, location, etc.`,
  parameters: z.object({
    query: z
      .string()
      .describe(
        "The user's property search query. For follow-ups, include conversation history."
      ),
  }),
  execute: async ({ query }) => {
    console.log("[Query Analyzer Tool] Analyzing query:", query);

		const prompt = fs.readFileSync(path.join(__dirname, '../prompts/query-analyzer.md'), 'utf-8');

    // Create a simple agent for query analysis
    const analyzerAgent = new Agent({
      name: "Query Analyzer",
      instructions: prompt,
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0, // Most deterministic/fastest
      max_tokens: 1000, // Limit response size
    });

    const result = await run(analyzerAgent, query);
    const output = result.finalOutput || "";

    // Extract JSON from response
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");

    const parsed = JSON.parse(jsonMatch[0]);

    // If AI didn't populate filter_location, try geocoding the query
    // If geocoding succeeds, it's likely a location query
    if (
      !parsed.apiSearchParams?.filter_location &&
      parsed.apiSearchParams?.query
    ) {
      const query = parsed.apiSearchParams.query;

      // Skip geocoding for generic real estate words and property types
      const genericWords = [
        "property",
        "properties",
        "condo",
        "condos",
        "house",
        "houses",
        "apartment",
        "apartments",
        "unit",
        "units",
        "home",
        "homes",
        "listing",
        "listings",
        "real estate",
        "investment",
        "studio",
        "bachelor pad",
        "bachelor's pad",
        "loft",
        "penthouse",
        "townhouse",
        "duplex",
        "bi-level",
      ];
      const isGenericQuery = genericWords.some(
        (word) =>
          query.toLowerCase() === word || query.toLowerCase().includes(word)
      );

      if (!isGenericQuery) {
        // Try geocoding - if it works, treat it as a location
        console.log(
          `[Query Analyzer Tool] Attempting to geocode query for fallback: "${query}"`
        );
        const geocodeResult = await geocodeLocation(query);

        if (geocodeResult) {
          // Geocoding succeeded - it's a valid location
          parsed.apiSearchParams.filter_location = query;
          console.log(
            `[Query Analyzer Tool] Geocoding succeeded, using as filter_location: "${query}" → ${geocodeResult.displayName}`
          );
        } else {
          console.log(
            `[Query Analyzer Tool] Geocoding failed, keeping query as-is`
          );
        }
      } else {
        console.log(
          `[Query Analyzer Tool] Skipping geocoding for generic word: "${query}"`
        );
      }
    }

    console.log("[Query Analyzer Tool] Extracted criteria:", parsed);

    return JSON.stringify(parsed.apiSearchParams || parsed);
  },
});

/**
 * Search Properties Tool
 * Searches DatoCMS for properties matching the criteria
 */
export const searchPropertiesTool = tool({
  name: "search_properties",
  description: `Search for real estate properties in the Philippines based on search criteria.

Use this tool AFTER analyzing the query with analyze_query tool.
Takes structured criteria and returns matching properties (default: 3 results, max: 10 if requested_count is specified).

IMPORTANT: The criteria JSON can include an "excludedPropertyIds" array to avoid repeating properties. Extract property IDs from previous responses (propertyId="...") and add them to criteria.`,
  parameters: z.object({
    criteria: z
      .string()
      .describe(
        "JSON string of search criteria from analyze_query tool. Can include excludedPropertyIds array."
      ),
  }),
  execute: async ({ criteria }) => {
    console.log("[Search Properties Tool] Searching with criteria:", criteria);

    let structuredCriteria;
    try {
      structuredCriteria =
        typeof criteria === "string" ? JSON.parse(criteria) : criteria;
    } catch (error) {
      console.error("[Search Properties Tool] Invalid criteria JSON");
      structuredCriteria = { query: criteria };
    }

    // Use requested_count from criteria, default to 3, max 10
    const limit = Math.min(
      Math.max(1, structuredCriteria.requested_count || 3),
      10
    );
    console.log("[Search Properties Tool] Using limit:", limit);

    // Normalize legacy/nested price shape: { price: { min, max } } → { min_price, max_price }
    if (
      structuredCriteria &&
      typeof structuredCriteria === "object" &&
      structuredCriteria.price &&
      typeof structuredCriteria.price === "object"
    ) {
      const possibleMin =
        structuredCriteria.price.min ?? structuredCriteria.price.minimum;
      const possibleMax =
        structuredCriteria.price.max ?? structuredCriteria.price.maximum;
      if (
        structuredCriteria.min_price == null &&
        Number.isFinite(Number(possibleMin))
      ) {
        structuredCriteria.min_price = Number(possibleMin);
      }
      if (
        structuredCriteria.max_price == null &&
        Number.isFinite(Number(possibleMax))
      ) {
        structuredCriteria.max_price = Number(possibleMax);
      }
    }

    // Check if query analyzer marked this as non-real estate
    if (structuredCriteria.query === "NOT_REAL_ESTATE") {
      console.log(
        "[Search Properties Tool] Non-real estate query detected, returning 0 properties"
      );
      return JSON.stringify({
        results: [],
        message: "NOT_REAL_ESTATE_QUERY",
      });
    }

    // Get excluded property IDs from criteria (if agent provided them)
    const excludedIds = structuredCriteria.excludedPropertyIds || [];
    if (excludedIds.length > 0) {
      console.log(
        "[Search Properties Tool] Excluding",
        excludedIds.length,
        "previously shown properties"
      );
    }

    const allProperties = await fetchPropertiesFromDatoCMS();

    // Always build strict candidates (deterministic filters only)
    const { candidates, referenceLocation } = await buildStrictCandidates(
      allProperties,
      structuredCriteria,
      excludedIds,
      limit
    );

    // Prepare output shape: candidates for reranker + metadata
    const out = {
      candidates,
      count: candidates.length,
      // downstream presenter will slice using reranker order and requested_count
      referenceLocation,
    };

    console.log(
      `[Search Properties Tool] Returning ${out.count} candidates (strict)`
    );
    return JSON.stringify(out);
  },
});

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Call OpenAI embeddings API to get embeddings (supports batch)
 */
async function getEmbeddings(inputs) {
  try {
    const inputArray = Array.isArray(inputs) ? inputs : [inputs];
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: inputArray,
      encoding_format: "float",
    });
    
    // Return array of embeddings
    return response.data.map(d => d.embedding);
  } catch (error) {
    console.log('[Embeddings] Error calling OpenAI API:', error.message);
    return null;
  }
}

/**
 * Call OpenAI embeddings API to get query embedding
 */
async function getQueryEmbedding(query) {
  const embeddings = await getEmbeddings(query);
  return embeddings ? embeddings[0] : null;
}

/**
 * Embeddings-based ranking using cosine similarity
 */
async function rankByEmbeddings(candidates, criteria) {
  const params = criteria.apiSearchParams || criteria;
  
  // Build search query text for embedding
  const queryParts = [];
  if (params.query) queryParts.push(params.query);
  if (params.filter_location) queryParts.push(`in ${params.filter_location}`);
  if (params.min_bedrooms) queryParts.push(`${params.min_bedrooms} bedroom`);
  if (params.filter_ptype) queryParts.push(params.filter_ptype);
  
  // Fallback: if no query parts, create generic query
  if (queryParts.length === 0) {
    queryParts.push('properties');
    if (params.must_have_amenities) {
      queryParts.push('with amenities');
    }
  }
  
  const queryText = queryParts.join(' ');
  console.log('[Embeddings] Embedding query:', queryText);
  
  // Validate query text is not empty
  if (!queryText || queryText.trim().length === 0) {
    console.log('[Embeddings] Query text is empty, cannot generate embedding');
    return null;
  }
  
  // Get query embedding
  const queryEmbedding = await getQueryEmbedding(queryText);
  if (!queryEmbedding) {
    console.log('[Embeddings] Failed to get query embedding, falling back');
    return null;
  }
  
  // Build property texts for embeddings
  const propertyTexts = candidates.map((candidate) => {
    const amenitiesText = (candidate.amenitiesTags || []).join(', ');
    const priceText = candidate.price ? `₱${(candidate.price / 1000000).toFixed(1)}M` : '';
    
    return [
      candidate.name,
      candidate.locationName,
      candidate.developer,
      `${candidate.bedrooms} bedroom ${candidate.bathrooms} bathroom`,
      candidate.unitTypeSummary?.join(', '),
      priceText,
      `Amenities: ${amenitiesText}`,
    ].filter(Boolean).join('. ');
  });
  
  // Check if any candidates have pre-computed embeddings
  const needsEmbedding = candidates.filter(c => !c.embedding || !Array.isArray(c.embedding));
  
  let propertyEmbeddings = [];
  
  if (needsEmbedding.length > 0) {
    // Generate embeddings for properties that don't have them
    console.log(`[Embeddings] Generating embeddings for ${needsEmbedding.length} properties...`);
    const textsToEmbed = needsEmbedding.map(c => {
      const idx = candidates.indexOf(c);
      return propertyTexts[idx];
    });
    
    propertyEmbeddings = await getEmbeddings(textsToEmbed);
    
    if (!propertyEmbeddings) {
      console.log('[Embeddings] Failed to generate property embeddings, falling back');
      return null;
    }
  }
  
  // Score each candidate using cosine similarity
  let embeddingIdx = 0;
  const scored = candidates.map((candidate) => {
    let similarity = 0;
    
    // Use pre-computed embedding if available, otherwise use freshly generated one
    if (candidate.embedding && Array.isArray(candidate.embedding)) {
      similarity = cosineSimilarity(queryEmbedding, candidate.embedding);
    } else {
      similarity = cosineSimilarity(queryEmbedding, propertyEmbeddings[embeddingIdx]);
      embeddingIdx++;
    }
    
    // Convert similarity (0-1) to score (50-100)
    const score = Math.round(50 + (similarity * 50));
    
    // Generate reason based on similarity and property features
    const reasonParts = [];
    
    // Add specific features first
    if (params.filter_location && candidate.locationName?.includes(params.filter_location)) {
      reasonParts.push(`Located in ${params.filter_location}`);
    } else if (candidate.distanceKm) {
      reasonParts.push(`${candidate.distanceKm}km from your search area`);
    } else if (candidate.locationName) {
      reasonParts.push(`In ${candidate.locationName}`);
    }
    
    if (params.min_bedrooms === candidate.bedrooms) {
      reasonParts.push(`${candidate.bedrooms}-bedroom as requested`);
    } else if (candidate.bedrooms) {
      reasonParts.push(`${candidate.bedrooms}-bedroom unit`);
    }
    
    if (params.max_price && candidate.price) {
      const ratio = candidate.price / params.max_price;
      if (ratio <= 0.8) reasonParts.push('excellent value');
      else if (ratio <= 1) reasonParts.push('within budget');
    }
    
    if (candidate.developer) {
      reasonParts.push(`by ${candidate.developer}`);
    }
    
    // If we have enough specific features, use them
    // Otherwise add a quality prefix based on similarity
    let reason = '';
    if (reasonParts.length >= 2) {
      reason = reasonParts.slice(0, 3).join(', ');
    } else {
      // Add quality prefix only if we don't have enough specific features
      if (similarity > 0.8) {
        reason = 'Excellent match: ' + reasonParts.join(', ');
      } else if (similarity > 0.6) {
        reason = 'Great option: ' + reasonParts.join(', ');
      } else {
        reason = 'Quality property: ' + reasonParts.join(', ');
      }
    }
    
    return {
      id: candidate.id,
      score,
      similarity,
      reason: reason,
    };
  });
  
  // Sort by similarity descending
  scored.sort((a, b) => b.similarity - a.similarity);
  
  console.log(
    `[Embeddings] Ranked ${scored.length} properties. Top similarity: ${scored[0]?.similarity.toFixed(3)}`
  );
  
  return {
    orderedIds: scored.map((s) => s.id),
    reasonsById: Object.fromEntries(scored.map((s) => [s.id, s.reason])),
    scoresById: Object.fromEntries(scored.map((s) => [s.id, s.score])),
  };
}

/**
 * Rerank Properties Tool
 * Orders candidates by relevance and returns reasons per id
 */
export const rerankPropertiesTool = tool({
  name: "rerank_properties",
  description: `Given structured criteria and a list of candidate properties (slim), order them by relevance and provide short reasons per id. Use for tie-breaking, amenity synonyms, intent nuances (investment, family-friendly), and combining signals like distance and price fit.`,
  parameters: z.object({
    criteriaJson: z
      .string()
      .describe(
        "JSON string of search criteria used; same shape produced by analyze_query."
      ),
    candidatesJson: z
      .string()
      .describe("JSON string array of slim candidates from search_properties."),
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
    const hasSpecificLocation = params.filter_location && params.filter_location.trim().length > 0;
    
    console.log(
      `[Rerank Tool] Processing ${candidates.length} candidates. Location: ${hasSpecificLocation ? params.filter_location : 'none'}`
    );

    // STRATEGY 1: Embeddings-based ranking for 4-10 properties (middle tier)
    // Fast (~50-100ms) with semantic understanding
    if (candidates.length >= 4 && candidates.length <= 10) {
      console.log('[Rerank Tool] Trying embeddings-based ranking...');
      const embeddingsResult = await rankByEmbeddings(candidates, criteria);
      
      if (embeddingsResult) {
        console.log('[Rerank Tool] Embeddings ranking successful');
        return JSON.stringify(embeddingsResult);
      }
      
      console.log('[Rerank Tool] Embeddings failed, falling back to LLM');
    }

    // STRATEGY 2: LLM-based ranking for complex cases or >10 properties
    console.log(
      `[Rerank Tool] Using LLM ranking (${candidates.length} properties)`
    );

		const prompt = fs.readFileSync(path.join(__dirname, '../prompts/reranker.md'), 'utf-8');

    const reranker = new Agent({
      name: "Property Reranker",
      instructions: prompt,
      model: "gpt-4o-mini",
      // Use structured output for faster JSON parsing
      response_format: { type: "json_object" },
      temperature: 0, // Most deterministic/fastest
      max_tokens: 1000, // Limit response size
    });

    const input = `CRITERIA\n${JSON.stringify(
      criteria
    )}\n\nCANDIDATES\n${JSON.stringify(candidates)}`;
    const result = await run(reranker, input);
    let output = result.finalOutput || "";

    // Strip markdown code blocks if present (```json ... ```)
    output = output.replace(/```(?:json)?\s*/g, "").trim();

    // Parse the JSON response
    try {
      const parsed = JSON.parse(output);
      // Validate that we have orderedIds array
      if (!Array.isArray(parsed.orderedIds)) {
        console.log(
          "[Rerank Properties Tool] Invalid orderedIds, using fallback"
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
        "[Rerank Properties Tool] JSON parse error, using fallback:",
        parseError.message
      );
      // Try to extract JSON object from the string
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
