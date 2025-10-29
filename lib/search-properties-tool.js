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
 * Score and filter properties based on criteria
 */
async function scoreAndFilterProperties(items, criteria, excludedIds = []) {
    const results = [];
    
    // Geocode the search location if provided (for distance-based scoring)
    let queryCoords = null;
    if (criteria.filter_location) {
        // Try to geocode the first location in the list
        const firstLocation = criteria.filter_location.split(',')[0].trim();
        console.log(`[Geocode] Attempting to geocode: ${firstLocation}`);
        queryCoords = await geocodeLocation(firstLocation);
        if (queryCoords) {
            console.log(`[Geocode] Success: ${queryCoords.displayName} (${queryCoords.latitude}, ${queryCoords.longitude})`);
        } else {
            console.log(`[Geocode] Failed to geocode: ${firstLocation}`);
        }
    }

    for (const it of items) {
        if (excludedIds.includes(it.id)) continue;

        let score = 0;
        const matched = [];
        const matchedUnits = [];
        let distanceKm = null;

        // Check unit configurations
        if (Array.isArray(it.unitConfiguration)) {
            for (const u of it.unitConfiguration) {
                let uScore = 0;
                let uMatched = false;

                if (criteria.min_bedrooms != null && typeof u.bedrooms === 'number') {
                    const meetsMin = u.bedrooms >= criteria.min_bedrooms;
                    const meetsMax = criteria.max_bedrooms == null || u.bedrooms <= criteria.max_bedrooms;
                    
                    if (meetsMin && meetsMax) {
                        uScore += 25;
                        uMatched = true;
                        // Extra points for exact match
                        if (criteria.max_bedrooms != null && u.bedrooms === criteria.max_bedrooms) {
                            uScore += 10;
                        }
                    }
                }

                if (criteria.min_bathrooms != null && typeof u.bathrooms === 'number') {
                    const meetsMin = u.bathrooms >= criteria.min_bathrooms;
                    const meetsMax = criteria.max_bathrooms == null || u.bathrooms <= criteria.max_bathrooms;
                    
                    if (meetsMin && meetsMax) {
                        uScore += 15;
                        uMatched = true;
                    }
                }

                if ((criteria.min_price != null || criteria.max_price != null) && typeof u.configPrice === 'number') {
                    const p = u.configPrice;
                    if (criteria.min_price != null && criteria.max_price != null) {
                        if (p >= criteria.min_price && p <= criteria.max_price) {
                            uScore += 20;
                            uMatched = true;
                        }
                    } else if (criteria.max_price != null && p <= criteria.max_price) {
                        uScore += 15;
                        uMatched = true;
                    }
                }

                if (uMatched) {
                    matchedUnits.push(u);
                    score += uScore;
                }
            }
        }

        // Property-level bedrooms
        if (criteria.min_bedrooms != null && typeof it.bedrooms === 'number') {
            const meetsMin = it.bedrooms >= criteria.min_bedrooms;
            const meetsMax = criteria.max_bedrooms == null || it.bedrooms <= criteria.max_bedrooms;
            
            if (meetsMin && meetsMax) {
                score += 30;
                matched.push(`bedrooms=${it.bedrooms}`);
            }
        }

        // Property-level bathrooms
        if (criteria.min_bathrooms != null && typeof it.bathrooms === 'number') {
            const meetsMin = it.bathrooms >= criteria.min_bathrooms;
            const meetsMax = criteria.max_bathrooms == null || it.bathrooms <= criteria.max_bathrooms;
            
            if (meetsMin && meetsMax) {
                score += 20;
                matched.push(`bathrooms=${it.bathrooms}`);
            }
        }

        // Property-level price
        if ((criteria.min_price != null || criteria.max_price != null) && typeof it.price === 'number') {
            const p = it.price;
            let priceScore = 0;
            if (criteria.min_price != null && criteria.max_price != null) {
                if (p >= criteria.min_price && p <= criteria.max_price) priceScore = 25;
            } else if (criteria.max_price != null && p <= criteria.max_price) {
                priceScore = 20;
            }
            if (priceScore > 0) {
                score += priceScore;
                matched.push(`price=${p}`);
            }
        }

        // Location matching - text-based (REQUIRED if specified)
        if (criteria.filter_location) {
            const locations = criteria.filter_location.split(',').map((loc) => loc.trim().toLowerCase());
            const propertyText = (
                (it.locationName || '') +
                ' ' +
                (it.project?.name || '') +
                ' ' +
                (it.developer?.fullName || '') +
                ' ' +
                (it.name || '')
            ).toLowerCase();

            let locationMatched = false;
            for (const loc of locations) {
                if (propertyText.includes(loc)) {
                    score += 25;
                    matched.push(`location=${loc}`);
                    locationMatched = true;
                    break;
                }
            }
            
            // Location text match is REQUIRED - skip property if no match
            // This prevents issues like Batangas appearing in "MIMAROPA" searches
            // (even though Batangas is close to MIMAROPA's geographic center)
            if (!locationMatched) {
                continue; // Skip to next property
            }
        }

        // Developer matching
        if (criteria.filter_developer) {
            const developerName = criteria.filter_developer.toLowerCase();
            const propertyDeveloper = (it.developer?.fullName || '').toLowerCase();
            const projectDeveloper = (it.project?.developer?.shortName || '').toLowerCase();
            
            if (propertyDeveloper.includes(developerName) || projectDeveloper.includes(developerName)) {
                score += 30;
                matched.push(`developer=${criteria.filter_developer}`);
            } else {
                continue; // Skip property if developer doesn't match
            }
        }

        // Project matching
        if (criteria.filter_project) {
            const projectName = criteria.filter_project.toLowerCase();
            const propertyProject = (it.project?.name || '').toLowerCase();
            
            if (propertyProject.includes(projectName)) {
                score += 25;
                matched.push(`project=${criteria.filter_project}`);
            } else {
                continue; // Skip property if project doesn't match
            }
        }

        // Amenities matching
        if (criteria.must_have_amenities && criteria.must_have_amenities.length > 0) {
            // Combine all amenities-related fields into one searchable string
            const amenitiesText = [
                it.amenitiesAndCommonFacilities || '',
                it.buildingAmenities || '',
                it.unitFeatures || '',
                it.kitchenFeatures || '',
                it.parkingAndAccess || '',
                it.greenFeatures || '',
                it.accessibilityFeatures || '',
                it.safetyAndSecurity || '',
                Array.isArray(it.searchTags) ? it.searchTags.join(' ') : (it.searchTags || ''),
                Array.isArray(it.secondaryTags) ? it.secondaryTags.join(' ') : (it.secondaryTags || ''),
                // Also check unitConfiguration unitFeatures
                ...(Array.isArray(it.unitConfiguration) 
                    ? it.unitConfiguration.map(u => u.unitFeatures || '') 
                    : [])
            ].join(' ').toLowerCase();
            
            let allAmenitiesFound = true;
            const foundAmenities = [];
            
            for (const amenity of criteria.must_have_amenities) {
                // Convert snake_case to readable format for matching
                // e.g., "swimming_pool" -> "swimming pool"
                const amenityReadable = amenity.replace(/_/g, ' ');
                
                if (amenitiesText.includes(amenityReadable)) {
                    foundAmenities.push(amenity);
                } else {
                    allAmenitiesFound = false;
                    break;
                }
            }
            
            if (allAmenitiesFound) {
                score += 40; // High score for matching all amenities
                matched.push(`amenities=${foundAmenities.join(',')}`);
            } else {
                continue; // Skip property if doesn't have all required amenities
            }
        }
        
        // Distance-based scoring (if we have geocoded coordinates)
        if (queryCoords && it.location?.latitude && it.location?.longitude) {
            distanceKm = calculateDistance(
                queryCoords.latitude,
                queryCoords.longitude,
                it.location.latitude,
                it.location.longitude
            );
            
            // Score based on distance (closer = higher score)
            // Within 5km: +50 points
            // Within 10km: +40 points
            // Within 20km: +30 points
            // Within 50km: +20 points
            // Within 100km: +10 points
            if (distanceKm <= 5) {
                score += 50;
                matched.push(`distance=${distanceKm.toFixed(1)}km`);
            } else if (distanceKm <= 10) {
                score += 40;
                matched.push(`distance=${distanceKm.toFixed(1)}km`);
            } else if (distanceKm <= 20) {
                score += 30;
                matched.push(`distance=${distanceKm.toFixed(1)}km`);
            } else if (distanceKm <= 50) {
                score += 20;
                matched.push(`distance=${distanceKm.toFixed(1)}km`);
            } else if (distanceKm <= 100) {
                score += 10;
                matched.push(`distance=${distanceKm.toFixed(1)}km`);
            }
        }

        // Query matching
        if (criteria.query) {
            const searchTagsStr = Array.isArray(it.searchTags) ? it.searchTags.join(' ') : it.searchTags || '';
            const haystack = ((it.name || '') + ' ' + (it.summary || '') + ' ' + searchTagsStr).toLowerCase();
            const queryWords = criteria.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
            let queryMatches = 0;
            for (const word of queryWords) {
                if (haystack.includes(word)) {
                    queryMatches++;
                    score += 5;
                }
            }
            if (queryMatches > 0) matched.push(`query_words=${queryMatches}`);
        }

        // Default score
        if (score === 0 && Object.keys(criteria).length === 0) score = 1;

        if (score > 0) {
            results.push({
                property: it,
                matchedUnits: matchedUnits.length ? matchedUnits : undefined,
                score,
                matched,
                distanceKm: distanceKm !== null ? distanceKm : undefined,
            });
        }
    }

    results.sort((a, b) => b.score - a.score);
    
    // Fallback: If no results found but we have geocoded coordinates, 
    // do distance-based search within 100km radius
    if (results.length === 0 && queryCoords) {
        console.log('[Fallback] No text matches found, searching by distance within 100km');
        
        for (const it of items) {
            if (excludedIds.includes(it.id)) continue;
            
            // Only use distance-based filtering
            if (it.location?.latitude && it.location?.longitude) {
                const distanceKm = calculateDistance(
                    queryCoords.latitude,
                    queryCoords.longitude,
                    it.location.latitude,
                    it.location.longitude
                );
                
                // Include properties within 100km
                if (distanceKm <= 100) {
                    let score = 0;
                    
                    // Score based on distance (closer = higher)
                    if (distanceKm <= 5) score = 100;
                    else if (distanceKm <= 10) score = 80;
                    else if (distanceKm <= 20) score = 60;
                    else if (distanceKm <= 50) score = 40;
                    else if (distanceKm <= 100) score = 20;
                    
                    results.push({
                        property: it,
                        matchedUnits: undefined,
                        score,
                        matched: [`distance=${distanceKm.toFixed(1)}km`],
                        distanceKm,
                    });
                }
            }
        }
        
        results.sort((a, b) => b.score - a.score);
        console.log(`[Fallback] Found ${results.length} properties within 100km`);
    }
    
    return {
        results,
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

0. QUERY FILTERING (CRITICAL):
   - If query contains BOTH real estate and non-real estate requests:
     • Example: "Find me a condo in Cebu and tell me a joke"
     • Extract ONLY the real estate part: "Find me a condo in Cebu"
     • Ignore jokes, weather, general questions, etc.
   - Focus exclusively on extracting property search criteria

1. LOCATION HANDLING:
   
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

2. PROPERTY TYPE MAPPING:
   - "studio" → filter_ptype: "condo", min_bedrooms: 0, max_bedrooms: 0
   - "apartment"/"condo"/"unit" → "condo"
   - "house"/"townhouse"/"house and lot" → "house"
   - "loft" → "condo"
   - "penthouse" → "condo"

3. BEDROOM/BATHROOM EXTRACTION:
   - "3-bedroom", "3BR", "3 bed" → min_bedrooms: 3, max_bedrooms: 3
   - "studio" → min_bedrooms: 0, max_bedrooms: 0
   - "at least 2", "2+" → min_bedrooms: 2, max_bedrooms: null
   - "up to 3", "3 or less" → min_bedrooms: null, max_bedrooms: 3
   - "2.5 baths" → min_bathrooms: 2, max_bathrooms: 2 (round down)
   - Range "2-4 bedrooms" → min_bedrooms: 2, max_bedrooms: 4

4. PRICE RANGE EXTRACTION (in PHP):
   - "₱2M to ₱5M" → min_price: 2000000, max_price: 5000000
   - "under ₱3M"/"below ₱3M" → max_price: 3000000
   - "above ₱2M"/"over ₱2M" → min_price: 2000000
   - Convert: "M" = million, "K" = thousand

5. PRICE SORTING:
   - "cheapest"/"lowest"/"affordable" → sort_by: "price_asc"
   - "expensive"/"highest"/"luxury" → sort_by: "price_desc"

6. COUNT EXTRACTION:
   - "top 5", "show 10", "first 3" → requested_count: (number, max 10)
   - Convert words: "three" → 3
   - Default: null if not mentioned

7. FOLLOW-UP DETECTION:
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
        }
        
        console.log('[Query Analyzer Tool] Extracted criteria:', parsed);

        return parsed.apiSearchParams || parsed;
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

        let results;
        let referenceLocation = null;

        // Special handling for price sorting: return lowest priced properties
        if (structuredCriteria.sort_by === 'price_asc') {
            // Filter out excluded and optionally by location if provided
            const byLocation = (prop) => {
                if (!structuredCriteria.filter_location) return true;
                const locations = String(structuredCriteria.filter_location)
                    .split(',')
                    .map((loc) => loc.trim().toLowerCase());
                const propertyText = (
                    (prop.locationName || '') + ' ' +
                    (prop.project?.name || '') + ' ' +
                    (prop.developer?.fullName || '') + ' ' +
                    (prop.name || '')
                ).toLowerCase();
                return locations.some((loc) => propertyText.includes(loc));
            };

            const candidates = allProperties
                .filter((p) => !excludedIds.includes(p.id))
                .filter(byLocation)
                .map((p) => ({
                    property: p,
                    // ensure numeric price; missing/invalid treated as Infinity to push to end
                    priceValue: Number.isFinite(Number(p.price)) ? Number(p.price) : Infinity,
                }))
                .sort((a, b) => a.priceValue - b.priceValue)
                .slice(0, effectiveLimit);

            results = candidates.map((entry, idx) => ({
                id: entry.property.id,
                name: entry.property.name || '',
                location: entry.property.locationName || '',
                price: Number.isFinite(entry.priceValue) ? entry.priceValue : 0,
                bedrooms: entry.property.bedrooms || 0,
                bathrooms: entry.property.bathrooms || 0,
                area: `${entry.property.minArea || entry.property.area || 0}-${entry.property.maxArea || entry.property.area || 0} sqm`,
                developer: entry.property.developer?.fullName || entry.property.developerName || '',
                project: entry.property.project?.name || entry.property.projectName || '',
                summary: entry.property.summary || '',
                description: entry.property.description || '',
                slug: entry.property.slug || '',
                photos: entry.property.photos?.slice(0, 1),
                matchedUnits: undefined,
                // Score not relevant for explicit price sort; set to small positive value
                score: 1,
            }));
        } else {
            // Default: relevance scoring
            const scoreData = await scoreAndFilterProperties(allProperties, structuredCriteria, excludedIds);
            const scoredResults = scoreData.results;
            referenceLocation = scoreData.referenceLocation;

            results = scoredResults.slice(0, effectiveLimit).map((result) => ({
                id: result.property.id,
                name: result.property.name || '',
                location: result.property.locationName || '',
                price: result.property.price || 0,
                bedrooms: result.property.bedrooms || 0,
                bathrooms: result.property.bathrooms || 0,
                area: `${result.property.minArea || result.property.area || 0}-${result.property.maxArea || result.property.area || 0} sqm`,
                developer: result.property.developer?.fullName || result.property.developerName || '',
                project: result.property.project?.name || result.property.projectName || '',
                summary: result.property.summary || '',
                description: result.property.description || '',
                slug: result.property.slug || '',
                photos: result.property.photos?.slice(0, 1),
                matchedUnits: result.matchedUnits?.map((u) => ({
                    unitName: u.unitName,
                    bedrooms: u.bedrooms,
                    bathrooms: u.bathrooms,
                    price: u.configPrice,
                    floorArea: u.floorArea,
                })),
                score: result.score,
                distanceKm: result.distanceKm,
            }));
        }

        console.log(`[Search Properties Tool] Returning ${results.length} properties`);

        return {
            count: results.length,
            properties: results,
            referenceLocation: referenceLocation || null,
        };
    },
});

