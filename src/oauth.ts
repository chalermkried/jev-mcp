import { createHmac, timingSafeEqual } from "node:crypto";

export function generateCode(clientId: string, clientSecret: string, redirectUri: string): string {
  const timestamp = Date.now().toString();
  const payload = `${clientId}|${redirectUri}|${timestamp}`;
  const signature = createHmac("sha256", clientSecret).update(payload).digest("hex");
  // Encode code as base64 to be safe for URLs, containing payload and signature
  return Buffer.from(`${payload}|${signature}`).toString("base64url");
}

export function validateCode(code: string, clientId: string, clientSecret: string): boolean {
  try {
    const decoded = Buffer.from(code, "base64url").toString("utf-8");
    const parts = decoded.split("|");
    if (parts.length !== 4) return false;

    const [cId, redirectUri, timestamp, signature] = parts;
    if (cId !== clientId) return false;

    // Code expires in 10 minutes (600,000 ms)
    const time = parseInt(timestamp, 10);
    if (isNaN(time) || Date.now() - time > 600000) return false;

    const payload = `${cId}|${redirectUri}|${timestamp}`;
    const expectedSignature = createHmac("sha256", clientSecret).update(payload).digest("hex");

    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedSignature, "hex"));
  } catch {
    return false;
  }
}
