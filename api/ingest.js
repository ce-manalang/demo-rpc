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
  const projectName = p.projectName || "";
  const developerName = p.developerName || "";
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
  // --- Always set CORS headers ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // --- Handle preflight (OPTIONS) ---
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    // Even 405 responses need the headers above
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message: property } = req.body;

    // Optional lightweight authorization
    const secretRequired = Boolean(process.env.INGEST_SECRET);
    if (secretRequired) {
      const header = req.headers["x-ingest-secret"];
      if (!header || header !== process.env.INGEST_SECRET) {
        return res
          .status(401)
          .json({ error: "Unauthorized (invalid ingest secret)" });
      }
    }

    if (!property || !property.id) {
      return res
        .status(400)
        .json({ error: "Request body must include property.id" });
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
    const offerEndsAt = property.offerEndsAt
      ? new Date(property.offerEndsAt).toISOString()
      : null;

    // Postgres client
    const client = new Client({ connectionString: process.env.DATABASE_URL });

    // Properties upsert query
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
      property.project,
      property.developer,
      property.searchTags ?? null,
      property.secondaryTags ?? null,
      property.buildingAmenities ?? null,
      property.unitFeatures ?? null,
      property.kitchenFeatures ?? null,
      property.parkingAndAccess ?? null,
      property.greenFeatures ?? null,
      property.accessibilityFeatures ?? null,
      property.safetyAndSecurity ?? null,
      embeddingLiteral,
    ];

    try {
      await client.connect();

      // upsert property
      await client.query(q, params);

      // ---- NEW: sync unit_configurations ----
      if (Array.isArray(property.unitConfiguration)) {
        // clear old rows for this property
        await client.query(
          "DELETE FROM unit_configurations WHERE property_id = $1",
          [property.id]
        );

        // insert each unit configuration
        for (const unit of property.unitConfiguration) {
          await client.query(
            `
            INSERT INTO unit_configurations (
              id, property_id, unit_name, unit_type, bedrooms,
              bathrooms, floor_area, config_price, unit_features
            )
            VALUES (
              gen_random_uuid(), $1, $2, $3, $4,
              $5, $6, $7, $8
            )
            `,
            [
              property.id,
              unit.unitName ?? null,
              unit.unitType ?? null,
              unit.bedrooms ?? null,
              unit.bathrooms ?? null,
              unit.floorArea ?? null,
              unit.configPrice ?? null,
              unit.unitFeatures ?? null, // raw text
            ]
          );
        }
      }
      // ---- end new ----

      await client.end();
      return res.status(200).json({ success: true, id: property.id });
    } catch (err) {
      console.error("Postgres upsert error:", err);
      try {
        await client.end();
      } catch (_) {}
      return res.status(500).json({ error: "Database upsert failed" });
    }
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
