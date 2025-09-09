import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
    model = "gpt-4o-mini",
    system,
    messages,
    temperature = 0.5,
  } = req.body;

  // Validate required fields
  if (!system || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ 
      error: "Missing required fields: system, messages (array)" 
    });
  }

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        ...messages
      ],
      temperature,
    });

    const result = response.choices[0]?.message?.content;
    
    if (!result) {
      return res.status(500).json({ error: "No response generated" });
    }

    res.status(200).json({ 
      text: result,
      usage: response.usage 
    });
  } catch (error) {
    console.error("Error generating text:", error);
    res.status(500).json({ 
      error: error.message || "Failed to generate text" 
    });
  }
}
