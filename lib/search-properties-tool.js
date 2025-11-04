/**
 * search-properties-tool.js
 * Server-side property search for Bahai Assistant
 */

import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";

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

    const prompt = `You are a real estate query analyzer. Analyze user queries and respond with JSON:

{
  "apiSearchParams": {
    "query": string,
    "filter_location": string | null,
    "filter_ptype": string | null,
    "filter_developer": string | null,
    "filter_project": string | null,
    "min_bedrooms": number | null,
    "max_bedrooms": number | null,
    "min_bathrooms": number | null,
    "max_bathrooms": number | null,
    "min_price": number | null,
    "max_price": number | null,
    "must_have_amenities": string[] | null,
    "sort_by": "price_asc" | "price_desc" | null,
    "requested_count": number | null
  },
  "isFollowUp": boolean,
  "referencedProperty": string | null,
  "locationCorrection": {
    "original": string | null,
    "corrected": string | null
  } | null
}

RULES:

0. QUERY FIELD (IMPORTANT):
   - The "query" field should be a cleaned version of the user's search intent
   - Keep it descriptive, NOT just "properties" or "property"
   - Examples:
     • "What can I buy for under ₱3M?" → query: "affordable property under 3M"
     • "Show me condos in Makati" → query: "condos in Makati"
     • "Investment property with high rental yield" → query: "investment property high rental yield"
     • "Cheapest house" → query: "cheapest house"
   - AVOID generic single words like "properties", "homes", "listings"

1. QUERY FILTERING (CRITICAL):
   
   NON-REAL ESTATE QUERIES (should be declined):
   - If query is asking for restaurants, stores, landmarks, directions:
     • "nearby Jollibee near Shore residences" → NOT real estate (looking for restaurant)
     • "Where is the nearest SM Mall?" → NOT real estate (looking for mall location)
     • "How to get to BGC?" → NOT real estate (asking for directions)
   - **CRITICAL**: If non-real estate, set query to "NOT_REAL_ESTATE" and all other fields to null
     • This signals the agent to decline the query and redirect to real estate
   
   MIXED QUERIES (extract only real estate part):
   - If query contains BOTH real estate and non-real estate requests:
     • "Find me a condo in Cebu and tell me a joke" → Extract: "Find me a condo in Cebu"
     • "Show me properties near Jollibee and what time is it?" → Extract: "properties near Jollibee" (Jollibee is landmark context)
   
   KEY DISTINCTION:
   - "nearby Jollibee" (subject is Jollibee) → NOT real estate ❌
   - "properties near Jollibee" (subject is properties) → Real estate ✅
   - "Where is Shore residences?" (asking for location) → NOT real estate ❌
   - "What properties are in Shore residences?" (asking for properties) → Real estate ✅

2. LOCATION HANDLING:
   
   **CRITICAL - DO NOT confuse property types with locations:**
   - "bachelor pad", "studio", "condo", "house", "loft", "penthouse" are PROPERTY TYPES, NOT locations
   - If the query is ONLY a property type with no location mentioned, set filter_location: null
   - Example: "Looking for a bachelor pad" → filter_location: null, filter_ptype: "condo"
   - Example: "bachelor pad in Makati" → filter_location: "Makati", filter_ptype: "condo"
   
   MISSPELLING CORRECTIONS (set locationCorrection if corrected):
   - "tagueg" → "taguig", "paseg" → "pasig", "marikena" → "marikina"
   - "paranaque" → "parañaque", "las pinas" → "las piñas"
   - "[city] city" → "[city]" for major cities
   - If you correct a misspelling, set locationCorrection: { original: "tagueg", corrected: "taguig" }
   - If no correction needed, set locationCorrection: null
   
   LANDMARK MAPPING:
   - "Greenbelt" → "Makati", "MOA" → "Pasay", "BGC" → "Taguig"
   - "Ortigas" → "Pasig", "Eastwood" → "Quezon City", "Alabang" → "Muntinlupa"
   
   REGIONAL EXPANSION (CRITICAL - expand regions to provinces for text matching):
   - "MIMAROPA" or "Region IV-B" → "Palawan, Occidental Mindoro, Oriental Mindoro, Marinduque, Romblon"
   - "CALABARZON" or "Region IV-A" → "Cavite, Laguna, Batangas, Rizal, Quezon"
   - "Central Luzon" or "Region III" → "Pampanga, Bulacan, Nueva Ecija, Tarlac, Bataan, Zambales, Aurora"
   - "NCR" or "Metro Manila" → "Manila, Quezon City, Makati, Pasig, Taguig, Mandaluyong, Pasay, Muntinlupa, Parañaque, Las Piñas, Marikina, Valenzuela, Caloocan, Malabon, Navotas, San Juan"
   - For other single locations (e.g., "Makati", "Cebu"), keep as-is
   
   CONTEXT EXTRACTION:
   - "near schools in Cebu" → "Cebu"
   - "around malls in BGC" → "Taguig"
   - Ignore non-location words: "schools", "malls", "near", "around"

3. PROPERTY TYPE MAPPING:
   - "studio"/"bachelor pad"/"bachelor's pad" → filter_ptype: "condo", min_bedrooms: 0, max_bedrooms: 0
   - "apartment"/"condo"/"unit" → "condo"
   - "house"/"townhouse"/"house and lot" → "house"
   - "loft" → "condo"
   - "penthouse" → "condo"
	 - "bi-level"/"duplex" → "condo"

4. BEDROOM/BATHROOM EXTRACTION:
   - "3-bedroom", "3BR", "3 bed" → min_bedrooms: 3, max_bedrooms: 3
   - "studio" → min_bedrooms: 0, max_bedrooms: 0
   - "at least 2", "2+" → min_bedrooms: 2, max_bedrooms: null
   - "up to 3", "3 or less" → min_bedrooms: null, max_bedrooms: 3
   - "2.5 baths" → min_bathrooms: 2, max_bathrooms: 2 (round down)
   - Range "2-4 bedrooms" → min_bedrooms: 2, max_bedrooms: 4
   - **AMBIGUOUS QUERIES**:
     • "some bedrooms", "with bedrooms", "multiple bedrooms" → min_bedrooms: 2, max_bedrooms: null
     • "few bedrooms" → min_bedrooms: 1, max_bedrooms: 3
     • "many bedrooms", "several bedrooms" → min_bedrooms: 3, max_bedrooms: null
     • If just "bedrooms" mentioned without number → assume min_bedrooms: 1 (exclude studios)

5. PRICE RANGE EXTRACTION (in PHP):
   - "₱2M to ₱5M" → min_price: 2000000, max_price: 5000000
   - "under ₱3M"/"below ₱3M" → max_price: 3000000
   - "above ₱2M"/"over ₱2M" → min_price: 2000000
   - Convert: "M" = million, "K" = thousand

6. PRICE SORTING:
   - "cheapest"/"lowest"/"affordable" → sort_by: "price_asc"
   - "expensive"/"highest"/"luxury" → sort_by: "price_desc"
   - **CRITICAL**: When query asks for "lowest price", "cheapest", "most affordable":
     • ALWAYS set sort_by: "price_asc" (this is mandatory for price-based queries)
     • Examples:
       - "What property has the lowest price?" → sort_by: "price_asc", requested_count: 1
       - "Show me the cheapest properties" → sort_by: "price_asc", requested_count: null
       - "Top 5 lowest prices" → sort_by: "price_asc", requested_count: 5

7. COUNT EXTRACTION (DO THIS FIRST):
   - "top 5", "show 10", "first 3" → requested_count: (number, max 10)
   - Convert words: "three" → 3
   - Default: null if not mentioned
   - **IMPORTANT**: If an explicit count is mentioned (e.g., "top 5 lowest"), use that count, NOT 1
   - **ONLY set requested_count: 1** when query asks for "THE lowest" or "THE cheapest" WITHOUT any explicit number
     • "What property has the lowest price?" → sort_by: "price_asc", requested_count: 1
     • "Top 5 lowest prices" → sort_by: "price_asc", requested_count: 5 (explicit count takes priority)
     • "Show me the cheapest ones" → sort_by: "price_asc", requested_count: null (plural, no specific count)

8. FOLLOW-UP DETECTION:
   - Only set isFollowUp: true if conversation history contains prior property search keywords
   - Preserve previous criteria unless explicitly overridden
   - Examples: "show me cheaper ones", "what about BGC instead"
   - Look at the conversation history to understand context

8. DEVELOPERS:
   - "SMDC", "Greenfield", "Eton", "Robinsons Land", "Ayala Land"
   - "Megaworld", "DMCI", "Rockwell", "Federal Land", "Century Properties"

9. PROJECTS:
   - "The Trion Towers", "Arya Residences", "Greenbelt Residences"
   - "Rockwell Center", "BGC", "Nuvali", "Eastwood City"

10. AMENITIES:
    - "pool" → "swimming_pool", "gym" → "fitness_center"
    - "parking" → "parking", "balcony" → "balcony"
    - "security" → "security", "elevator" → "elevator"

Only return valid JSON—no extra commentary.`;

    // Create a simple agent for query analysis
    const analyzerAgent = new Agent({
      name: "Query Analyzer",
      instructions: prompt,
      model: "gpt-4o-mini",
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
 * Client-side scoring function for fast property ranking
 */
function calculatePropertyScore(candidate, criteria) {
  let score = 70; // Base score
  const params = criteria.apiSearchParams || criteria;

  // Price match (weight: 20 points)
  if (params.max_price && candidate.price) {
    const priceRatio = candidate.price / params.max_price;
    if (priceRatio <= 0.7) {
      score += 20; // Great value
    } else if (priceRatio <= 0.9) {
      score += 15; // Good value
    } else if (priceRatio <= 1.0) {
      score += 10; // Within budget
    } else {
      score -= 5; // Over budget
    }
  }

  // Exact bedroom match (weight: 15 points)
  if (params.min_bedrooms !== undefined && candidate.bedrooms !== undefined) {
    if (
      candidate.bedrooms >= params.min_bedrooms &&
      (!params.max_bedrooms || candidate.bedrooms <= params.max_bedrooms)
    ) {
      if (candidate.bedrooms === params.min_bedrooms) {
        score += 15; // Exact match
      } else {
        score += 10; // Within range
      }
    }
  }

  // Distance match (weight: 15 points)
  if (candidate.distanceKm !== undefined) {
    if (candidate.distanceKm < 2) {
      score += 15; // Right there
    } else if (candidate.distanceKm < 5) {
      score += 12; // Very close
    } else if (candidate.distanceKm < 15) {
      score += 8; // Nearby
    } else if (candidate.distanceKm < 50) {
      score += 4; // Within area
    }
  }

  // Bathroom match (weight: 10 points)
  if (params.min_bathrooms !== undefined && candidate.bathrooms !== undefined) {
    if (
      candidate.bathrooms >= params.min_bathrooms &&
      (!params.max_bathrooms || candidate.bathrooms <= params.max_bathrooms)
    ) {
      score += 10;
    }
  }

  // Amenities match (weight: 10 points)
  const mustHave = params.must_have_amenities || [];
  if (mustHave.length > 0 && candidate.amenitiesTags) {
    const amenityTags = candidate.amenitiesTags.map((a) => a.toLowerCase());
    const matches = mustHave.filter((a) =>
      amenityTags.some((tag) => tag.includes(a.toLowerCase()))
    );
    if (matches.length > 0) {
      score += (matches.length / mustHave.length) * 10;
    }
  }

  // Property type match (weight: 5 points)
  if (
    params.filter_ptype &&
    candidate.unitTypeSummary &&
    candidate.unitTypeSummary.toLowerCase().includes(params.filter_ptype.toLowerCase())
  ) {
    score += 5;
  }

  return Math.min(100, Math.max(50, Math.round(score)));
}

/**
 * Generate natural language reason for ranking
 */
function generateRankingReason(candidate, criteria, score) {
  const parts = [];
  const params = criteria.apiSearchParams || criteria;

  // Price reasoning
  if (params.max_price && candidate.price) {
    const priceRatio = candidate.price / params.max_price;
    if (priceRatio <= 0.7) {
      parts.push("excellent value, well within budget");
    } else if (priceRatio <= 0.9) {
      parts.push("comfortably fits your budget");
    } else if (priceRatio <= 1.0) {
      parts.push("within budget");
    }
  }

  // Location reasoning
  if (candidate.distanceKm !== undefined && params.filter_location) {
    if (candidate.distanceKm < 2) {
      parts.push(`right in ${params.filter_location}`);
    } else if (candidate.distanceKm < 10) {
      parts.push(`${candidate.distanceKm}km from ${params.filter_location}`);
    } else if (candidate.distanceKm < 50) {
      parts.push(`nearby option, ${candidate.distanceKm}km away`);
    }
  } else if (
    candidate.locationName &&
    params.filter_location &&
    candidate.locationName.toLowerCase().includes(params.filter_location.toLowerCase())
  ) {
    parts.push(`in ${params.filter_location}`);
  }

  // Bedrooms reasoning
  if (params.min_bedrooms !== undefined && candidate.bedrooms !== undefined) {
    if (candidate.bedrooms === params.min_bedrooms) {
      parts.push(`${candidate.bedrooms}-bedroom as requested`);
    } else if (candidate.bedrooms) {
      parts.push(`${candidate.bedrooms}-bedroom unit`);
    }
  }

  // Amenities reasoning
  const mustHave = params.must_have_amenities || [];
  if (mustHave.length > 0 && candidate.amenitiesTags) {
    const amenityTags = candidate.amenitiesTags.map((a) => a.toLowerCase());
    const matches = mustHave.filter((a) =>
      amenityTags.some((tag) => tag.includes(a.toLowerCase()))
    );
    if (matches.length === mustHave.length) {
      parts.push("has all desired amenities");
    } else if (matches.length > 0) {
      const readable = matches.map(a => a.replace(/_/g, ' ')).join(', ');
      parts.push(`includes ${readable}`);
    }
  }

  // Developer mention
  if (candidate.developer) {
    parts.push(`by ${candidate.developer}`);
  }

  // Score-based prefix
  let prefix = "";
  if (score >= 95) {
    prefix = "Perfect match: ";
  } else if (score >= 85) {
    prefix = "Excellent choice: ";
  } else if (score >= 75) {
    prefix = "Good fit: ";
  }

  // Combine parts, limit to 120 chars
  const reason = prefix + parts.slice(0, 3).join(", ");
  return reason.length > 120 ? reason.substring(0, 117) + "..." : reason;
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

    // Check if query has specific location requirement
    const params = criteria.apiSearchParams || criteria;
    const hasSpecificLocation = params.filter_location && params.filter_location.trim().length > 0;
    
    console.log(
      `[Rerank Tool] Processing ${candidates.length} candidates. Location-specific: ${hasSpecificLocation}`
    );

    // STRATEGY 1: Fast template-based ranking ONLY for non-location queries with ≤5 properties
    // Location-specific queries need LLM to properly understand proximity/relevance
    if (candidates.length <= 5 && !hasSpecificLocation) {
      const scored = candidates.map((c) => {
        const score = calculatePropertyScore(c, criteria);
        const reason = generateRankingReason(c, criteria, score);
        return {
          id: c.id,
          score,
          reason,
        };
      });

      // Sort by score descending
      scored.sort((a, b) => b.score - a.score);

      console.log(
        `[Rerank Tool] Fast ranking complete in <1ms. Top score: ${scored[0]?.score}`
      );

      return JSON.stringify({
        orderedIds: scored.map((s) => s.id),
        reasonsById: Object.fromEntries(scored.map((s) => [s.id, s.reason])),
        scoresById: Object.fromEntries(scored.map((s) => [s.id, s.score])),
      });
    }

    // STRATEGY 2: LLM-based ranking for location-specific queries or >5 properties
    console.log(
      `[Rerank Tool] Using LLM ranking for ${hasSpecificLocation ? 'location-specific' : 'complex'} query`
    );

    const prompt = `You are a real estate reranker. You receive a user intent and a list of candidates with slim fields. Order them from best to worst, provide a relevance score (0-100), and explain briefly why each fits.

Return ONLY valid JSON with this shape:
{
  "orderedIds": string[],
  "reasonsById": { [id: string]: string },
  "scoresById": { [id: string]: number }
}

Guidelines:
- Assign a relevance score from 0-100 for each property based on how well it matches the criteria
  • 90-100: Perfect match (meets all criteria, ideal fit)
  • 80-89: Excellent match (meets most criteria, minor trade-offs)
  • 70-79: Good match (meets key criteria, some compromises)
  • 60-69: Decent match (partially meets criteria)
  • Below 60: Poor match (barely meets criteria)
- Prefer exact budget fits; if only max_price given, prefer lower-priced matches.
- Respect requested_count when present (but you still return the full ordering; the agent will slice).
- Consider unitTypeSummary against filter_ptype.
- Consider distanceKm when provided (closer is better), but do NOT select properties that violate location hard filter — they were already filtered.
- Use amenitiesTags to satisfy must_have_amenities if present (handle synonyms like pool→swimming_pool, gym→fitness_center).
- Consider bedrooms/bathrooms fits if present.
- Keep reasons very short (≤120 chars).`;

    const reranker = new Agent({
      name: "Property Reranker",
      instructions: prompt,
      model: "gpt-3.5-turbo",
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
