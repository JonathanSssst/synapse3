import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const transport = new StdioClientTransport({ command: 'E:\\Program\\NodeJS\\node.exe', args: [path.join(root, 'src', 'mcp-snowluma-safe.js')], cwd: root, stderr: 'pipe' });
const client = new Client({ name: 'list', version: '0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log('voice tools:', tools.map(t=>t.name).filter(n=>/voice|tts/i.test(n)).join(','));
await client.close();
process.exit(0);
