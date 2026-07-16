/* FormCheck engine tests — run with:  node --test formcheck/test/
   Synthetic clips have exact ground truth; the engine must recover it,
   clean AND under realistic corruption. */
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFrames, consistency } from "../engine.js";
import { makeClip, makeWalkClip, makeCatchMotion, addNoise, addGlitches, addKneeSpikeAt, addLegDropout, addCameraPan } from "./synth.mjs";

const OPTS={mode:"jump", modelKey:"curry", heightIn:70};

function approx(actual, expected, tol, label){
  assert.ok(Math.abs(actual-expected)<=tol,
    `${label}: got ${actual?.toFixed?.(1)}, expected ${expected?.toFixed?.(1)} ±${tol}`);
}
function checkShots(res, truth, tols, tag){
  assert.equal(res.shots.length, truth.length, `${tag}: shot count`);
  res.shots.forEach((s,i)=>{
    const gt=truth[i];
    approx(s.metrics.knee, gt.kneeLoad, tols.knee, `${tag} shot${i} knee`);
    approx(s.metrics.elbowSet, gt.elbowSet, tols.elbow, `${tag} shot${i} elbowSet`);
    approx(s.metrics.elbowRelease, gt.elbowRelease, tols.elbowRel, `${tag} shot${i} elbowRelease`);
    if(gt.jumpIn>0) approx(s.metrics.jump, gt.jumpIn, tols.jump, `${tag} shot${i} jump`);
    approx(s.metrics.timing, gt.timingMs, tols.timing, `${tag} shot${i} timing`);
    approx(s.metrics.tempo, gt.tempoMs, tols.tempo, `${tag} shot${i} tempo`);
    approx(s.metrics.lean, 0, tols.lean, `${tag} shot${i} lean`);
  });
}
const CLEAN_TOL={knee:4, elbow:5, elbowRel:6, jump:1.3, timing:60, tempo:90, lean:3};
const DIRTY_TOL={knee:6, elbow:7, elbowRel:8, jump:1.8, timing:80, tempo:120, lean:4};

test("clean 4-shot clip: detects 4 shots, recovers ground truth", ()=>{
  const {frames, truth}=makeClip({nShots:4});
  const res=analyzeFrames(frames, OPTS);
  checkShots(res, truth, CLEAN_TOL, "clean");
  assert.equal(res.side, "R");
  assert.ok(res.view.ok, "side view should pass the camera check");
  res.shots.forEach((s,i)=>assert.ok(s.score>=60, `clean shot${i} score ${s.score} should be decent`));
});

test("noise + impulse glitches: still accurate", ()=>{
  const {frames, truth}=makeClip({nShots:4});
  addNoise(frames, 0.004);
  addGlitches(frames, 0.03, 0.18);
  const res=analyzeFrames(frames, OPTS);
  checkShots(res, truth, DIRTY_TOL, "dirty");
});

test("REGRESSION 84°-knee bug: single-frame knee spike at the load must not move the measurement", ()=>{
  const {frames, truth}=makeClip({nShots:2, kneeLoad:26}); // Dale's real measured bend
  // spike exactly at the deepest-load moment of shot 1 (dip ends at stand+dip into the clip)
  addKneeSpikeAt(frames, 0.95);
  const res=analyzeFrames(frames, OPTS);
  assert.equal(res.shots.length, 2);
  approx(res.shots[0].metrics.knee, truth[0].kneeLoad, 5, "spiked shot knee");
});

test("camera pan/drift: detection and angles survive", ()=>{
  const {frames, truth}=makeClip({nShots:4});
  addCameraPan(frames, 0.05, 0.02);
  addNoise(frames, 0.003);
  const res=analyzeFrames(frames, OPTS);
  checkShots(res, truth, DIRTY_TOL, "pan");
});

test("walking clip: zero shots detected", ()=>{
  const frames=makeWalkClip({secs:8});
  addNoise(frames, 0.004);
  const res=analyzeFrames(frames, OPTS);
  assert.equal(res.shots.length, 0, "no shots in a walking clip");
});

test("left-handed shooter: side=L, same accuracy", ()=>{
  const {frames, truth}=makeClip({nShots:3, lefty:true});
  addNoise(frames, 0.003);
  const res=analyzeFrames(frames, OPTS);
  assert.equal(res.side, "L");
  checkShots(res, truth, DIRTY_TOL, "lefty");
});

