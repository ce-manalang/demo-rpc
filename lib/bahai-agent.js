/**
 * Bahai Assistant Agent Configuration
 */

import { Agent } from '@openai/agents';
import { queryAnalyzerTool, searchPropertiesTool, rerankPropertiesTool } from './search-properties-tool.js';
import fs from 'fs';

const instructions = fs.readFileSync('./prompts/bahai-agent.md', 'utf-8');

/**
 * Bahai Real Estate Agent
 */
export const bahaiAgent = new Agent({
    name: 'Bahai Real Estate Assistant',
    instructions,
    tools: [queryAnalyzerTool, searchPropertiesTool, rerankPropertiesTool],
    model: 'gpt-4o',
});

