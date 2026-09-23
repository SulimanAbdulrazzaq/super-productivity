import { IncomingMessage, ServerResponse } from 'http';
import {
  getAssistantAccessScopes,
  isAssistantAccessEnabled,
  verifyAssistantCredential,
} from './assistant-access';
import {
  handleMcpMessage,
  INVALID_REQUEST,
  isAcceptedProtocolHeader,
  JsonRpcResponseBody,
  McpHttpReply,
  parseErrorReply,
  unsupportedVersionReply,
} from './mcp-protocol';
import { ForwardToRenderer, isToolGranted, listGrantedTools, runTool } from './mcp-tools';

/**
 * The HTTP side of the assistant (MCP) endpoint on the local REST API
 * listener. Everything that decides whether a request may run lives here, in
 * front of the protocol handler: the switch, Host and Origin, the method, the
 * credential (checked again once the body is in) and the size limits.
 */

// MCP requests are small: the largest is a capture with 8 KB of notes.
const MAX_BODY_BYTES = 64 * 1024;

export interface McpHttpDeps {
  isAllowedHost: (host: string | undefined) => boolean;
  isAtConcurrencyLimit: () => boolean;
  parseBearerToken: (header: string | undefined) => string | undefined;
  forward: ForwardToRenderer;
  serverVersion: string;
}

const writeReply = (
  res: ServerResponse,
  status: number,
  body?: JsonRpcResponseBody,
  extraHeaders: Record<string, string> = {},
): void => {
  if (body === undefined) {
    res.writeHead(status, extraHeaders);
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    /* eslint-disable-next-line @typescript-eslint/naming-convention */
    'Content-Type': 'application/json; charset=utf-8',
    /* eslint-disable-next-line @typescript-eslint/naming-convention */
    'Content-Length': String(Buffer.byteLength(json)),
    ...extraHeaders,
  });
  res.end(json);
};

const writeError = (
  res: ServerResponse,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void =>
  writeReply(
    res,
    status,
    { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message } },
    extraHeaders,
  );

const readBody = async (req: IncomingMessage): Promise<Buffer | 'TOO_LARGE'> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      return 'TOO_LARGE';
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

// A 401 names the scheme and nothing else. With `resource_metadata` a client
// would start OAuth discovery, which this endpoint does not offer.
const UNAUTHORIZED_HEADERS = {
  /* eslint-disable-next-line @typescript-eslint/naming-convention */
  'WWW-Authenticate': 'Bearer',
};

const isAuthorized = (credential: string | undefined): boolean =>
  credential !== undefined && verifyAssistantCredential(credential);

export const handleMcpHttpRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpHttpDeps,
): Promise<void> => {
  // DNS rebinding: only loopback names this server is known by.
  if (!deps.isAllowedHost(req.headers.host)) {
    writeError(res, 403, 'Invalid Host header');
    return;
  }

  // No browser may talk to this endpoint, including an opaque (`null`) origin
  // from a sandboxed frame or a file:// page. MCP clients send no Origin.
  // Checked before anything else answers, so a web page cannot even learn
  // whether assistant access is switched on.
  if (req.headers.origin !== undefined) {
    writeError(res, 403, 'Requests from web origins are not allowed');
    return;
  }

  if (!isAssistantAccessEnabled()) {
    writeError(res, 503, 'Assistant access is disabled');
    return;
  }

  // Stateless and JSON-only: no SSE stream to open (GET), no session to end
  // (DELETE).
  if (req.method !== 'POST') {
    writeError(res, 405, 'Method not allowed', { Allow: 'POST' });
    return;
  }

  const credential = deps.parseBearerToken(req.headers.authorization);
  if (!isAuthorized(credential)) {
    writeError(
      res,
      401,
      'A valid assistant access key is required',
      UNAUTHORIZED_HEADERS,
    );
    return;
  }

  if (!isAcceptedProtocolHeader(headerValue(req.headers['mcp-protocol-version']))) {
    const reply = unsupportedVersionReply();
    writeReply(res, reply.status, reply.body);
    return;
  }

  if (deps.isAtConcurrencyLimit()) {
    writeError(res, 429, 'Too many concurrent requests');
    return;
  }

  const raw = await readBody(req);
  if (raw === 'TOO_LARGE') {
    writeError(res, 413, 'Request body too large');
    return;
  }

  // Checked again now that the body is in: a request that was authorised when
  // its headers arrived must not run after the key was rotated or access was
  // switched off while its body was still arriving.
  if (!isAuthorized(credential)) {
    writeError(
      res,
      401,
      'A valid assistant access key is required',
      UNAUTHORIZED_HEADERS,
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    const reply = parseErrorReply();
    writeReply(res, reply.status, reply.body);
    return;
  }

  let reply: McpHttpReply;
  try {
    reply = await handleMcpMessage(
      parsed,
      { mcpMethod: headerValue(req.headers['mcp-method']) },
      {
        serverVersion: deps.serverVersion,
        listTools: () => listGrantedTools(getAssistantAccessScopes()),
        hasTool: (name) => isToolGranted(name, getAssistantAccessScopes()),
        callTool: (name, args) =>
          runTool(name, args, getAssistantAccessScopes, deps.forward),
      },
    );
  } catch {
    // Never the exception text: it can carry request content.
    writeError(res, 500, 'Internal error');
    return;
  }
  writeReply(res, reply.status, reply.body);
};
