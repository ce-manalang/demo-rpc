/**
 * search-properties-tool.js
 * Server-side property search for Bahai Assistant
 */

import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

const DATOCMS_API_TOKEN = process.env.DATOCMS_READONLY_API_TOKEN;
const DATOCMS_API_ENDPOINT = process.env.DATOCMS_API_ENDPOINT || 'https://graphql.datocms.com/';
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
        throw new Error('DATOCMS_READONLY_API_TOKEN not set in env');
    }

    const res = await fetch(DATOCMS_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${DATOCMS_API_TOKEN}`,
            ...(DATOCMS_ENVIRONMENT && { 'X-Environment': DATOCMS_ENVIRONMENT }),
        },
        body: JSON.stringify({ query: ALL_PROPERTIES_QUERY, variables: { first: MAX_FETCH } }),
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`DatoCMS fetch error: ${res.status} ${txt}`);
    }

    const body = await res.json();
    if (body.errors) {
        throw new Error('DatoCMS GraphQL errors: ' + JSON.stringify(body.errors));
    }

    return body.data?.allProperties ?? [];
}

/**
 * Geocode a location using OpenStreetMap Nominatim API (free, no API key)
 */
async function geocodeLocation(locationQuery) {
    try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationQuery + ', Philippines')}&format=json&limit=1`;
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'BahaiDealsPropertySearch/1.0', // Required by Nominatim
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
        console.error('[Geocode] Error geocoding location:', error);
        return null;
    }
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * Returns distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    
    return distance;
}

