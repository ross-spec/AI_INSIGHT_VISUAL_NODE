// Insight Proxy — holds the OpenAI key server-side.
// Used by DataIQ (chat-style analysis) and the InsightLens Power BI custom visual (/api/insight).
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "2mb" }));

// Restrict this in production to your real origins (Power BI service + your DataIQ host).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",");
app.use(cors({
  origin: allowedOrigins.includes("*") ? true : allowedOrigins
}));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!OPENAI_API_KEY) {
  console.warn("WARNING: OPENAI_API_KEY is not set. Requests will fail until it is configured.");
}

async function callOpenAI(messages) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + OPENAI_API_KEY
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 500
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("OpenAI error " + resp.status + ": " + errText);
  }
  const data = await resp.json();
  return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}

// Used by the InsightLens Power BI custom visual — receives a compact stats summary, not raw rows.
app.post("/api/insight", async (req, res) => {
  try {
    const summary = req.body && req.body.summary;
    if (!summary) return res.status(400).json({ error: "Missing 'summary' in request body" });

    const prompt = [
      "You are a business intelligence analyst embedded in a Power BI report.",
      "Given the following aggregated field summary, write a concise insight (2-4 sentences) describing what stands out,",
      "followed by one short, actionable recommendation. Do not restate raw numbers verbatim beyond what's needed; be specific and business-relevant.",
      "",
      "Category fields: " + (summary.categoryFields || []).join(", "),
      "Measure fields: " + (summary.measureFields || []).join(", "),
      "Row count: " + summary.rowCount,
      "Measure stats: " + JSON.stringify(summary.measureStats),
      "Top performers: " + JSON.stringify(summary.top),
      "Bottom performers: " + JSON.stringify(summary.bottom),
      "Trend: " + summary.trend,
      "Outliers: " + JSON.stringify(summary.outliers)
    ].join("\n");

    const text = await callOpenAI([
      { role: "system", content: "You write short, precise BI insights and one recommendation. No preamble." },
      { role: "user", content: prompt }
    ]);

    res.json({ insight: text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Used by DataIQ's existing "AI Analysis" chat feature — pass-through style, same shape as before but key stays server-side.
app.post("/api/chat", async (req, res) => {
  try {
    const messages = req.body && req.body.messages;
    if (!messages) return res.status(400).json({ error: "Missing 'messages' in request body" });
    const text = await callOpenAI(messages);
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Insight proxy listening on port " + PORT));
