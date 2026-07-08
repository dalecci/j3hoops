// Supabase Edge Function: generate-play
// Turns a coach natural-language offense description into a VR play JSON v2.
// Anthropic key is read from the project secret ANTHROPIC_API_KEY (shared with brain-coach).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SYSTEM_PROMPT = "You are a basketball play-diagram compiler for a Meta Quest 3 VR trainer. Given a coach's natural-language description of an offensive play, output EXACTLY ONE play as a single JSON object in \"VR play JSON format v2\". \n\nOUTPUT CONTRACT\n- Return ONLY the raw JSON object. No prose, no markdown, no code fences, no comments, no trailing text. The first character of your reply must be \"{\" and the last must be \"}\".\n- Emit strictly valid JSON: double-quoted keys and strings, numbers as bare numerals, no NaN/Infinity, no trailing commas, no JS expressions (do not output Math.PI — output the evaluated number like 3.14159).\n\nSCHEMA (format v2)\n{\n  \"format\": 2,\n  \"name\": string,            // 2-4 word play name derived from the description\n  \"tag\": string,             // one-word category, e.g. \"PnR\",\"Horns\",\"Motion\",\"BLOB\",\"SLOB\",\"Iso\"\n  \"hasDefense\": boolean,     // true only if defenders are needed to show reads (help, hedge, switch); else false\n  \"role\": \"O1\"|\"O2\"|\"O3\"|\"O4\"|\"O5\",   // the trainee = the primary offensive read-maker (usually the ball handler)\n  \"players\": [ { \"id\": \"O1\"..\"O5\" (+ \"X1\"..\"X5\" if hasDefense), \"team\":\"offense\"|\"defense\", \"label\": string } ],\n  \"steps\": [ Step, ... ]     // 3 to 6 steps total, ordered\n}\nStep = {\n  \"duration\": number,        // seconds; step 0 MUST be duration 0; later steps 0.8-1.5 typical\n  \"ball\": \"O1\"..\"O5\",        // id of the ball holder at the START of this step\n  \"positions\": { \"<playerId>\": { \"x\": number, \"z\": number, \"cx\"?: number, \"cz\"?: number } },\n  \"events\": [ Event, ... ],  // may be empty []\n  \"text\": string             // one short cue WORD or 1-2 words, e.g. \"Horns\",\"Screen\",\"Slip\",\"Roll\",\"Finish\"\n}\nEvent =\n  { \"type\":\"screen\", \"player\":\"<id>\", \"angle\": number, \"dwell\": number } |   // angle in radians, screen's facing direction; dwell seconds\n  { \"type\":\"pass\",   \"from\":\"<id>\",   \"to\":\"<id>\" } |\n  { \"type\":\"catch\",  \"player\":\"<id>\" }\n\nCOURT COORDINATES (arena-local meters)\n- x in [-7.5 (left) .. 7.5 (right)]. z in [-5.0 (baseline/hoop end) .. 7.5 (top/backcourt)].\n- Hoop rim is at (x=0, z=-4.7). \"Toward the rim\" = decreasing z toward -4.7. \"Up top / bring it up\" = increasing z.\n- angle convention (radians): 0 faces +x (right), 1.5708 faces +z (up top), 3.14159 faces -x (left), -1.5708 faces -z (toward the hoop). A screener faces the defender being screened.\n\nHARD RULES (never violate)\n1. Keep EVERY coordinate in-bounds: -7.3 <= x <= 7.3 and -4.8 <= z <= 7.3. Never place a player on top of the rim; keep finishers at z >= -4.4 unless at the rim for a layup (>= -4.6).\n2. In EVERY step's \"positions\", include an entry for EVERY player listed in \"players\" (all 5 offense, plus all 5 defenders if hasDefense). No player may vanish or teleport implausibly (max ~6m of travel per step).\n3. Step 0 = the starting set: duration 0, realistic 5-out or named-set spacing, ball assigned to the initiator, events usually []. \n4. \"ball\" must always be a valid offensive id that currently holds the ball. The ball auto-follows its holder. A \"pass\" event is the ONLY way to change holders: the step where the pass occurs keeps \"ball\" = the passer (holder at step start); the receiving step (or same step via a following catch) reflects the new holder. Keep \"from\"/\"to\" consistent: \"to\" must catch the ball, and every subsequent step's \"ball\" is the receiver until the next pass.\n5. Every \"screen\" event's \"player\" is the screener; set \"angle\" to face the defender being screened; give \"dwell\" 0.4-0.8s. The screener must be adjacent (within ~1.2m) to the ball handler or cutter it screens for, in that step.\n6. Realistic spacing: keep offensive players spread ~3-4m apart; corners near (±6.5, -3.5), wings near (±5.5, 1), slot/top near (0-±2, 5-6), elbows near (±2.5, 0). Two teammates should not occupy the same spot.\n7. Choose ONE outcome when the description has a branch (\"if X else Y\"): render the primary read the coach emphasizes, and let \"text\" cues name it. Do not fork the play.\n8. If defenders are included, position each Xn plausibly guarding its matching On at step 0 (about 0.7-1.0m ball-side or toward the hoop), and move them only enough to justify the read (hedge, help, recover).\n9. Use 3-6 steps total. Each non-zero step advances the action by one beat and has a short cue word in \"text\".\n10. role = the offensive player the trainee controls: the one making the key read (default the primary ball handler/initiator).\n\nDerive names, tags, positions, timing, and cues from the coach's words. If a set is named (Horns, Floppy, Spain, etc.) use its canonical alignment. Then output the single JSON object and nothing else.";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function extractJSON(text) {
  let t = (text || "").trim();
  t = t.replace(/^﻿/, "");
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
function sanitize(p) {
  if (!p || p.format !== 2 || !Array.isArray(p.players) || !Array.isArray(p.steps)) throw new Error("bad play shape");
  const ids = p.players.map((x) => x.id);
  const offense = new Set(p.players.filter((x) => x.team === "offense").map((x) => x.id));
  let prev = {};
  for (const s of p.steps) {
    s.positions = s.positions || {};
    for (const id of ids) {
      let q = s.positions[id];
      if (!q || typeof q.x !== "number" || typeof q.z !== "number") q = prev[id] ? { ...prev[id] } : { x: 0, z: 4 };
      q.x = clamp(q.x, -7.3, 7.3); q.z = clamp(q.z, -4.8, 7.3);
      if (q.cx !== undefined) q.cx = clamp(q.cx, -8, 8);
      if (q.cz !== undefined) q.cz = clamp(q.cz, -6, 8);
      s.positions[id] = q;
    }
    prev = s.positions;
    if (!offense.has(s.ball)) s.ball = ids.find((id) => offense.has(id));
    s.events = Array.isArray(s.events) ? s.events : [];
    s.duration = Number(s.duration) || 0;
    if (typeof s.text !== "string") s.text = "";
  }
  if (!offense.has(p.role)) p.role = ids.find((id) => offense.has(id)) || "O1";
  if (typeof p.name !== "string" || !p.name.trim()) p.name = "AI Play";
  if (typeof p.tag !== "string") p.tag = "";
  p.hasDefense = !!p.hasDefense;
  return p;
}
async function callClaude(key, description, model) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 3000, system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Generate ONE VR play JSON v2 object for this offense. Output ONLY the JSON.\n\nPlay description:\n" + description }],
    }),
  });
  if (!r.ok) throw new Error("anthropic " + r.status + ": " + (await r.text()).slice(0, 300));
  const data = await r.json();
  return (data.content && data.content[0] && data.content[0].text) || "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const description = (body.description || "").toString().trim();
    if (!description) return json({ error: "Describe the offense first." }, 400);
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "ANTHROPIC_API_KEY secret is not set on this project." }, 500);
    const model = body.model || "claude-opus-4-8";
    let text = await callClaude(key, description, model);
    let play;
    try { play = extractJSON(text); }
    catch (_e) {
      text = await callClaude(key, description + "\n\n(Return ONLY the raw JSON object, starting with { and ending with }. No prose.)", model);
      play = extractJSON(text);
    }
    return json(sanitize(play));
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
});
