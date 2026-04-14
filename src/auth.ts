import type { Env } from "./types.js";

export function checkAuth(request: Request, env: Env): Response | null {
  const auth = request.headers.get("Authorization");
  if (!auth || auth !== `Bearer ${env.MCP_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
