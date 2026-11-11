// Vercel serverless relay: OpenAI image edits (gpt-image family) for jeanphil.art.
// The Cloudflare worker can't reach OpenAI directly (region block); this
// function runs on AWS (US egress), so OpenAI accepts the call with the
// collection's own API key. Protected by a shared secret (RELAY_SECRET).
export const config = { maxDuration: 300 };

const MODELS = ["gpt-image-2.5-sunburst", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Relay-Key");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const secret = process.env.RELAY_SECRET;
  if (!secret || req.headers["x-relay-key"] !== secret) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: "no_key" });

  const { image_b64, prompt, size } = req.body || {};
  if (!image_b64 || !prompt) return res.status(400).json({ error: "bad request" });

  let lastErr = "no_model";
  for (const model of MODELS) {
    try {
      const form = new FormData();
      form.set("prompt", String(prompt).slice(0, 4000));
      form.set("size", size || "1536x1024");
      form.set("model", model);
      const bytes = Buffer.from(String(image_b64), "base64");
      form.append("image[]", new Blob([bytes], { type: "image/jpeg" }), "image.jpg");
      const r = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: "Bearer " + key },
        body: form,
        signal: AbortSignal.timeout(280000),
      });
      if (r.ok) {
        const d = await r.json();
        const b64 = d && d.data && d.data[0] && d.data[0].b64_json;
        if (b64) return res.status(200).json({ ok: true, b64, model });
        lastErr = "empty response";
        continue;
      }
      const body = (await r.text()).slice(0, 300);
      lastErr = "openai:" + r.status + ":" + body;
      const modelProblem = r.status === 404 || /model|not found|does not exist/i.test(body);
      if (!modelProblem) break; // real error (content, rate) - don't try other models
    } catch (e) {
      lastErr = String(e && e.message || e).slice(0, 300);
    }
  }
  return res.status(200).json({ ok: false, error: lastErr });
}
