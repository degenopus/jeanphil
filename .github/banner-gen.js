// banner-gen.js — runs on a GitHub-hosted runner.
// Reads the request written by the Cloudflare Worker (banner-req/<id>.json),
// calls OpenAI images/edits (runner egress reaches OpenAI), writes the
// result to banner-out/<id>.json. The workflow then commits both changes.
//
// Modes:
//  - repository_dispatch (REQ_ID set): process that request fast-path,
//    then sweep any other pending requests as a safety net.
//  - schedule / workflow_dispatch (no REQ_ID): sweep all pending requests.
//    This rescues requests whose dispatch never turned into a run.
const fs = require("fs");
const https = require("https");
const path = require("path");

const reqId = process.env.REQ_ID;

const MAX_PER_RUN = 3; // stay well inside free runner minutes

function writeOut(id, obj) {
  fs.mkdirSync("banner-out", { recursive: true });
  fs.writeFileSync(path.join("banner-out", id + ".json"), JSON.stringify(obj));
}

function b64ToBuffer(dataUrl) {
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

function postOpenAI(form) {
  return new Promise((resolve, reject) => {
    const boundary = "----jpboundary" + Date.now();
    const parts = [];
    for (const [k, v] of form.entries()) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"` +
        (v.filename ? `; filename="${v.filename}"` : "") +
        `\r\n${v.contentType ? "Content-Type: " + v.contentType + "\r\n" : ""}\r\n`
      ));
      parts.push(Buffer.isBuffer(v.value) ? v.value : Buffer.from(String(v.value)));
      parts.push(Buffer.from("\r\n"));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const req = https.request("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": body.length,
      },
      timeout: 300000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function processOne(id) {
  const reqPath = path.join("banner-req", id + ".json");
  let req;
  try {
    req = JSON.parse(fs.readFileSync(reqPath, "utf8"));
  } catch (e) {
    return; // file gone or broken — nothing to do
  }
  try {
    const form = new Map();
    form.set("prompt", { value: req.prompt });
    form.set("size", { value: req.size || "1024x1024" });
    form.set("image[]", { value: b64ToBuffer(req.image), filename: "image.png", contentType: "image/png" });
    if (req.mask) {
      form.set("mask", { value: b64ToBuffer(req.mask), filename: "mask.png", contentType: "image/png" });
    }

    // model fallback chain — the first model the key supports wins
    const models = ["gpt-image-2.5-sunburst", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"];
    let lastErr = null;
    for (const model of models) {
      const f = new Map(form);
      f.set("model", { value: model });
      const r = await postOpenAI(f);
      if (r.status === 200) {
        const d = JSON.parse(r.body);
        writeOut(id, { ok: true, image: "data:image/png;base64," + d.data[0].b64_json, model });
        console.log("ok", id, "with model", model);
        return;
      }
      const modelProblem = r.status === 404 || /model|not found|does not exist/i.test(r.body.slice(0, 300));
      lastErr = r.status + ":" + r.body.slice(0, 300);
      if (!modelProblem) break; // real error (content, rate) — don't try other models
    }
    writeOut(id, { ok: false, error: lastErr });
  } catch (e) {
    writeOut(id, { ok: false, error: String(e.message || e) });
  }
}

(async () => {
  const ids = [];
  if (reqId) ids.push(reqId);
  const dir = "banner-req";
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      const m = f.match(/^([a-z0-9]+)\.json$/i);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
  }
  const todo = ids.slice(0, MAX_PER_RUN);
  for (const id of todo) await processOne(id);
  fs.writeFileSync("processed_ids.txt", todo.join("\n"));
  console.log("processed:", todo.join(",") || "(none)");
})();
