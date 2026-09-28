import { createHmac } from "node:crypto";

function generateCode(clientId: string, clientSecret: string, redirectUri: string): string {
  const timestamp = Date.now().toString();
  const payload = `${clientId}|${redirectUri}|${timestamp}`;
  const signature = createHmac("sha256", clientSecret).update(payload).digest("hex");
  return Buffer.from(`${payload}|${signature}`).toString("base64url");
}

function errorRedirect(redirectUri: string, error: string, errorDescription: string, state: string | null) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", errorDescription);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url, "http://localhost");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const responseType = url.searchParams.get("response_type");
  const state = url.searchParams.get("state");

  // Validate required parameters
  if (!redirectUri) {
    return new Response("Missing redirect_uri", { status: 400 });
  }

  // Prevent Open Redirect: Only allow whitelisted redirect URIs
  const allowedRedirects = process.env.MCP_OAUTH_ALLOWED_REDIRECTS
    ? process.env.MCP_OAUTH_ALLOWED_REDIRECTS.split(",").map(r => r.trim())
    : ["https://oauth-redirect.googleusercontent.com/", "https://script.google.com/"];

  const isAllowed = allowedRedirects.some(allowed => redirectUri.startsWith(allowed));
  if (!isAllowed) {
    return new Response("Invalid redirect_uri", { status: 400 });
  }

  const configuredClientId = process.env.MCP_OAUTH_CLIENT_ID;
  const configuredClientSecret = process.env.MCP_OAUTH_CLIENT_SECRET;

  if (!configuredClientId || !configuredClientSecret) {
    return new Response("OAuth is not configured on the server", { status: 500 });
  }

  if (clientId !== configuredClientId) {
    return new Response("Invalid client_id", { status: 401 });
  }

  if (responseType !== "code") {
    return errorRedirect(redirectUri, "unsupported_response_type", "Only response_type=code is supported", state);
  }

  // Generate an authorization code
  const code = generateCode(configuredClientId, configuredClientSecret, redirectUri);

  // Redirect back to the client
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);

    return Response.redirect(redirect.toString(), 302);
  }
}
