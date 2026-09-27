import { handleRemoteRequest } from "../src/remote.js";

// Vercel's Web Standard entrypoint keeps the incoming body as a bounded stream.
export default {
  fetch(request: Request) {
    const url = new URL(request.url, "http://localhost");
    url.pathname = "/mcp";
    return handleRemoteRequest(new Request(url, request));
  },
};
