// Minimal stdio MCP server for tests: echo (read-only) and add (nested JSON arg).
const {McpServer} = require('@modelcontextprotocol/sdk/server/mcp.js');
const {StdioServerTransport} = require('@modelcontextprotocol/sdk/server/stdio.js');
const {z} = require('zod');
const server = new McpServer({name: 'fixture', version: '1.0.0'});
server.registerTool('echo', {description: 'Echo text back', inputSchema: {text: z.string()}, annotations: {readOnlyHint: true}}, async ({text}) => ({content: [{type: 'text', text: 'echo: ' + text}]}));
server.registerTool('add', {description: 'Sum numbers', inputSchema: {nums: z.array(z.number()), label: z.string().optional()}}, async ({nums, label}) => ({content: [{type: 'text', text: (label || 'sum') + '=' + nums.reduce((a, b) => a + b, 0)}]}));
server.registerTool('scale', {description: 'Multiply two numbers (floats)', inputSchema: {factor: z.number(), value: z.number()}}, async ({factor, value}) => ({content: [{type: 'text', text: 'product=' + factor * value}]}));
server.registerTool('report', {description: 'Text + structured + non-text content', outputSchema: {total: z.number(), label: z.string()}}, async () => ({
  content: [
    {type: 'text', text: 'report text'},
    {type: 'image', data: 'aGVsbG8=', mimeType: 'image/png'},
    {type: 'resource', resource: {uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'resource body'}},
  ],
  structuredContent: {total: 6.5, label: 'sum'},
}));
server.registerTool('crash', {description: 'Exit the server process (liveness tests)'}, async () => { setTimeout(() => process.exit(1), 25); return {content: [{type: 'text', text: 'crashing'}]}; });
server.connect(new StdioServerTransport());
