/**
 * Agent Chat Endpoint
 * Handles Bahai Assistant conversations using OpenAI Agents SDK
 */

import { run } from '@openai/agents';
import { OpenAI } from 'openai';
import { bahaiAgent } from '../lib/bahai-agent.js';

// In-memory conversation store keyed by clientId.
// Note: In serverless, this may reset across cold starts; persist in a KV/db for durability if needed.
const conversationIdByClient = new Map();

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-client-id, x-conversation-id, x-new-chat");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  console.log('[Agent Chat] Request received');

  const { messages, clientId: clientIdInBody, conversationId: conversationIdInBody, isNewChat: isNewChatInBody } = req.body || {};

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

    // Resolve clientId (prefer header, fallback to body, else a simple per-request bucket)
    const clientId = (req.headers['x-client-id'] || clientIdInBody || 'default').toString();
    const conversationIdHeader = req.headers['x-conversation-id'];
    const isNewChat = req.headers['x-new-chat'] === 'true' || isNewChatInBody === true;
    let conversationId = (conversationIdHeader || conversationIdInBody || '').toString() || null;

    const openai = new OpenAI({
			apiKey: process.env.OPENAI_API_KEY  // Explicit
		});
    
    // If explicitly requesting new chat, clear any cached conversationId for this client
    if (isNewChat) {
      conversationIdByClient.delete(clientId);
      conversationId = null;
      console.log('[Agent Chat] New chat requested, cleared cached conversationId for client', clientId);
    }
    
    if (!conversationId) {
      // Try in-memory cache by client
      conversationId = conversationIdByClient.get(clientId) || null;
    }
    if (!conversationId) {
      const conv = await openai.conversations.create({});
      conversationId = conv.id;
      conversationIdByClient.set(clientId, conversationId);
      console.log('[Agent Chat] Created new conversationId for client', clientId, conversationId);
    }

    console.log('[Agent Chat] Running agent with conversation input');
    console.log('[Agent Chat] Input length:', conversationInput.length);
    console.log('[Agent Chat] Using conversationId:', conversationId);

    // Run the agent
    const result = await run(bahaiAgent, conversationInput, { conversationId });

    const responseText = result.finalOutput || '';
    console.log('[Agent Chat] Agent completed. Response length:', responseText.length);

    res.status(200).json({ 
      text: responseText,
      success: true,
      conversationId
    });
  } catch (error) {
    console.error('[Agent Chat] Error:', error);
    res.status(500).json({ 
      error: error.message || "Failed to process chat request",
      success: false
    });
  }
}

