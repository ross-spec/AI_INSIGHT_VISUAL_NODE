// Insight Proxy — holds the Gemini key server-side (free tier).
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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Gemini's current stable free-tier model (Google retired gemini-2.5-flash for new keys in 2026).
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

if (!GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not set. Requests will fail until it is configured.");
}

// Accepts the same { role, content } message shape used before (system/user), and calls
// Gemini's generateContent endpoint instead of OpenAI's chat/completions.
async function callGemini(messages) {
  const systemParts = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const conversationParts = messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));

  const body = {
    contents: conversationParts,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1300
    }
  };
  if (systemParts) {
    body.systemInstruction = { parts: [{ text: systemParts }] };
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + GEMINI_API_KEY;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("Gemini error " + resp.status + ": " + errText);
  }
  const data = await resp.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  return parts && parts.map(p => p.text || "").join("");
}

// Used by the InsightLens Power BI custom visual — receives a compact stats summary, not raw rows.
app.post("/api/insight", async (req, res) => {
  try {
    const summary = req.body && req.body.summary;
    const focus = (req.body && req.body.focus) || "overall";
    const focusLabel = (req.body && req.body.focusLabel) || "Overall summary";
    if (!summary) return res.status(400).json({ error: "Missing 'summary' in request body" });

    const focusInstructions = {
      overall: "Give a thorough, multi-angle analysis. Don't stop at the single biggest bucket in one field \u2014 walk through the breakdown of EVERY category field provided in categoryBreakdowns (not just the first), point out where distributions are skewed vs. even, and note any fields whose splits seem related to each other (e.g. one field's dominant value co-occurring with a pattern in another). Use exact counts from categoryBreakdowns throughout.",
      top_bottom: "Focus specifically on comparing the top and bottom performers. Explain the size of the gap and what it likely means. Recommendations should target closing that gap.",
      outliers: "Focus specifically on the outliers listed. For each notable outlier, explain why it stands out and what to check or do about it. If there are no outliers, say so plainly and explain what that implies.",
      trend: "Focus specifically on the trend over time. Describe the direction, whether it's accelerating/stable/reversing, and what action follows from that trajectory.",
      compare_measures: "Focus specifically on comparing the different measures against each other \u2014 where they agree, where they diverge, and what that combination implies that either measure alone would miss.",
      recommendation: "Skip background explanation. Go straight to a prioritized action list: the single most important thing to do first, then 2 more ranked by likely impact, each tied to a specific category/value from the data."
    };
    const instruction = focusInstructions[focus] || focusInstructions.overall;
    const isDeepDive = focus === "overall";

    const prompt = [
      "You are a senior business intelligence analyst embedded in a Power BI report.",
      "The user selected this specific angle of analysis: \"" + focusLabel + "\".",
      instruction,
      "",
      "CRITICAL ACCURACY RULES \u2014 follow these exactly:",
      "- Use ONLY the numbers, category names, and field names that literally appear in the JSON data below.",
      "- Never invent a category value, label, or count that is not present in \"categoryBreakdowns\", \"measureStats\", \"top\", \"bottom\", or \"outliers\" below.",
      "- Every count or number you state must be traceable to a specific value in the JSON. If you're unsure a number is exact, do not state it as exact \u2014 describe the pattern in words instead (e.g. \"a large share of cases\" rather than a made-up figure).",
      "- \"Row count\" is the total number of rows and is the only valid total to reference unless a measure sum is given.",
      "- If the data doesn't support a strong claim, say what the data shows is limited/inconclusive rather than filling the gap.",
      "",
      "Use this format:",
      "Key Finding: 1-2 sentences, citing specific values that exist in the JSON, directly addressing the selected angle.",
      "What's Driving It: " + (isDeepDive
        ? "A paragraph per notable category field in categoryBreakdowns (cover at least 3 fields if that many are provided), each citing the field's actual top values and counts, plus any cross-field pattern you can support with the given data."
        : "2-3 sentences of explanation relevant to that angle, grounded only in the given data."),
      "Recommendations:",
      "1. First concrete, specific action tied to a named category/value from the data.",
      "2. Second concrete action, different angle.",
      "3. Third action if the data supports it, otherwise omit.",
      "",
      "Category fields: " + (summary.categoryFields || []).join(", "),
      "Measure fields: " + (summary.measureFields || []).join(", ") + (summary.measureFields && summary.measureFields.length ? "" : " (none selected \u2014 all figures below are row COUNTS, not sums)"),
      "Row count (total rows in this view): " + summary.rowCount,
      "Measure stats: " + JSON.stringify(summary.measureStats),
      "Top (by primary measure or count): " + JSON.stringify(summary.top),
      "Bottom (by primary measure or count): " + JSON.stringify(summary.bottom),
      "Trend data: " + summary.trend,
      "Outliers: " + JSON.stringify(summary.outliers),
      "Exact category value frequency counts for EVERY category field (ground truth \u2014 use these for any breakdown claims, and for 'overall' cover multiple fields, not just the first): " + JSON.stringify(summary.categoryBreakdowns)
    ].join("\n");

    const text = await callGemini([
      { role: "system", content: "You are a precise, quantitative BI analyst. You never invent numbers, category names, or values that are not explicitly present in the user's JSON data. Follow the requested format exactly. No preamble, no closing pleasantries." },
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
    const text = await callGemini(messages);
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Insight proxy listening on port " + PORT));
