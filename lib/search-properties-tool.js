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

  const developerFilters = normalizeList(criteria.filter_developer, {
    lowercase: true,
  });
  const projectFilters = normalizeList(criteria.filter_project, {
    lowercase: true,
  });
  const amenityFilters = normalizeList(criteria.must_have_amenities, {
    lowercase: true,
  });
  const locationTokens = normalizeList(criteria.filter_location, {
    lowercase: true,
  });

  // Geocode the search location if provided (for distance fallback only)
  let queryCoords = null;
  const locationValue = criteria.filter_location;
  if (locationValue) {
    const firstLocation = Array.isArray(locationValue)
      ? String(locationValue[0] || "").trim()
      : String(locationValue).split(",")[0].trim();
    if (firstLocation) {
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
    
    // Extract unit prices from unitConfiguration
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
    
    // CRITICAL: Prioritize unit prices over property-level price
    // For "under ₱8M", we need to check if there's at least one unit within budget
    // Property-level price might be outdated or not reflect actual available units
    if (unitPrices.length > 0) {
      // Check if any unit price meets the criteria
      // For "under ₱8M": checks if any unit <= ₱8M
      // For "₱5M to ₱8M": checks if any unit is within that range
      return unitPrices.some(meets);
    }
    
    // Fallback: If no unit prices available, check property-level price
    const p = Number.isFinite(Number(prop.price))
      ? Number(prop.price)
      : undefined;
    return p != null ? meets(p) : false;
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
    
    // Check for specific unit types in query (bi-level, loft, penthouse, studio)
    const queryText = (criteria.query || "").toLowerCase();
    const hasBiLevel = /\b(bi[- ]?level|bi[- ]?level unit)\b/i.test(queryText);
    const hasLoft = /\b(loft|loft unit)\b/i.test(queryText);
    const hasPenthouse = /\b(penthouse|penthouse unit)\b/i.test(queryText);
    const hasStudio = /\b(studio|bachelor pad|bachelor's pad)\b/i.test(queryText);
    
    // If specific unit type mentioned, filter by that type
    if (hasBiLevel) {
      return unitTypes.includes("bi_level");
    }
    if (hasLoft) {
      return unitTypes.includes("loft");
    }
    if (hasPenthouse) {
      return unitTypes.includes("penthouse");
    }
    if (hasStudio) {
      return unitTypes.includes("studio_open_plan");
    }
    
    // Otherwise, use broad category (house vs condo)
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

  const propertyMeetsBathrooms = (prop) => {
    if (criteria.min_bathrooms == null && criteria.max_bathrooms == null)
      return true;

    // Check property-level bathrooms
    const propBathrooms = Number.isFinite(Number(prop.bathrooms))
      ? Number(prop.bathrooms)
      : null;

    // Check unit-level bathrooms
    const unitBathrooms = Array.isArray(prop.unitConfiguration)
      ? prop.unitConfiguration
          .map((u) => Number(u.bathrooms))
          .filter(Number.isFinite)
      : [];

    const meets = (val) => {
      if (criteria.min_bathrooms != null && criteria.max_bathrooms != null) {
        return val >= criteria.min_bathrooms && val <= criteria.max_bathrooms;
      }
      if (criteria.min_bathrooms != null) return val >= criteria.min_bathrooms;
      if (criteria.max_bathrooms != null) return val <= criteria.max_bathrooms;
      return true;
    };

    const propMeets = propBathrooms != null ? meets(propBathrooms) : false;
    const anyUnitMeets = unitBathrooms.some(meets);
    return propMeets || anyUnitMeets;
  };

  const collectDeveloperTokens = (prop) => {
    const tokens = new Set();
    const add = (value) => {
      if (!value) return;
      const str = String(value).toLowerCase().trim();
      if (str) tokens.add(str);
    };
    add(prop.developer?.fullName);
    add(prop.developer?.shortName);
    add(prop.developer?.slug);
    add(prop.developerName);
    add(prop.project?.developer?.fullName);
    add(prop.project?.developer?.shortName);
    add(prop.project?.developer?.slug);
    return Array.from(tokens);
  };

  const collectProjectTokens = (prop) => {
    const tokens = new Set();
    const add = (value) => {
      if (!value) return;
      const str = String(value).toLowerCase().trim();
      if (str) tokens.add(str);
    };
    add(prop.project?.name);
    add(prop.projectName);
    add(prop.name);
    return Array.from(tokens);
  };

  const amenitySynonyms = {
    swimming_pool: ["swimming pool", "pool"],
    fitness_center: ["fitness center", "gym"],
    parking: ["parking", "parking space", "parking slot", "car park"],
    balcony: ["balcony"],
    security: ["security", "24/7 security", "guarded"],
    elevator: ["elevator", "lift"],
    clubhouse: ["clubhouse"],
    garden: ["garden", "landscaped garden"],
    rooftop_deck: ["rooftop deck", "roof deck", "rooftop"],
    pet_area: ["pet area", "pet-friendly", "pet friendly"],
    smart_home: ["smart home", "smart-home"],
  };

  const collectAmenityTokens = (prop) => {
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
    addTokens(prop.searchTags);
    addTokens(prop.secondaryTags);
    addTokens(prop.amenitiesAndCommonFacilities);
    addTokens(prop.buildingAmenities);
    addTokens(prop.unitFeatures);
    addTokens(prop.description);
    addTokens(prop.summary);
    if (Array.isArray(prop.unitConfiguration)) {
      prop.unitConfiguration.forEach((unit) => addTokens(unit.unitFeatures));
    }
    return Array.from(tokens);
  };

  const propertyMeetsDeveloper = (prop) => {
    if (!developerFilters.length) return true;
    const tokens = collectDeveloperTokens(prop);
    return developerFilters.some((filter) =>
      tokens.some(
        (token) => token.includes(filter) || filter.includes(token)
      )
    );
  };

  const propertyMeetsProject = (prop) => {
    if (!projectFilters.length) return true;
    const tokens = collectProjectTokens(prop);
    return projectFilters.some((filter) =>
      tokens.some(
        (token) => token.includes(filter) || filter.includes(token)
      )
    );
  };

  const propertyHasRequiredAmenities = (prop) => {
    if (!amenityFilters.length) return true;
    const tokens = collectAmenityTokens(prop);
    return amenityFilters.every((filter) => {
      const synonyms = amenitySynonyms[filter] || [filter.replace(/_/g, " ")];
      return synonyms.some((syn) => {
        const normalizedSyn = syn.toLowerCase();
        return tokens.some((token) => token.includes(normalizedSyn));
      });
    });
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
  const locations = locationTokens.length ? locationTokens : null;

  for (const it of items) {
    if (excludedSet.has(String(it.id))) continue;
    if (!propertyMeetsPrice(it)) continue;
    if (!propertyMeetsType(it)) continue;
    if (!propertyMeetsBedrooms(it)) continue;
    if (!propertyMeetsBathrooms(it)) continue;
    if (!propertyMeetsDeveloper(it)) continue;
    if (!propertyMeetsProject(it)) continue;
    if (!propertyHasRequiredAmenities(it)) continue;
    if (locations && !propertyTextContainsAnyLocation(it, locations)) continue;

    candidates.push(it);
  }

  // Second pass: If location was specified but no results, relax amenities but keep location strict
  // This prioritizes exact location matches even if they don't have all requested amenities
  if (locations && candidates.length === 0 && amenityFilters.length > 0) {
    for (const it of items) {
      if (excludedSet.has(String(it.id))) continue;
      if (!propertyMeetsPrice(it)) continue;
      if (!propertyMeetsType(it)) continue;
      if (!propertyMeetsBedrooms(it)) continue;
      if (!propertyMeetsBathrooms(it)) continue;
      if (!propertyMeetsDeveloper(it)) continue;
      if (!propertyMeetsProject(it)) continue;
      // Skip amenity check - relax this requirement
      if (!propertyTextContainsAnyLocation(it, locations)) continue; // Keep location strict

      candidates.push(it);
    }
  }

  // Third pass: If location was specified but still no results, relax price but keep location strict
  // CRITICAL: Only relax price if it's a RANGE query (both min_price and max_price), not a "under/below" query
  // For "under ₱8M" (max_price only), price is a hard requirement and should NOT be relaxed
  // For "above ₱5M" (min_price only), price is a hard requirement and should NOT be relaxed
  // This ensures we return properties in the requested location even if price doesn't match exactly
  // BUT only when price is a range, not a hard upper/lower limit
  const hasPriceRange = criteria.min_price != null && criteria.max_price != null;
  
  // Only relax price for range queries, not for "under/below" or "above/over" queries
  if (locations && candidates.length === 0 && hasPriceRange) {
    for (const it of items) {
      if (excludedSet.has(String(it.id))) continue;
      // Skip price check - relax this requirement (only for range queries)
      if (!propertyMeetsType(it)) continue;
      if (!propertyMeetsBedrooms(it)) continue;
      if (!propertyMeetsBathrooms(it)) continue;
      if (!propertyMeetsDeveloper(it)) continue;
      if (!propertyMeetsProject(it)) continue;
      // Skip amenity check - relax this requirement too
      if (!propertyTextContainsAnyLocation(it, locations)) continue; // Keep location strict

      candidates.push(it);
    }
  }

  // Fourth pass: Only use geocode fallback if query explicitly mentions "near", "nearby", "close to", etc.
  // If location is explicitly specified (e.g., "in Laguna"), do NOT fall back to nearby areas
  // Note: "around" in price context (e.g., "around ₱6M") should NOT trigger nearby fallback
  const locationQuery = (criteria.query || "").toLowerCase();
  // Check for proximity words followed by location words (not prices)
  // Exclude "around" if it appears before a price symbol or number
  const hasPriceAround = /\baround\s*[₱$]|\baround\s*\d+[km]?/i.test(locationQuery);
  const hasLocationProximity = /\b(near|nearby|close to|within|proximity)\s+(?:to|from|of)?\s*[a-z]+/i.test(locationQuery) ||
    (/\baround\s+[a-z]+/i.test(locationQuery) && !hasPriceAround);
  const isNearbyQuery = hasLocationProximity;
  
  if (locations && candidates.length === 0 && queryCoords && isNearbyQuery) {
    for (const it of items) {
      if (excludedSet.has(String(it.id))) continue;
      if (!propertyMeetsPrice(it)) continue;
      if (!propertyMeetsType(it)) continue;
      if (!propertyMeetsBedrooms(it)) continue;
      if (!propertyMeetsBathrooms(it)) continue;
      if (!propertyMeetsDeveloper(it)) continue;
      if (!propertyMeetsProject(it)) continue;
      if (!propertyHasRequiredAmenities(it)) continue;
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

  // Apply sorting BEFORE location diversity to ensure we get the best from each location
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

  // Ensure location diversity when multiple locations are specified
  // If user asks for "one from X, one from Y", ensure we get at least one from each
  if (locationTokens.length > 1 && deduped.length > 0) {
    const locationGroups = new Map();
    locationTokens.forEach((loc) => {
      locationGroups.set(loc, []);
    });

    // Group candidates by which location they match
    for (const candidate of deduped) {
      const candidateText = (
        (candidate.locationName || "") +
        " " +
        (candidate.project?.name || "") +
        " " +
        (candidate.developer?.fullName || "") +
        " " +
        (candidate.name || "")
      ).toLowerCase();

      for (const loc of locationTokens) {
        if (candidateText.includes(loc)) {
          if (!locationGroups.get(loc)) {
            locationGroups.set(loc, []);
          }
          locationGroups.get(loc).push(candidate);
          break; // Only assign to first matching location
        }
      }
    }

    // If we have candidates from multiple locations and requested_count matches number of locations,
    // prioritize ensuring one from each location
    const locationsWithCandidates = Array.from(locationGroups.values()).filter(
      (group) => group.length > 0
    );
    if (
      locationsWithCandidates.length > 1 &&
      limit >= locationTokens.length
    ) {
      const diverseCandidates = [];
      const usedIds = new Set();

      // First pass: pick best (first) candidate from each location
      // (candidates are already sorted by this point)
      for (const [loc, group] of locationGroups.entries()) {
        if (group.length > 0 && diverseCandidates.length < limit) {
          const candidate = group[0]; // Best candidate from this location (already sorted)
          if (!usedIds.has(candidate.id)) {
            diverseCandidates.push(candidate);
            usedIds.add(candidate.id);
          }
        }
      }

      // Second pass: fill remaining slots with any remaining candidates
      for (const candidate of deduped) {
        if (diverseCandidates.length >= limit) break;
        if (!usedIds.has(candidate.id)) {
          diverseCandidates.push(candidate);
          usedIds.add(candidate.id);
        }
      }

      // Replace deduped with diverse candidates if we got at least one from each location
      if (diverseCandidates.length >= locationTokens.length) {
        deduped.length = 0;
        deduped.push(...diverseCandidates);
      }
    }
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

    const normalizeSoftList = (value) => {
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

    const normalizeDeveloperList = (value) => {
      if (value == null) return null;
      if (Array.isArray(value)) {
        const cleaned = value.map((v) => String(v).trim()).filter(Boolean);
        return cleaned.length ? cleaned : null;
      }
      const parts = String(value)
        .split(/,|\/|\band\b|&/i)
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length === 0) return null;
      if (parts.length === 1) return parts[0];
      return parts;
    };

    const ensureArray = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value.filter(Boolean);
      return [value].filter(Boolean);
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
      referencedProperty:
        parsed.referencedProperty !== undefined
          ? parsed.referencedProperty
          : null,
      locationCorrection:
        parsed.locationCorrection !== undefined
          ? parsed.locationCorrection
          : null,
      flags: {
        ...DEFAULT_FLAGS,
        ...(parsed.flags || {}),
      },
    };

    // Normalize clarification options to array of strings
    structured.flags.clarificationOptions = ensureArray(
      structured.flags.clarificationOptions
    ).map((option) => String(option));

    if (structured.flags.needsClarification && !structured.flags.clarificationReason) {
      structured.flags.clarificationReason = "UNSPECIFIED";
    }

    // Normalize apiSearchParams fields
    const params = structured.apiSearchParams;
    params.query = params.query ? String(params.query) : "";
    params.filter_location = params.filter_location
      ? String(params.filter_location)
      : null;
    params.filter_ptype = params.filter_ptype
      ? String(params.filter_ptype)
      : null;

    const normalizedDeveloper = normalizeDeveloperList(params.filter_developer);
    params.filter_developer = normalizedDeveloper;

    const normalizedProject = normalizeDeveloperList(params.filter_project);
    params.filter_project = normalizedProject;

    params.must_have_amenities = Array.isArray(params.must_have_amenities)
      ? params.must_have_amenities.map((item) => String(item))
      : params.must_have_amenities
      ? [String(params.must_have_amenities)]
      : null;

    params.soft_requirements = normalizeSoftList(params.soft_requirements);

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

    const LOW_PRICE_THRESHOLD = 100000;
    const HIGH_PRICE_THRESHOLD = 200000000;

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

    const bedroomRange = normalizeRange(
      params.min_bedrooms,
      params.max_bedrooms,
      "NEGATIVE_BEDROOMS"
    );
    params.min_bedrooms = bedroomRange.min;
    params.max_bedrooms = bedroomRange.max;

    const bathroomRange = normalizeRange(
      params.min_bathrooms,
      params.max_bathrooms,
      "NEGATIVE_BATHROOMS"
    );
    params.min_bathrooms = bathroomRange.min;
    params.max_bathrooms = bathroomRange.max;

    if (!structured.flags.rangeIssue) {
      structured.flags.rangeIssue = bedroomRange.issue || bathroomRange.issue;
    }

    // Geocode fallback if location still null and query looks like a place
    if (!params.filter_location && params.query) {
      const queryText = params.query;
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
      const isGenericQuery = genericWords.some((word) =>
        queryText.toLowerCase().includes(word)
      );

      if (!isGenericQuery) {
        console.log(
          `[Query Analyzer Tool] Attempting to geocode query for fallback: "${queryText}"`
        );
        const geocodeResult = await geocodeLocation(queryText);

        if (geocodeResult) {
          params.filter_location = queryText;
          console.log(
            `[Query Analyzer Tool] Geocoding succeeded, using as filter_location: "${queryText}" → ${geocodeResult.displayName}`
          );
        } else {
          console.log(
            `[Query Analyzer Tool] Geocoding failed, keeping query as-is`
          );
        }
      }
    }

    // Ensure softNotes is array of strings
    structured.flags.softNotes = ensureArray(structured.flags.softNotes).map(
      (note) => String(note)
    );

    console.log("[Query Analyzer Tool] Extracted criteria:", structured);

    return JSON.stringify(structured);
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

CRITICAL: Pass ALL fields from apiSearchParams using EXACT field names:
- query, filter_location, filter_ptype, filter_developer, filter_project
- min_price, max_price (NOT minUnitPrice/maxUnitPrice)
- min_bedrooms, max_bedrooms, min_bathrooms, max_bathrooms
- must_have_amenities, sort_by, requested_count
- excludedPropertyIds (optional array to avoid repeating properties)

Example: { "query": "...", "filter_location": "Makati", "max_price": 5000000, "excludedPropertyIds": ["id1"] }`,
  parameters: z.object({
    criteria: z
      .string()
      .describe(
        "JSON string with ALL fields from apiSearchParams (exact names) plus optional excludedPropertyIds array."
      ),
  }),
  execute: async ({ criteria }) => {
    console.log("[Search Properties Tool] Searching with criteria:", criteria);

    let parsedCriteria;
    try {
      parsedCriteria =
        typeof criteria === "string" ? JSON.parse(criteria) : criteria;
    } catch (error) {
      console.error("[Search Properties Tool] Invalid criteria JSON");
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
      let excludedPropertyIds = [];
      let softRequirements = null;

      if (input && typeof input === "object") {
        if (input.apiSearchParams) {
          flags = input.flags || {};
          softRequirements =
            input.apiSearchParams?.soft_requirements ??
            input.soft_requirements ??
            null;
          excludedPropertyIds = arrayify(input.excludedPropertyIds);
          searchParams = { ...input.apiSearchParams };
        } else {
          flags = input.flags || {};
          softRequirements = input.soft_requirements ?? null;
          excludedPropertyIds = arrayify(input.excludedPropertyIds);
          searchParams = { ...input };
        }
      } else if (input != null) {
        searchParams = { query: input };
      }

      excludedPropertyIds = excludedPropertyIds.concat(
        arrayify(searchParams.excludedPropertyIds)
      );
      delete searchParams.excludedPropertyIds;

      return {
        searchParams,
        flags,
        excludedPropertyIds,
        softRequirements,
      };
    };

    const {
      searchParams,
      flags: incomingFlags,
      excludedPropertyIds: rawExcludedIds,
      softRequirements: incomingSoftRequirements,
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

    structuredCriteria.filter_ptype = normalizeString(
      structuredCriteria.filter_ptype
    );

    const developerList = normalizeList(structuredCriteria.filter_developer);
    structuredCriteria.filter_developer = developerList;

    const projectList = normalizeList(structuredCriteria.filter_project);
    structuredCriteria.filter_project = projectList;

    structuredCriteria.must_have_amenities = normalizeList(
      structuredCriteria.must_have_amenities,
      { lowercase: true }
    );

    structuredCriteria.soft_requirements =
      normalizeList(structuredCriteria.soft_requirements, { lowercase: true }) ||
      normalizeList(incomingSoftRequirements, { lowercase: true });

    const detectPriceFromLegacy = () => {
    if (
      structuredCriteria &&
      typeof structuredCriteria === "object" &&
      structuredCriteria.price &&
      typeof structuredCriteria.price === "object"
    ) {
      const possibleMin =
          structuredCriteria.price.min ??
          structuredCriteria.price.minimum ??
          structuredCriteria.price.from;
      const possibleMax =
          structuredCriteria.price.max ??
          structuredCriteria.price.maximum ??
          structuredCriteria.price.to;
      if (
        structuredCriteria.min_price == null &&
          possibleMin != null
      ) {
          const minVal = sanitizeNumber(possibleMin);
          if (minVal != null) structuredCriteria.min_price = minVal;
      }
      if (
        structuredCriteria.max_price == null &&
          possibleMax != null
        ) {
          const maxVal = sanitizeNumber(possibleMax);
          if (maxVal != null) structuredCriteria.max_price = maxVal;
        }
      }
    };

    detectPriceFromLegacy();

    structuredCriteria.min_price = sanitizeNumber(
      structuredCriteria.min_price
    );
    structuredCriteria.max_price = sanitizeNumber(
      structuredCriteria.max_price
    );

    structuredCriteria.min_bedrooms = sanitizeNumber(
      structuredCriteria.min_bedrooms
    );
    structuredCriteria.max_bedrooms = sanitizeNumber(
      structuredCriteria.max_bedrooms
    );
    structuredCriteria.min_bathrooms = sanitizeNumber(
      structuredCriteria.min_bathrooms
    );
    structuredCriteria.max_bathrooms = sanitizeNumber(
      structuredCriteria.max_bathrooms
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

    const bedroomRange = normalizeRange(
      structuredCriteria.min_bedrooms,
      structuredCriteria.max_bedrooms,
      "NEGATIVE_BEDROOMS"
    );
    structuredCriteria.min_bedrooms = bedroomRange.min;
    structuredCriteria.max_bedrooms = bedroomRange.max;

    const bathroomRange = normalizeRange(
      structuredCriteria.min_bathrooms,
      structuredCriteria.max_bathrooms,
      "NEGATIVE_BATHROOMS"
    );
    structuredCriteria.min_bathrooms = bathroomRange.min;
    structuredCriteria.max_bathrooms = bathroomRange.max;

    if (!analyzerFlags.rangeIssue) {
      analyzerFlags.rangeIssue = bedroomRange.issue || bathroomRange.issue || null;
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
      if (value < 100000) return "TOO_LOW";
      if (value > 200000000) return "TOO_HIGH";
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
          .concat(arrayify(structuredCriteria.excludedPropertyIds))
          .map((id) => String(id))
      )
    );
    delete structuredCriteria.excludedPropertyIds;

    const limit = Math.min(
      Math.max(1, structuredCriteria.requested_count || 3),
      10
    );
    console.log("[Search Properties Tool] Using limit:", limit);

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

    if (structuredCriteria.query === "INVALID_PROPERTY_TYPE") {
      console.log(
        "[Search Properties Tool] Conflicting property type detected, returning 0 properties"
      );
      return JSON.stringify({
        results: [],
        message: "INVALID_PROPERTY_TYPE_QUERY",
      });
    }

    if (structuredCriteria.query === "UNREALISTIC_DESCRIPTION") {
      console.log(
        "[Search Properties Tool] Unrealistic description detected, returning 0 properties"
      );
      return JSON.stringify({
        results: [],
        message: "UNREALISTIC_DESCRIPTION_QUERY",
      });
    }

    if (analyzerFlags.needsClarification) {
      console.log(
        "[Search Properties Tool] Clarification needed, skipping search"
      );
      return JSON.stringify({
        results: [],
        message: "NEEDS_CLARIFICATION",
        flags: analyzerFlags,
      });
    }

    if (analyzerFlags.unrealisticPrice) {
      console.log(
        "[Search Properties Tool] Unrealistic price detected, skipping search"
      );
      return JSON.stringify({
        results: [],
        message: "UNREALISTIC_PRICE_QUERY",
        flags: analyzerFlags,
      });
    }

    if (analyzerFlags.rangeIssue) {
      console.log(
        "[Search Properties Tool] Invalid bedroom/bathroom range, skipping search"
      );
      return JSON.stringify({
        results: [],
        message: "INVALID_RANGE_QUERY",
        flags: analyzerFlags,
      });
    }

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
      flags: analyzerFlags,
      softRequirements: structuredCriteria.soft_requirements || null,
      requestedCount: limit,
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
