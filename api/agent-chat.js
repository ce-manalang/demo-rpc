/**
 * Agent Chat Endpoint
 * Handles Bahai Assistant conversations using OpenAI Agents SDK
 */

import { run } from '@openai/agents';
import { bahaiAgent } from '../lib/bahai-agent.js';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  console.log('[Agent Chat] Request received');

  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ 
      error: "Missing required field: messages (array)" 
    });
  }

  try {
    // Build conversation input from messages
    // Expected format: [{ role: 'user', content: '...' }, { role: 'bot', content: '...' }, ...]
    const conversationInput = messages
      .map((m) => `${m.role === 'bot' ? 'assistant' : m.role}: ${m.content}`)
      .join('\n');

    console.log('[Agent Chat] Running agent with conversation input');
    console.log('[Agent Chat] Input length:', conversationInput.length);

    // Run the agent
    const result = await run(bahaiAgent, conversationInput);

    const responseText = result.finalOutput || '';
    console.log('[Agent Chat] Agent completed. Response length:', responseText.length);

    res.status(200).json({ 
      text: responseText,
      success: true
    });
  } catch (error) {
    console.error('[Agent Chat] Error:', error);
    res.status(500).json({ 
      error: error.message || "Failed to process chat request",
      success: false
    });
  }
}

