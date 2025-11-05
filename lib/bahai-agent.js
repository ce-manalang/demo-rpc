/**
 * Bahai Assistant Agent Configuration
 */

import { Agent } from '@openai/agents';
import { queryAnalyzerTool, searchPropertiesTool, rerankPropertiesTool } from './search-properties-tool.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const instructions = fs.readFileSync(path.join(__dirname, '../prompts/bahai-agent.md'), 'utf-8');

/**
 * Bahai Real Estate Agent
 */
export const bahaiAgent = new Agent({
    name: 'Bahai Real Estate Assistant',
    instructions,
    tools: [queryAnalyzerTool, searchPropertiesTool, rerankPropertiesTool],
    model: 'gpt-4o',
});

