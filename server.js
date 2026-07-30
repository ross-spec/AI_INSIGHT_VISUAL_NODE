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
      max_tokens: 900
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
    const focus = (req.body && req.body.focus) || "overall";
    const focusLabel = (req.body && req.body.focusLabel) || "Overall summary";
    if (!summary) return res.status(400).json({ error: "Missing 'summary' in request body" });

    const focusInstructions = {
      overall: "Give a full structured analysis covering the key finding, what's driving it, the trend, and recommendations.",
      top_bottom: "Focus specifically on comparing the top and bottom performers. Explain the size of the gap and what it likely means. Recommendations should target closing that gap.",
      outliers: "Focus specifically on the outliers listed. For each notable outlier, explain why it stands out and what to check or do about it. If there are no outliers, say so plainly and explain what that implies.",
      trend: "Focus specifically on the trend over time. Describe the direction, whether it's accelerating/stable/reversing, and what action follows from that trajectory.",
      compare_measures: "Focus specifically on comparing the different measures against each other \u2014 where they agree, where they diverge, and what that combination implies that either measure alone would miss.",
      recommendation: "Skip background explanation. Go straight to a prioritized action list: the single most important thing to do first, then 2 more ranked by likely impact, each tied to a specific category/value from the data."
    };
    const instruction = focusInstructions[focus] || focusInstructions.overall;

    const prompt = [
      "You are a senior business intelligence analyst embedded in a Power BI report.",
      "The user selected this specific angle of analysis: \"" + focusLabel + "\".",
      instruction,
      "",
      "Use this format:",
      "Key Finding: 1-2 sentences, citing specific values, directly addressing the selected angle.",
      "What's Driving It: 2-3 sentences of explanation relevant to that angle.",
      "Recommendations:",
      "1. First concrete, specific action tied to a named category/value from the data.",
      "2. Second concrete action, different angle.",
      "3. Third action if the data supports it, otherwise omit.",
      "",
      "Be specific and quantitative wherever the data supports it (cite actual category names and numbers). Avoid generic filler. Do not restate every number in the summary \u2014 pick the ones that matter for the selected angle.",
      "",
      "Category fields: " + (summary.categoryFields || []).join(", "),
      "Measure fields: " + (summary.measureFields || []).join(", "),
      "Row count: " + summary.rowCount,
      "Measure stats: " + JSON.stringify(summary.measureStats),
      "Top performers: " + JSON.stringify(summary.top),
      "Bottom performers: " + JSON.stringify(summary.bottom),
      "Trend data: " + summary.trend,
      "Outliers: " + JSON.stringify(summary.outliers)
    ].join("\n");

    const text = await callOpenAI([
      { role: "system", content: "You are a precise, quantitative BI analyst. Follow the requested format exactly. No preamble, no closing pleasantries." },
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
