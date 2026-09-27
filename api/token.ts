import { validateCode } from "../src/oauth.js";

function errorResponse(error: string, errorDescription: string, status = 400) {
  return Response.json({ error, error_description: errorDescription }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function getFirstMcpToken(env: NodeJS.ProcessEnv): string | null {
  if (env.MCP_ACCESS_TOKENS) {
    const tokens = env.MCP_ACCESS_TOKENS.split(",").map((t) => t.trim()).filter(Boolean);
    if (tokens.length > 0) return tokens[0];
  }
  return null;
}

export const config = { runtime: "edge" };

export default async function (request: Request) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }

    let clientId: string | null = null;
    let clientSecret: string | null = null;

    // Check Basic Auth first
    const authHeader = request.headers.get("authorization");
    if (authHeader && authHeader.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = Buffer.from(authHeader.substring(6), "base64").toString("utf-8");
        const colonIdx = decoded.indexOf(":");
        if (colonIdx > -1) {
          clientId = decoded.substring(0, colonIdx);
          clientSecret = decoded.substring(colonIdx + 1);
        }
      } catch {
        // Ignore malformed Basic Auth and fallback to body
      }
    }

    const contentType = request.headers.get("content-type") || "";
    let formData: URLSearchParams | null = null;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      try {
        const text = await request.text();
        formData = new URLSearchParams(text);
      } catch {
        return errorResponse("invalid_request", "Failed to parse URL encoded body");
      }
    } else if (contentType.includes("application/json")) {
       try {
          const body = await request.json();
          formData = new URLSearchParams();
          for (const key of Object.keys(body)) {
              if (body[key]) formData.set(key, String(body[key]));
          }
       } catch {
           return errorResponse("invalid_request", "Failed to parse JSON body");
       }
    }

    if (!formData) {
      return errorResponse("invalid_request", "Unsupported Content-Type");
    }

    const grantType = formData.get("grant_type");
    const code = formData.get("code");
    const redirectUri = formData.get("redirect_uri");

    // Fallback to body credentials if not in Basic Auth
    if (!clientId) clientId = formData.get("client_id");
    if (!clientSecret) clientSecret = formData.get("client_secret");

    if (grantType !== "authorization_code") {
      return errorResponse("unsupported_grant_type", "Only authorization_code grant is supported");
    }

    if (!code) {
      return errorResponse("invalid_request", "Missing code");
    }

    const configuredClientId = process.env.MCP_OAUTH_CLIENT_ID;
    const configuredClientSecret = process.env.MCP_OAUTH_CLIENT_SECRET;

    if (!configuredClientId || !configuredClientSecret) {
      return errorResponse("server_error", "OAuth is not configured on the server", 500);
    }

    if (clientId !== configuredClientId || clientSecret !== configuredClientSecret) {
      return errorResponse("invalid_client", "Client authentication failed", 401);
    }

    if (!validateCode(code, configuredClientId, configuredClientSecret)) {
      return errorResponse("invalid_grant", "Invalid or expired authorization code");
    }

    // According to OAuth 2.0, if a redirect_uri was included in the authorization request,
    // it MUST be included in the token request and match. Our encoded code contains the original URI.
    const decodedCode = Buffer.from(code, "base64url").toString("utf-8");
    const parts = decodedCode.split("|");
    if (redirectUri && redirectUri !== parts[1]) {
      return errorResponse("invalid_grant", "redirect_uri mismatch");
    }

    const token = getFirstMcpToken(process.env);
    if (!token) {
      return errorResponse("server_error", "MCP_ACCESS_TOKENS is not configured", 500);
    }

    return Response.json({
      access_token: token,
      token_type: "Bearer"
    }, {
      headers: { "Cache-Control": "no-store" }
    });
}
