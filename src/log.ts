// stdout is the MCP JSON-RPC stream; diagnostics must go to stderr.
export const log = (message: string) => console.error(`[slack-desktop-mcp] ${message}`);
