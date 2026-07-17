/* Loads the real-clip landmark fixture (Dale, 2026-06-27, 18s, 4 shots + 2 catches)
   captured once via MediaPipe — lets us regression-test the engine on REAL pose
   data without ever re-running the pose model. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// the fixture frames were extracted at 304x540 (portrait) — angles are only
// correct when the engine is told this aspect ratio
export const DALE_CLIP_ASPECT = 304/540;

export function loadDaleClip(){
  const p=join(dirname(fileURLToPath(import.meta.url)),"fixtures","dale_clip_landmarks.json");
  const raw=JSON.parse(readFileSync(p,"utf8"));
  return raw.map(f=>({t:f.t, lm:f.lm.map(([x,y,v])=>({x,y,v}))}));
}
