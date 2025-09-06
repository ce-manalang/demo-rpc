// api/ingest.js
import { Client } from "pg";
import OpenAI from "openai";

/**
 * Vercel-Serverless handler:
 * - expects POST JSON body holding the DatoCMS property object
 * - optional header: x-ingest-secret must match process.env.INGEST_SECRET (if set)
 */

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function prettyList(arr) {
  if (!arr) return "";
  return arr
    .filter(Boolean)
    .map((s) => String(s).replace(/_/g, " "))
    .join(", ");
}

function buildEmbeddingText(p) {
  // pick fields that matter semantically; keep it compact and readable
  const projectName = p.project?.name || p.projectName || "";
  const developerName = p.developer?.fullName || p.developerName || "";
  const tags = [p.searchTags, p.secondaryTags].filter(Boolean).join(" ");

  const parts = [
    `Name: ${p.name || ""}`,
    `Summary: ${p.summary || ""}`,
    `Description: ${p.description || ""}`,
    `Location: ${p.locationName || ""}`,
    `Project: ${projectName}`,
    `Developer: ${developerName}`,
    `Amenities: ${prettyList(p.buildingAmenities)}`,
    `Unit Features: ${prettyList(p.unitFeatures)}`,
    `Kitchen Features: ${prettyList(p.kitchenFeatures)}`,
    `Parking & Access: ${prettyList(p.parkingAndAccess)}`,
    `Green Features: ${prettyList(p.greenFeatures)}`,
    `Accessibility Features: ${prettyList(p.accessibilityFeatures)}`,
    `Safety & Security: ${prettyList(p.safetyAndSecurity)}`,
    `Tags: ${tags}`,
  ];

  return parts.filter(Boolean).join(". ");
}

async function getEmbedding(text) {
  const resp = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return resp.data[0].embedding; // array of floats
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Optional lightweight authorization for dev/prod safety
  const secretRequired = Boolean(process.env.INGEST_SECRET);
  if (secretRequired) {
    const header = req.headers["x-ingest-secret"];
    if (!header || header !== process.env.INGEST_SECRET) {
      return res.status(401).json({ error: "Unauthorized (invalid ingest secret)" });
    }
  }

  const property = req.body;
  if (!property || !property.id) {
    return res.status(400).json({ error: "Request body must include property.id" });
  }

  // Build embedding text
  const embeddingText = buildEmbeddingText(property);

  // Get embedding
  let embedding;
  try {
    embedding = await getEmbedding(embeddingText);
  } catch (err) {
    console.error("OpenAI embedding error:", err);
    return res.status(500).json({ error: "Failed to generate embedding" });
  }

  // Convert embedding to pgvector literal: '[0.1,0.2,...]'
  const embeddingLiteral = `[${embedding.join(",")}]`;

  // Normalize values for DB
  const offerEndsAt = property.offerEndsAt ? new Date(property.offerEndsAt).toISOString() : null;
  const projectName = property.project?.name || property.projectName || null;
  const developerName = property.developer?.fullName || property.developerName || null;

  // Postgres upsert using parameterized query
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  const q = `
    INSERT INTO properties (
      id, name, summary, ptype, area, min_area, max_area,
      bedrooms, bathrooms, description, location_name,
      latitude, longitude, pre_selling, pstatus, price,
      discounted, discount_value, featured, best_deal,
      is_limited, offer_ends_at, project_name, developer_name,
      search_tags, secondary_tags, building_amenities,
      unit_features, kitchen_features, parking_and_access,
      green_features, accessibility_features, safety_and_security,
      embedding
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,
      $8,$9,$10,$11,
      $12,$13,$14,$15,$16,
      $17,$18,$19,$20,
      $21,$22,$23,$24,
      $25,$26,$27,
      $28,$29,$30,
      $31,$32,$33,$34::vector
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      summary = EXCLUDED.summary,
      ptype = EXCLUDED.ptype,
      area = EXCLUDED.area,
      min_area = EXCLUDED.min_area,
      max_area = EXCLUDED.max_area,
      bedrooms = EXCLUDED.bedrooms,
      bathrooms = EXCLUDED.bathrooms,
      description = EXCLUDED.description,
      location_name = EXCLUDED.location_name,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      pre_selling = EXCLUDED.pre_selling,
      pstatus = EXCLUDED.pstatus,
      price = EXCLUDED.price,
      discounted = EXCLUDED.discounted,
      discount_value = EXCLUDED.discount_value,
      featured = EXCLUDED.featured,
      best_deal = EXCLUDED.best_deal,
      is_limited = EXCLUDED.is_limited,
      offer_ends_at = EXCLUDED.offer_ends_at,
      project_name = EXCLUDED.project_name,
      developer_name = EXCLUDED.developer_name,
      search_tags = EXCLUDED.search_tags,
      secondary_tags = EXCLUDED.secondary_tags,
      building_amenities = EXCLUDED.building_amenities,
      unit_features = EXCLUDED.unit_features,
      kitchen_features = EXCLUDED.kitchen_features,
      parking_and_access = EXCLUDED.parking_and_access,
      green_features = EXCLUDED.green_features,
      accessibility_features = EXCLUDED.accessibility_features,
      safety_and_security = EXCLUDED.safety_and_security,
      embedding = EXCLUDED.embedding;
  `;

  const params = [
    property.id,
    property.name ?? null,
    property.summary ?? null,
    property.ptype ?? null,
    property.area ?? null,
    property.minArea ?? null,
    property.maxArea ?? null,
    property.bedrooms ?? null,
    property.bathrooms ?? null,
    property.description ?? null,
    property.locationName ?? null,
    property.location?.latitude ?? null,
    property.location?.longitude ?? null,
    property.preSelling ?? null,
    property.pstatus ?? null,
    property.price ?? null,
    property.discounted ?? null,
    property.discountValue ?? null,
    property.featured ?? null,
    property.bestDeal ?? null,
    property.isLimited ?? null,
    offerEndsAt,
    projectName,
    developerName,
    property.searchTags ?? null,
    property.secondaryTags ?? null,
    property.buildingAmenities ?? null,      // text[]
    property.unitFeatures ?? null,           // text[]
    property.kitchenFeatures ?? null,        // text[]
    property.parkingAndAccess ?? null,       // text[]
    property.greenFeatures ?? null,          // text[]
    property.accessibilityFeatures ?? null,  // text[]
    property.safetyAndSecurity ?? null,      // text[]
    embeddingLiteral
  ];

  try {
    await client.connect();
    await client.query(q, params);
    await client.end();
    return res.status(200).json({ success: true, id: property.id });
  } catch (err) {
    console.error("Postgres upsert error:", err);
    try { await client.end(); } catch (_) {}
    return res.status(500).json({ error: "Database upsert failed" });
  }
}
