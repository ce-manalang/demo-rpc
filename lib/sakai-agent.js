/**
 * Sakai Car Dealership Assistant Agent Configuration
 */

import { Agent } from '@openai/agents';
import { queryAnalyzerTool, searchVehiclesTool, rerankVehiclesTool } from './search-vehicles-tool.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const instructions = fs.readFileSync(path.join(__dirname, '../prompts/sakai-agent.md'), 'utf-8');

/**
 * Sakai Car Dealership Assistant
 */
export const sakaiAgent = new Agent({
    name: 'Sakai Car Dealership Assistant',
    instructions,
    tools: [queryAnalyzerTool, searchVehiclesTool, rerankVehiclesTool],
    model: 'gpt-4o',
});

