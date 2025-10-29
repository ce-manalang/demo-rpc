# Demo RPC - Bahai Assistant Backend

Serverless functions backend for Bahai Assistant AI chat, deployed on Vercel.

## Features

- **Agent Chat**: OpenAI Agents SDK-powered conversational AI for real estate
- **Property Search**: DatoCMS integration with intelligent property matching
- **Text Generation**: OpenAI GPT-4o for text generation
- **Vector Search**: Property embeddings and similarity search

## Setup

### Installation

```bash
npm install
```

### Environment Variables

Create a `.env` file in the root directory:

```bash
# Required: OpenAI API Key
OPENAI_API_KEY=sk-your-openai-api-key-here

# Required: DatoCMS Read-only API Token
DATOCMS_READONLY_API_TOKEN=your-datocms-token-here

# Optional: DatoCMS Configuration
DATOCMS_API_ENDPOINT=https://graphql.datocms.com/
DATOCMS_ENVIRONMENT=production
```

### Local Development

#### Using Vercel CLI (Recommended)

```bash
# Install Vercel CLI globally
npm install -g vercel

# Run development server
vercel dev
```

The API will be available at `http://localhost:3000` (or the port Vercel assigns).

#### Using Node.js Directly

For local testing without Vercel:

```bash
node api/agent-chat.js
```

**Note**: This requires a custom server wrapper. Use Vercel CLI for full local development.

## API Endpoints

### Agent Chat

**Endpoint**: `POST /api/agent-chat`

Conversational AI agent for real estate inquiries.

**Request**:
```json
{
  "messages": [
    { "role": "user", "content": "Show me 3 bedroom condos in Makati" },
    { "role": "bot", "content": "Here are some options..." },
    { "role": "user", "content": "What about BGC instead?" }
  ]
}
```

**Response**:
```json
{
  "text": "Here are 3-bedroom condos in BGC:\n\n## Property Name...",
  "success": true
}
```

**Features**:
- Automatically searches properties when needed
- Maintains conversation context
- Extracts search parameters from natural language
- Handles follow-up questions

### Generate Text

**Endpoint**: `POST /api/generate-text`

General-purpose text generation.

**Request**:
```json
{
  "system": "You are a helpful assistant",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "model": "gpt-4o-mini",
  "temperature": 0.5
}
```

**Response**:
```json
{
  "text": "Hello! How can I help you today?",
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 8,
    "total_tokens": 18
  }
}
```

## Architecture

### Agent Flow

1. **User sends message** → Frontend calls `/api/agent-chat`
2. **Agent analyzes query** → Determines if property search is needed
3. **Tool calling** → Agent calls `search_properties` tool if needed
4. **Property search** → Fetches and scores properties from DatoCMS
5. **Response generation** → Agent formats and returns natural language response

### File Structure

```
demo-rpc/
├── api/
│   ├── agent-chat.js      # Main agent endpoint
│   ├── generate-text.js   # Text generation
│   ├── search.js          # Vector search
│   └── ingest.js          # Data ingestion
├── lib/
│   ├── bahai-agent.js     # Agent configuration
│   └── search-properties-tool.js  # Property search logic
├── package.json
└── vercel.json            # Vercel deployment config
```

## Deployment

### Vercel (Recommended)

1. **Connect repository** to Vercel
2. **Set environment variables** in Vercel dashboard
3. **Deploy** automatically on push

```bash
# Manual deployment
vercel --prod
```

### Environment Variables in Vercel

Add these in the Vercel dashboard:

- `OPENAI_API_KEY`
- `DATOCMS_READONLY_API_TOKEN`
- `DATOCMS_API_ENDPOINT` (optional)
- `DATOCMS_ENVIRONMENT` (optional)

## Usage with Frontend

The frontend (`bahai.webapp`) calls this backend via `ApiClient.chatWithAgent()`:

```typescript
// In frontend
const response = await ApiClient.chatWithAgent(messages);
```

Configure the frontend to point to your deployed Vercel URL:

```bash
# In bahai.webapp/.env
VITE_AGENT_API_URL=https://your-demo-rpc.vercel.app
```

## Testing

### Test Agent Chat

```bash
curl -X POST http://localhost:3000/api/agent-chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "Show me affordable condos in Manila" }
    ]
  }'
```

### Expected Response

```json
{
  "text": "Here are some affordable condos in Manila:\n\n## Property 1...",
  "success": true
}
```

## Troubleshooting

### Agent not finding properties

- Check `DATOCMS_READONLY_API_TOKEN` is set
- Verify DatoCMS has properties with required fields
- Check console logs for search tool execution

### CORS errors

- Vercel functions have CORS enabled by default
- Check `Access-Control-Allow-Origin` headers in responses

### High latency

- Agent calls can take 5-15 seconds for property searches
- Consider implementing caching for frequently searched criteria
- Use streaming responses for better UX (future improvement)

## Development Tips

1. **Check logs**: Use Vercel dashboard or `vercel logs` for production logs
2. **Test locally**: Always test with `vercel dev` before deploying
3. **Monitor costs**: OpenAI API calls can be expensive, monitor usage
4. **Rate limiting**: Consider adding rate limiting for production

## License

MIT