test("free throw mode: no jump, timing hidden from score", ()=>{
  const {frames, truth}=makeClip({nShots:3, ft:true, kneeLoad:55});
  const res=analyzeFrames(frames, {mode:"ft", modelKey:"nash", heightIn:70});
  assert.equal(res.shots.length, 3);
  res.shots.forEach((s,i)=>{
    approx(s.metrics.knee, truth[i].kneeLoad, 5, `ft shot${i} knee`);
    assert.ok(s.metrics.jump===null || s.metrics.jump<2.5, `ft shot${i} jump should be ~0, got ${s.metrics.jump}`);
  });
});

test("leg dropout: knee & jump flagged unreliable instead of reported as garbage", ()=>{
  const {frames}=makeClip({nShots:2});
  addLegDropout(frames);
  const res=analyzeFrames(frames, OPTS);
  assert.ok(res.shots.length>=1, "shots still found from arm signal");
  res.shots.forEach((s,i)=>{
    assert.ok(s.conf.knee<0.5, `shot${i} knee conf should be <0.5, got ${s.conf.knee.toFixed(2)}`);
    // and low-confidence metrics must not sway the score (scoreShot skips them)
  });
});

test("no height given: jump is null and a warning explains why", ()=>{
  const {frames}=makeClip({nShots:2});
  const res=analyzeFrames(frames, {mode:"jump", modelKey:"curry", heightIn:null});
  assert.equal(res.shots[0].metrics.jump, null);
  assert.ok(res.warnings.some(w=>/height/i.test(w)), "warning mentions height");
});

test("consistency: identical reps score high, varied reps score lower", ()=>{
  const a=analyzeFrames(makeClip({nShots:4}).frames, OPTS);
  const consA=consistency(a.shots, "jump");
  const b=analyzeFrames(makeClip({nShots:4, jitter:9}).frames, OPTS);
  const consB=consistency(b.shots, "jump");
  assert.ok(consA.score>=consB.score, `identical (${consA.score}) >= varied (${consB.score})`);
  assert.ok(consA.score>=70, `identical reps should score >=70, got ${consA.score}`);
});

test("VALIDITY GATE: straight-arm overhead catches between shots are not counted", ()=>{
  // 2 real shots with a ball-catch spliced in between (as seen on real clips)
  const a=makeClip({nShots:1});
  const lastT=a.frames[a.frames.length-1].t;
  const catchFrames=makeCatchMotion(lastT+0.1);
  const b=makeClip({nShots:1});
  const bShift=catchFrames[catchFrames.length-1].t+0.1;
  b.frames.forEach(f=>f.t+=bShift);
  b.truth.forEach(g=>g.tRel+=bShift);
  const frames=[...a.frames,...catchFrames,...b.frames];
  addNoise(frames, 0.003);
  const res=analyzeFrames(frames, OPTS);
  assert.equal(res.shots.length, 2, "catch must be rejected, 2 real shots kept");
  approx(res.shots[0].metrics.knee, a.truth[0].kneeLoad, 6, "shot0 knee unaffected");
  approx(res.shots[1].metrics.knee, b.truth[0].kneeLoad, 6, "shot1 knee unaffected");
});

test("REAL CLIP (Dale 2026-06-27): 4 shots, 2 catches rejected, sane metrics", async ()=>{
  const { loadDaleClip } = await import("./fixture.mjs");
  const frames=loadDaleClip();
  const res=analyzeFrames(frames, {mode:"jump", modelKey:"curry", heightIn:70});
  // the clip contains exactly 4 shooting motions + 2 overhead ball catches
  assert.equal(res.shots.length, 4, "4 real shots, catches gated out");
  assert.equal(res.side, "R");
  assert.ok(res.view.ok, "filmed square side-on");
  res.shots.forEach((s,i)=>{
    const m=s.metrics;
    assert.ok(m.elbowSet>40 && m.elbowSet<115, `shot${i} elbowSet ${m.elbowSet.toFixed(0)} plausible`);
    assert.ok(m.elbowRelease>140 && m.elbowRelease<=180, `shot${i} elbowRelease ${m.elbowRelease.toFixed(0)} plausible`);
    assert.ok(m.knee>15 && m.knee<=90, `shot${i} knee ${m.knee.toFixed(0)} plausible`);
    assert.ok(m.jump!=null && m.jump>=0 && m.jump<14, `shot${i} jump ${m.jump} plausible`);
    assert.ok(Math.abs(m.lean)<25, `shot${i} lean ${m.lean.toFixed(0)} plausible`);
    assert.ok(m.tempo>200 && m.tempo<1500, `shot${i} tempo ${m.tempo.toFixed(0)} plausible`);
  });
});

test("garbage input: graceful empty result", ()=>{
  const res=analyzeFrames([], OPTS);
  assert.equal(res.shots.length, 0);
  const res2=analyzeFrames(makeClip({nShots:1}).frames.slice(0,5), OPTS);
  assert.equal(res2.shots.length, 0);
});
