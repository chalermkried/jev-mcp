import { handleRemoteRequest } from "../src/remote.js";

export default {
  fetch(request: Request) {
    const url = new URL(request.url, "http://localhost");
    url.pathname = "/health";
    return handleRemoteRequest(new Request(url, request));
  },
};