/**
* Build strict-filtered candidate list (no fuzzy scoring). Returns slim candidates.
*/
async function buildStrictCandidates(items, criteria, excludedIds = []) {
    const candidates = [];

    // Geocode the search location if provided (for distance fallback only)
    let queryCoords = null;
    if (criteria.filter_location) {
        const firstLocation = criteria.filter_location.split(',')[0].trim();
        console.log(`[Geocode] Attempting to geocode: ${firstLocation}`);
        queryCoords = await geocodeLocation(firstLocation);
        if (queryCoords) {
            console.log(`[Geocode] Success: ${queryCoords.displayName} (${queryCoords.latitude}, ${queryCoords.longitude})`);
        } else {
            console.log(`[Geocode] Failed to geocode: ${firstLocation}`);
        }
    }

    const HOUSE_UNIT_TYPES = ['house_and_lot'];
    const CONDO_UNIT_TYPES = ['bedroom_unit', 'studio_open_plan', 'loft', 'bi_level', 'penthouse'];

    // Deterministic helpers
    const propertyMeetsPrice = (prop) => {
        if (criteria.min_price == null && criteria.max_price == null) return true;
        const p = Number.isFinite(Number(prop.price)) ? Number(prop.price) : undefined;
        const unitPrices = Array.isArray(prop.unitConfiguration)
            ? prop.unitConfiguration.map(u => Number(u.configPrice)).filter(Number.isFinite)
            : [];
        const meets = (val) => {
            if (criteria.min_price != null && criteria.max_price != null) return val >= criteria.min_price && val <= criteria.max_price;
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
            ? prop.unitConfiguration.map(u => String(u.unitType || '').toLowerCase())
            : [];
        const unitHasLotArea = Array.isArray(prop.unitConfiguration)
            ? prop.unitConfiguration.some(u => typeof u.lotArea === 'number' && u.lotArea > 0)
            : false;
        const isHouseByUnits = unitHasLotArea || unitTypes.some(t => HOUSE_UNIT_TYPES.includes(t));
        const isCondoByUnits = unitTypes.some(t => CONDO_UNIT_TYPES.includes(t));
        if (desiredType === 'house') return isHouseByUnits;
        if (desiredType === 'condo') return isCondoByUnits;
        return true;
    };

    const propertyTextContainsAnyLocation = (prop, locations) => {
        const text = (
            (prop.locationName || '') + ' ' +
            (prop.project?.name || '') + ' ' +
            (prop.developer?.fullName || '') + ' ' +
            (prop.name || '')
        ).toLowerCase();
        return locations.some((loc) => text.includes(loc));
    };

    // First pass: strict text location match if provided
    const locations = criteria.filter_location
        ? String(criteria.filter_location).split(',').map((loc) => loc.trim().toLowerCase())
        : null;

    for (const it of items) {
        if (excludedIds.includes(it.id)) continue;
        if (!propertyMeetsPrice(it)) continue;
        if (!propertyMeetsType(it)) continue;
        if (locations && !propertyTextContainsAnyLocation(it, locations)) continue;

        candidates.push(it);
    }

    // If location specified but nothing matched textually, and we have geocode, include within 100km
    if (locations && candidates.length === 0 && queryCoords) {
        for (const it of items) {
            if (excludedIds.includes(it.id)) continue;
            if (!propertyMeetsPrice(it)) continue;
            if (!propertyMeetsType(it)) continue;
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

    // Cap K for reranker cost control
    const K = 30;
    const capped = deduped.slice(0, K);

    // Build slim payload for reranker
    const slim = capped.map((p) => {
        const unitPrices = Array.isArray(p.unitConfiguration)
            ? p.unitConfiguration.map(u => Number(u.configPrice)).filter(Number.isFinite)
            : [];
        const minUnitPrice = unitPrices.length ? Math.min(...unitPrices) : null;
        const maxUnitPrice = unitPrices.length ? Math.max(...unitPrices) : null;
        const unitTypeSummary = Array.isArray(p.unitConfiguration)
            ? [...new Set(p.unitConfiguration.map(u => String(u.unitType || '').toLowerCase()).filter(Boolean))]
            : [];
        const amenitiesTags = [
            ...(Array.isArray(p.searchTags) ? p.searchTags : (p.searchTags ? [p.searchTags] : [])),
            ...(Array.isArray(p.secondaryTags) ? p.secondaryTags : (p.secondaryTags ? [p.secondaryTags] : [])),
        ];
        return {
            id: p.id,
            name: p.name || '',
            locationName: p.locationName || '',
            price: Number.isFinite(Number(p.price)) ? Number(p.price) : null,
            minUnitPrice,
            maxUnitPrice,
            bedrooms: Number.isFinite(Number(p.bedrooms)) ? Number(p.bedrooms) : null,
            bathrooms: Number.isFinite(Number(p.bathrooms)) ? Number(p.bathrooms) : null,
            unitTypeSummary,
            amenitiesTags,
            distanceKm: typeof p.__distanceKm === 'number' ? p.__distanceKm : null,
        };
    });

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
    name: 'analyze_query',
    description: `Analyze a real estate query and extract structured search criteria.
    
Use this tool to understand what the user is looking for before searching properties.
For follow-up queries, include the conversation history in the query parameter.
Returns a JSON object with extracted criteria like bedrooms, price, location, etc.`,
    parameters: z.object({
        query: z.string().describe("The user's property search query. For follow-ups, include conversation history."),
    }),
    execute: async ({ query }) => {
        console.log('[Query Analyzer Tool] Analyzing query:', query);
        
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
   - "studio" → filter_ptype: "condo", min_bedrooms: 0, max_bedrooms: 0
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

5. PRICE RANGE EXTRACTION (in PHP):
   - "₱2M to ₱5M" → min_price: 2000000, max_price: 5000000
   - "under ₱3M"/"below ₱3M" → max_price: 3000000
   - "above ₱2M"/"over ₱2M" → min_price: 2000000
   - Convert: "M" = million, "K" = thousand

6. PRICE SORTING:
   - "cheapest"/"lowest"/"affordable" → sort_by: "price_asc"
   - "expensive"/"highest"/"luxury" → sort_by: "price_desc"

7. COUNT EXTRACTION:
   - "top 5", "show 10", "first 3" → requested_count: (number, max 10)
   - Convert words: "three" → 3
   - Default: null if not mentioned

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
            name: 'Query Analyzer',
            instructions: prompt,
            model: 'gpt-4o-mini',
        });

        const result = await run(analyzerAgent, query);
        const output = result.finalOutput || '';

        // Extract JSON from response
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in response');

        const parsed = JSON.parse(jsonMatch[0]);
        
        // If AI didn't populate filter_location, try geocoding the query
        // If geocoding succeeds, it's likely a location query
        if (!parsed.apiSearchParams?.filter_location && parsed.apiSearchParams?.query) {
            const query = parsed.apiSearchParams.query;
            
            // Skip geocoding for generic real estate words
            const genericWords = ['property', 'properties', 'condo', 'condos', 'house', 'houses', 
                                 'apartment', 'apartments', 'unit', 'units', 'home', 'homes',
                                 'listing', 'listings', 'real estate', 'investment'];
            const isGenericQuery = genericWords.some(word => query.toLowerCase() === word);
            
            if (!isGenericQuery) {
                // Try geocoding - if it works, treat it as a location
                console.log(`[Query Analyzer Tool] Attempting to geocode query for fallback: "${query}"`);
                const geocodeResult = await geocodeLocation(query);
                
                if (geocodeResult) {
                    // Geocoding succeeded - it's a valid location
                    parsed.apiSearchParams.filter_location = query;
                    console.log(`[Query Analyzer Tool] Geocoding succeeded, using as filter_location: "${query}" → ${geocodeResult.displayName}`);
                } else {
                    console.log(`[Query Analyzer Tool] Geocoding failed, keeping query as-is`);
                }
            } else {
                console.log(`[Query Analyzer Tool] Skipping geocoding for generic word: "${query}"`);
            }
        }
        
        console.log('[Query Analyzer Tool] Extracted criteria:', parsed);

        return JSON.stringify(parsed.apiSearchParams || parsed);
    },
});

/**
 * Search Properties Tool
 * Searches DatoCMS for properties matching the criteria
 */
