import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // --- Always set CORS headers ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const {
    query,
    filter_location,
		filter_ptype,
		filter_developer,
		filter_project,
    min_bedrooms,
		max_bedrooms,
		min_bathrooms,
		max_bathrooms,
		min_price,
    max_price,
    must_have_amenities,
		filter_latitude,
		filter_longitude,
		sort_by,
		requested_count,
		excluded_property_ids,
  } = req.body;

  // 1. Create embedding for user query
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;

  // 2. Search Supabase (documents table)
  const { data, error } = await supabase.rpc("search_properties_hybrid", {
    query_embedding: queryEmbedding,
    query_text: query,
    filter_location: filter_location,
		filter_ptype: filter_ptype,
		filter_developer: filter_developer,
		filter_project: filter_project,
    min_bedrooms: min_bedrooms,
		max_bedrooms: max_bedrooms,
    min_bathrooms: min_bathrooms,
		max_bathrooms: max_bathrooms,
		min_price: min_price,
    max_price: max_price,
    must_have_amenities: must_have_amenities,
		filter_latitude: filter_latitude,
		filter_longitude: filter_longitude,
		sort_by: sort_by,
		max_distance_km: 15,
    k: requested_count || 20,
		excluded_property_ids: excluded_property_ids,
    w_semantic: 0.6,
    w_keyword: 0.4,
  });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(200).json({ matches: data });
}