export const searchPropertiesTool = tool({
    name: 'search_properties',
    description: `Search for real estate properties in the Philippines based on search criteria.

Use this tool AFTER analyzing the query with analyze_query tool.
Takes structured criteria and returns matching properties (default: 3 results, max: 10 if requested_count is specified).

IMPORTANT: The criteria JSON can include an "excludedPropertyIds" array to avoid repeating properties. Extract property IDs from previous responses (propertyId="...") and add them to criteria.`,
    parameters: z.object({
        criteria: z.string().describe("JSON string of search criteria from analyze_query tool. Can include excludedPropertyIds array."),
    }),
    execute: async ({ criteria }) => {
        const limit = 3;
        console.log('[Search Properties Tool] Searching with criteria:', criteria);

        let structuredCriteria;
        try {
            structuredCriteria = typeof criteria === 'string' ? JSON.parse(criteria) : criteria;
        } catch (error) {
            console.error('[Search Properties Tool] Invalid criteria JSON');
            structuredCriteria = { query: criteria };
        }

        // Normalize legacy/nested price shape: { price: { min, max } } → { min_price, max_price }
        if (structuredCriteria && typeof structuredCriteria === 'object' && structuredCriteria.price && typeof structuredCriteria.price === 'object') {
            const possibleMin = structuredCriteria.price.min ?? structuredCriteria.price.minimum;
            const possibleMax = structuredCriteria.price.max ?? structuredCriteria.price.maximum;
            if (structuredCriteria.min_price == null && Number.isFinite(Number(possibleMin))) {
                structuredCriteria.min_price = Number(possibleMin);
            }
            if (structuredCriteria.max_price == null && Number.isFinite(Number(possibleMax))) {
                structuredCriteria.max_price = Number(possibleMax);
            }
        }

        // Check if query analyzer marked this as non-real estate
        if (structuredCriteria.query === 'NOT_REAL_ESTATE') {
            console.log('[Search Properties Tool] Non-real estate query detected, returning 0 properties');
            return JSON.stringify({
                results: [],
                message: 'NOT_REAL_ESTATE_QUERY'
            });
        }

        // Get excluded property IDs from criteria (if agent provided them)
        const excludedIds = structuredCriteria.excludedPropertyIds || [];
        if (excludedIds.length > 0) {
            console.log('[Search Properties Tool] Excluding', excludedIds.length, 'previously shown properties');
        }

        const allProperties = await fetchPropertiesFromDatoCMS();

        // Respect requested_count when provided (cap at 10 max), otherwise use default limit (3)
        const maxAllowed = 10;
        const requestedCountRaw = structuredCriteria.requested_count;
        const requestedCount = Number.isFinite(Number(requestedCountRaw)) ? parseInt(String(requestedCountRaw), 10) : undefined;
        const effectiveLimit = requestedCount ? Math.max(1, Math.min(maxAllowed, requestedCount)) : limit;

        // Always build strict candidates (deterministic filters only)
        const { candidates, referenceLocation } = await buildStrictCandidates(allProperties, structuredCriteria, excludedIds);

        // Prepare output shape: candidates for reranker + metadata
        const out = {
            candidates,
            count: candidates.length,
            // downstream presenter will slice using reranker order and requested_count
            referenceLocation,
        };

        console.log(`[Search Properties Tool] Returning ${out.count} candidates (strict)`);
        return JSON.stringify(out);
    },
});

/**
 * Rerank Properties Tool
 * Orders candidates by relevance and returns reasons per id
 */
export const rerankPropertiesTool = tool({
    name: 'rerank_properties',
    description: `Given structured criteria and a list of candidate properties (slim), order them by relevance and provide short reasons per id. Use for tie-breaking, amenity synonyms, intent nuances (investment, family-friendly), and combining signals like distance and price fit.`,
    parameters: z.object({
        criteriaJson: z.string().describe('JSON string of search criteria used; same shape produced by analyze_query.'),
        candidatesJson: z.string().describe('JSON string array of slim candidates from search_properties.'),
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

        const prompt = `You are a real estate reranker. You receive a user intent and a list of candidates with slim fields. Order them from best to worst and explain briefly why each fits.

Return ONLY valid JSON with this shape:
{
  "orderedIds": string[],
  "reasonsById": { [id: string]: string }
}

Guidelines:
- Prefer exact budget fits; if only max_price given, prefer lower-priced matches.
- Respect requested_count when present (but you still return the full ordering; the agent will slice).
- Consider unitTypeSummary against filter_ptype.
- Consider distanceKm when provided (closer is better), but do NOT select properties that violate location hard filter — they were already filtered.
- Use amenitiesTags to satisfy must_have_amenities if present (handle synonyms like pool→swimming_pool, gym→fitness_center).
- Consider bedrooms/bathrooms fits if present.
- Keep reasons very short (≤120 chars).`;

        const reranker = new Agent({
            name: 'Property Reranker',
            instructions: prompt,
            model: 'gpt-4o-mini',
        });

        const input = `CRITERIA\n${JSON.stringify(criteria)}\n\nCANDIDATES\n${JSON.stringify(candidates)}`;
        const result = await run(reranker, input);
        const output = result.finalOutput || '';
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return JSON.stringify({ orderedIds: candidates.map((c) => c.id), reasonsById: {} });
        }
        const parsed = JSON.parse(jsonMatch[0]);
        return JSON.stringify(parsed);
    },
});

