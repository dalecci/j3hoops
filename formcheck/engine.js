/* FormCheck analysis engine — pure module, no DOM.
   Used by index.html (browser) and test/engine.test.mjs (Node).

   Input frames: [{t:seconds, lm:[33 x {x,y,z?,v}]}] normalized image coords, y down.
   All body-relative signals are normalized by torso length so camera pan/zoom
   and player size cannot skew measurements. */

export const L = {nose:0, Lsh:11,Rsh:12, Lel:13,Rel:14, Lwr:15,Rwr:16, Lhip:23,Rhip:24, Lkn:25,Rkn:26, Lan:27,Ran:28};

/* ---------------- math utils ---------------- */
export function angle(a,b,c){ // interior angle at b, degrees
  const ab={x:a.x-b.x,y:a.y-b.y}, cb={x:c.x-b.x,y:c.y-b.y};
  const dot=ab.x*cb.x+ab.y*cb.y;
  const m=Math.hypot(ab.x,ab.y)*Math.hypot(cb.x,cb.y)||1e-6;
  return Math.acos(Math.max(-1,Math.min(1,dot/m)))*180/Math.PI;
}
export const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const mean=a=>a.reduce((s,x)=>s+x,0)/(a.length||1);
export const std=a=>{const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2)));};
export function median(a){ if(!a.length)return 0; const b=a.slice().sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; }
// Median filter deletes single-frame pose spikes (impulse noise). Never mean-smooth
// an angle series before measuring — it smears a 1-frame glitch too wide for the
// median to remove (the old "84° knee" bug).
export function medianFilter(arr,win){ return arr.map((_,i)=>{ const s=[]; for(let k=-win;k<=win;k++){ const j=i+k; if(j>=0&&j<arr.length) s.push(arr[j]); } return median(s); }); }
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

/* ---------------- metric definitions ---------------- */
// phase: which checkpoint the metric belongs to (load / set / release / finish)
// tag: "measured" = trustworthy from 2D side view (per pose-accuracy studies),
//      "est" = estimate (release-instant values at ~30fps, scaled distances, trajectories)
export const METRICS = {
  knee:        {label:"Knee bend at load",        unit:"°",  phase:"load",    tag:"measured"},
  elbowLoad:   {label:"Elbow in the pocket",      unit:"°",  phase:"load",    tag:"measured", cueOnly:true},
  elbowSet:    {label:"Elbow at set point (the L)",unit:"°", phase:"set",     tag:"measured"},
  setpt:       {label:"Set point height",          unit:"",   phase:"set",    tag:"measured"},
  tempo:       {label:"Shot tempo (dip→release)",  unit:"ms", phase:"set",    tag:"measured"},
  elbowRelease:{label:"Arm extension at release",  unit:"°",  phase:"release", tag:"est"},
  lean:        {label:"Trunk lean at release",     unit:"°",  phase:"release", tag:"measured"},
  timing:      {label:"Release vs jump apex",      unit:"ms", phase:"release", tag:"est"},
  jump:        {label:"Jump height (est.)",        unit:'"',  phase:"release", tag:"est"},
  arc:         {label:"Release arc (est.)",        unit:"°",  phase:"release", tag:"est", cueOnly:true},
  elbowFinish: {label:"Arm stays long (finish)",   unit:"°",  phase:"finish",  tag:"measured"},
  follow:      {label:"Follow-through hold",       unit:"%",  phase:"finish",  tag:"est"},
  balance:     {label:"Landing drift",             unit:'"',  phase:"finish",  tag:"est"},
};
export const METRIC_ORDER = ["knee","elbowLoad","elbowSet","setpt","tempo","elbowRelease","lean","timing","jump","arc","elbowFinish","follow","balance"];

/* ---------------- model profiles ----------------
   Target ranges seeded from published shooting data / coaching consensus.
   setpt unit = % of torso length above nose (camera- and size-independent).
   balance / jump in inches (scaled by player height). */
export const MODELS = {
  curry: {
    name:"Curry", emoji:"🏀", badge:"QUICK · DEEP RANGE",
    tag:"Low dip → fast high release",
    desc:"Stephen Curry shoots <b>on the way up</b> with a deep leg load and a low gather that whips into a high, lightning-quick release (~0.4s). Power comes from the legs, which is how he shoots from the logo.",
    dip:0.9, jump:1, hold:0.5, tempo:0.85,
    targets:{
      elbowSet:{min:80,max:100,ideal:90,cue:"Form an L — elbow under the ball, ~90° before you push up."},
      elbowLoad:{min:55,max:110,ideal:80,cue:"Relaxed fold in the dip — pros measure ~60° here.",cueOnly:true},
      elbowRelease:{min:150,max:180,ideal:163,cue:"Long arm through the ball — pros measure ~160°, not a locked 180°."},
      elbowFinish:{min:145,max:180,ideal:162,cue:"Keep the arm extended — don't pull the follow-through down."},
      knee:{min:45,max:75,ideal:62,cue:"Load deep — pros bend ~60°+ from range. Legs are your power."},
      lean:{min:-8,max:6,ideal:-1,cue:"Stay tall or a hair back at release — leaning forward is the #1 miss pattern in studies."},
      timing:{min:-180,max:30,ideal:-90,cue:"Release before the top of your jump — shoot on the rise."},
      tempo:{min:240,max:520,ideal:380,cue:"One fast, fluid motion — no hitch."},
      setpt:{min:-10,max:38,ideal:14,cue:"Bring the ball up past your forehead before release."},
      jump:{min:2,max:20,ideal:10,cue:"Elite shooters use ~75% of max hop on a jumper — rhythm beats height."},
      follow:{min:60,max:100,ideal:80,cue:"Hold the goose-neck until the ball lands."},
      balance:{min:0,max:8,ideal:2,cue:"Land where you took off — square and balanced."},
      arc:{min:46,max:56,ideal:51,cue:"High release ≈ 45° rim entry — Noah's 600M-shot sweet spot.",cueOnly:true}
    }
  },
  klay: {
    name:"Klay", emoji:"🎯", badge:"CATCH & SHOOT",
    tag:"No dip · machine repeatable",
    desc:"Klay Thompson is the textbook catch-and-shoot: almost <b>no dip</b>, ball held high, and the same exact motion every single rep (0.79s catch-to-release). Repeatability over flash.",
    dip:0.35, jump:0.85, hold:0.6, tempo:0.8,
    targets:{
      elbowSet:{min:80,max:100,ideal:90,cue:"Elbow stacked under the ball, ~90° at the set point."},
      elbowLoad:{min:65,max:115,ideal:88,cue:"Ball stays high — minimal fold in the dip.",cueOnly:true},
      elbowRelease:{min:150,max:180,ideal:163,cue:"Same long extension every rep — ~160° is the pro number."},
      elbowFinish:{min:145,max:180,ideal:162,cue:"Same long finish every time."},
      knee:{min:38,max:68,ideal:52,cue:"Light, consistent dip — quick legs, don't over-sink."},
      lean:{min:-8,max:6,ideal:-1,cue:"Square and tall at release — no drifting into the shot."},
      timing:{min:-150,max:40,ideal:-60,cue:"Catch and rise — release quick off the gather."},
      tempo:{min:220,max:460,ideal:330,cue:"Minimal dip = fastest path to release."},
      setpt:{min:0,max:45,ideal:20,cue:"Start high — no wasted dip below the chest."},
      jump:{min:1,max:18,ideal:8,cue:"Efficient hop — feet under you."},
      follow:{min:60,max:100,ideal:80,cue:"Same finish every rep — square and held."},
      balance:{min:0,max:7,ideal:2,cue:"Feet square, no drift — identical landing each time."},
      arc:{min:44,max:52,ideal:48,cue:"Repeatable ~47° launch → 45° rim entry.",cueOnly:true}
    }
  },
  nash: {
    name:"Nash", emoji:"🪣", badge:"90% EFFICIENCY",
    tag:"Elbow tuck · perfect finish",
    desc:"Steve Nash is the most efficient shooter ever (90%+ FT). Tucked elbow, dead-straight line, deliberate rhythm, and a follow-through held <b>until the ball lands</b>. The blueprint for free throws.",
    dip:0.5, jump:0, hold:0.95, tempo:0.55,
    targets:{
      elbowSet:{min:82,max:100,ideal:92,cue:"Tuck the elbow in to ~90° — straight line to the rim."},
      elbowLoad:{min:55,max:110,ideal:80,cue:"Soft arms in the rhythm dip.",cueOnly:true},
      elbowRelease:{min:150,max:180,ideal:163,cue:"Reach into the cookie jar — measured FT release is ~160°."},
      elbowFinish:{min:150,max:180,ideal:165,cue:"Hold the finish until the ball hits the rim."},
      knee:{min:35,max:70,ideal:55,cue:"Soft, rhythmic dip — measured FT knee bend is ~58°."},
      lean:{min:-6,max:4,ideal:0,cue:"Dead vertical — proficient FT shooters don't lean."},
      timing:{min:-9999,max:9999,ideal:0,cue:"",cueOnly:true},
      tempo:{min:400,max:800,ideal:580,cue:"Smooth, unhurried rhythm — same every time."},
      setpt:{min:-8,max:32,ideal:10,cue:"Consistent set point at the forehead."},
      jump:{min:0,max:14,ideal:5,cue:"Quiet legs — lift, don't leap.",cueOnly:true},
      follow:{min:75,max:100,ideal:92,cue:"Hold the finish until the ball hits the rim."},
      balance:{min:0,max:6,ideal:1,cue:"Rock-solid base, zero drift."},
      arc:{min:45,max:54,ideal:49,cue:"Soft ~49° arc with backspin ≈ 45° entry.",cueOnly:true}
    }
  }
};

const RIGHT={sh:L.Rsh,el:L.Rel,wr:L.Rwr,hip:L.Rhip,kn:L.Rkn,an:L.Ran};
const LEFT ={sh:L.Lsh,el:L.Lel,wr:L.Lwr,hip:L.Lhip,kn:L.Lkn,an:L.Lan};
export const J = side => side==="R" ? RIGHT : LEFT;

const USED=[L.nose,L.Lsh,L.Rsh,L.Lel,L.Rel,L.Lwr,L.Rwr,L.Lhip,L.Rhip,L.Lkn,L.Rkn,L.Lan,L.Ran];

const mid=(a,b)=>({x:(a.x+b.x)/2, y:(a.y+b.y)/2, v:Math.min(a.v,b.v)});

/* ---------------- 1 · glitch repair ----------------
   MediaPipe occasionally teleports a joint for 1-2 frames (impulse noise).
   If a joint jumps > 35% of torso length in one frame and snaps back within
   2 frames, the excursion is physically impossible — interpolate across it. */
function repairGlitches(frames, torso){
  const N=frames.length, thr=0.35*torso;
  const glitchCount={};
  USED.forEach(li=>glitchCount[li]=0);
  USED.forEach(li=>{
    for(let i=1;i<N-1;i++){
      const prev=frames[i-1].lm[li], cur=frames[i].lm[li];
      if(prev.v<0.3) continue;
      if(dist(prev,cur)>thr){
        // find a return point within 2 frames
        let ret=-1;
        for(let j=i+1;j<=Math.min(N-1,i+2);j++){
          if(dist(prev,frames[j].lm[li])<thr){ ret=j; break; }
        }
        if(ret>0){
          for(let k=i;k<ret;k++){
            const f=(k-(i-1))/(ret-(i-1));
            const a=frames[i-1].lm[li], b=frames[ret].lm[li];
            frames[k].lm[li]={x:a.x+(b.x-a.x)*f, y:a.y+(b.y-a.y)*f, v:Math.min(a.v,b.v)};
            glitchCount[li]++;
          }
          i=ret;
        }
      }
    }
  });
  return glitchCount;
}

/* ---------------- 2 · signals ---------------- */
function torsoLen(f){
  return dist(mid(f.lm[L.Lsh],f.lm[L.Rsh]), mid(f.lm[L.Lhip],f.lm[L.Rhip]));
}
export function pickSide(frames){
  // shooting arm = wrist that rises highest above its own shoulder (torso units)
  let lBest=-9, rBest=-9;
  frames.forEach(f=>{
    const t=torsoLen(f)||1e-3;
    lBest=Math.max(lBest,(f.lm[L.Lsh].y-f.lm[L.Lwr].y)/t);
    rBest=Math.max(rBest,(f.lm[L.Rsh].y-f.lm[L.Rwr].y)/t);
  });
  return rBest>=lBest ? "R":"L";
}
// side-view check: in a true side view the two shoulders overlap in x.
function viewCheck(frames){
  const r=frames.map(f=>{
    const t=torsoLen(f)||1e-3;
    return Math.abs(f.lm[L.Lsh].x-f.lm[L.Rsh].x)/t;
  });
  const m=median(r);
  return {ratio:m, ok:m<0.55, msg:m<0.55?null:"Camera isn't square side-on — angles may read shallow. Film from directly beside the shooter."};
}
// visibility-weighted knee flexion from BOTH legs (robust to side-view leg overlap)
export function kneeFlexion(lm){
  const kl=angle(lm[L.Lhip],lm[L.Lkn],lm[L.Lan]), vl=Math.min(lm[L.Lhip].v,lm[L.Lkn].v,lm[L.Lan].v);
  const kr=angle(lm[L.Rhip],lm[L.Rkn],lm[L.Ran]), vr=Math.min(lm[L.Rhip].v,lm[L.Rkn].v,lm[L.Ran].v);
  const w=vl+vr;
  const interior = w<0.2 ? (kl+kr)/2 : (kl*vl+kr*vr)/w;
  return clamp(180-interior, 0, 90);
}

/* ---------------- main entry ---------------- */
/* opts: {mode:'jump'|'ft', modelKey:'curry'|'klay'|'nash', heightIn:number|null}
   returns {shots, side, view, quality, avgVis, personPx, warnings} */
export function analyzeFrames(frames, opts={}){
  const mode=opts.mode||"jump";
  const modelKey=opts.modelKey||"curry";
  const heightIn=opts.heightIn||null;
  const N=frames.length;
  if(N<8) return {shots:[], side:"R", view:{ok:true}, quality:"warn", warnings:["Too few frames tracked."]};

  const torso=median(frames.map(torsoLen))||0.15;
  const glitchCount=repairGlitches(frames, torso);
  const side=pickSide(frames);
  const j=J(side);
  const view=viewCheck(frames);

  // raw angle series (post-repair, pre-smoothing) → median filter
  const rawKnee=frames.map(f=>kneeFlexion(f.lm));
  const rawElbow=frames.map(f=>angle(f.lm[j.sh],f.lm[j.el],f.lm[j.wr]));
  // 3-frame medians only: wide windows erode the brief extremes we measure —
  // the flexion peak at the load and the sharp elbow "V" at the set point —
  // and systematically mis-read them by 5-8°. Impulse spikes are already
  // handled by glitch repair; the tight median catches the rest.
  const kneeMF=medianFilter(rawKnee,1), elbowMF=medianFilter(rawElbow,1);

  const legVis=frames.map(f=>Math.min(f.lm[j.hip].v,f.lm[j.kn].v,f.lm[j.an].v));
  const armVis=frames.map(f=>Math.min(f.lm[j.sh].v,f.lm[j.el].v,f.lm[j.wr].v));

  // camera-independent lift signal: shooting wrist height above mid-hip, in torso units
  const series=frames.map((f,i)=>{
    const hipM=mid(f.lm[L.Lhip],f.lm[L.Rhip]);
    const ankM=mid(f.lm[L.Lan],f.lm[L.Ran]);
    return {
      t:f.t,
      lift:(hipM.y-f.lm[j.wr].y)/torso,
      wristY:f.lm[j.wr].y, shoulderY:f.lm[j.sh].y, noseY:f.lm[L.nose].y,
      hipY:hipM.y, ankleY:ankM.y, ankleX:ankM.x,
      elbow:elbowMF[i], knee:kneeMF[i],
      legVis:legVis[i], armVis:armVis[i],
      lm:f.lm
    };
  });
  const hipYs=medianFilter(series.map(s=>s.hipY),1);
  const ankleYs=medianFilter(series.map(s=>s.ankleY),1);

  // person pixel height for inch conversion: standing nose→ankle * 1.08 (head top)
  const standingIdx=series.map((s,i)=>i).filter(i=>series[i].knee<18 && series[i].lift<0.4);
  const baseIdx=standingIdx.length?standingIdx:series.map((_,i)=>i);
  const personPx=median(baseIdx.map(i=>(series[i].ankleY-series[i].noseY)))*1.08;
  const inchScale=(heightIn&&personPx>0.05)? heightIn/personPx : null;

  /* ---- shot detection: peaks of lift with prominence ---- */
  const lift=series.map(s=>s.lift);
  const dt=N>1?(series[N-1].t-series[0].t)/(N-1):0.05;
  const minSep=Math.max(3,Math.round(0.8/dt));
  const cands=[];
  for(let i=2;i<N-2;i++){
    if(lift[i]>1.0 && lift[i]>=lift[i-1] && lift[i]>=lift[i+1] && lift[i]>lift[i-2] && lift[i]>=lift[i+2]) cands.push(i);
  }
  const peaks=[];
  cands.forEach(i=>{
    if(!peaks.length){ peaks.push(i); return; }
    const last=peaks[peaks.length-1];
    // separate shots need a real valley (ball comes back down) between peaks
    let valley=Infinity; for(let k=last;k<=i;k++) valley=Math.min(valley,lift[k]);
    if(i-last>=minSep && valley < Math.min(lift[last],lift[i])-0.5) peaks.push(i);
    else if(lift[i]>lift[last]) peaks[peaks.length-1]=i;
  });

  const liftMF=medianFilter(lift,1);
  const shots=[];
  peaks.forEach((pk,si)=>{
    const prevEnd = si>0 ? peaks[si-1]+2 : 0;
    const backLimit=Math.max(prevEnd, pk-Math.round(3.5/dt));
    // DIP = the LATEST local minimum of the (filtered) lift signal before the rise
    // to this peak — not the global minimum of the window, which would grab a
    // dribble or an earlier gather and wreck the tempo measurement.
    let dipIdx=-1;
    const thrDip=Math.min(0.6, lift[pk]-0.5);
    for(let i=pk-1;i>backLimit;i--){
      if(liftMF[i]<=thrDip && liftMF[i]<=liftMF[i-1] && liftMF[i]<=liftMF[i+1]){ dipIdx=i; break; }
    }
    if(dipIdx<0){ dipIdx=backLimit; for(let i=backLimit;i<=pk;i++){ if(lift[i]<lift[dipIdx]) dipIdx=i; } }

    // SET POINT: min elbow while wrist is above shoulder, between dip and peak
    let setIdx=-1, bestElb=999;
    for(let i=dipIdx;i<=pk;i++){ const s=series[i]; if(s.wristY<s.shoulderY && s.elbow<bestElb){ bestElb=s.elbow; setIdx=i; } }
    if(setIdx<0){ setIdx=Math.round((dipIdx+pk)/2); for(let i=setIdx;i<=pk;i++){ if(series[i].elbow<series[setIdx].elbow) setIdx=i; } }

    // RELEASE: first frame after set where the arm is extended (≥152°) with wrist
    // above the nose — the ball leaves here, slightly before the wrist peak.
    let relIdx=pk;
    for(let i=setIdx;i<=Math.min(N-1,pk+2);i++){
      const s=series[i];
      if(s.elbow>=152 && s.wristY<s.noseY){ relIdx=i; break; }
    }
    if(relIdx<setIdx) relIdx=pk;

    // FINISH window: ~0.45s after release
    const finEnd=Math.min(N-1, relIdx+Math.max(2,Math.round(0.45/dt)));

    // APEX of the jump: highest hip between dip and shortly after release
    let apexIdx=relIdx;
    const aw1=Math.min(N-1, relIdx+Math.round(0.5/dt));
    for(let i=dipIdx;i<=aw1;i++){ if(hipYs[i]<hipYs[apexIdx]) apexIdx=i; }

    // JUMP HEIGHT: ankle rise above the standing baseline (feet actually leaving the floor)
    const baseW0=Math.max(backLimit, dipIdx-Math.round(0.8/dt));
    const baseCand=[]; for(let i=baseW0;i<=dipIdx;i++){ if(series[i].knee<25) baseCand.push(ankleYs[i]); }
    const ankleBase= baseCand.length?median(baseCand):median(series.slice(baseW0,dipIdx+1).map((_,k)=>ankleYs[baseW0+k]));
    let ankleMin=ankleBase;
    for(let i=Math.max(dipIdx,relIdx-3);i<=aw1;i++){ ankleMin=Math.min(ankleMin,ankleYs[i]); }
    const flight=Math.max(0, ankleBase-ankleMin);
    const jumpIn= inchScale!=null ? (flight<0.012?0:flight*inchScale) : null;

    // liftoff/landing for balance drift
    const liftThr=Math.max(0.01, 0.4*flight);
    let liftoffIdx=relIdx, landIdx=finEnd;
    for(let i=Math.max(dipIdx,relIdx-Math.round(0.4/dt));i<=aw1;i++){ if(ankleBase-ankleYs[i]>liftThr){ liftoffIdx=i; break; } }
    for(let i=apexIdx;i<=finEnd;i++){ if(ankleBase-ankleYs[i]<liftThr*0.5){ landIdx=i; break; } }

    // LOAD: deepest reliable knee flexion in the gather — BEFORE the set point and
    // liftoff, and only while the hips are NOT rising fast. Once airborne (or
    // springing up) the shins fold back, which reads as deep knee flexion and
    // used to inflate the "load" by 30°+ on real clips.
    const loadEnd=Math.max(dipIdx, Math.min(setIdx, liftoffIdx));
    const hipRising=i=> i>=2 && (hipYs[i-2]-hipYs[i])/torso > 0.08;
    const cand=[];
    for(let i=Math.max(backLimit,dipIdx-Math.round(0.4/dt));i<=loadEnd;i++){
      if(series[i].legVis>0.5 && !hipRising(i)) cand.push({i,flex:series[i].knee});
    }
    let loadIdx, loadFlex, loadConf;
    if(cand.length>=3){
      let best=cand[0]; cand.forEach(c=>{ if(c.flex>best.flex) best=c; });
      loadIdx=best.i; loadFlex=best.flex;
      loadConf=series[loadIdx].legVis;
    } else {
      loadIdx=dipIdx;
      loadFlex=median(series.slice(Math.max(backLimit,dipIdx-2),loadEnd+1).map(s=>s.knee));
      loadConf=0.3;
    }
    const driftNorm=Math.abs(series[landIdx].ankleX-series[liftoffIdx].ankleX);
    const balance= inchScale!=null ? driftNorm*inchScale : driftNorm/torso*10; // inches, or torso-decimals fallback

    /* ---- metrics ---- */
    const set=series[setIdx], rel=series[relIdx], dip=series[dipIdx];
    const near=(idx,w)=>{ const v=[]; for(let k=-w;k<=w;k++){ const i2=idx+k; if(i2>=0&&i2<N) v.push(i2); } return v; };
    // set point is a sharp V-minimum: the median filter can land a frame off it,
    // so read the true min from the repaired raw series right around setIdx
    const elbowSet=Math.min(...near(setIdx,1).map(i=>rawElbow[i]));
    const elbowLoad=median(near(loadIdx,1).map(i=>series[i].elbow));
    // extension: median of the top-3 (a strict max rides the noise up ~5°)
    const extVals=[]; for(let i=setIdx;i<=Math.min(N-1,relIdx+2);i++) extVals.push(series[i].elbow);
    extVals.sort((a,b)=>b-a);
    const elbowRelease=median(extVals.slice(0,Math.min(3,extVals.length)));
    const finFrames=[]; for(let i=relIdx+1;i<=finEnd;i++) finFrames.push(i);
    const elbowFinish=finFrames.length?median(finFrames.map(i=>series[i].elbow)):elbowRelease;
    const follow= finFrames.length? 100*finFrames.filter(i=>series[i].elbow>148 && series[i].wristY<series[i].noseY).length/finFrames.length : 0;
    const timing=(rel.t-series[apexIdx].t)*1000;
    const tempo=(rel.t-dip.t)*1000;
    const setpt=((set.noseY-set.wristY)/torso)*100; // % of torso above nose
    const dxA=rel.lm[j.wr].x-rel.lm[j.el].x, dyA=(1-rel.lm[j.wr].y)-(1-rel.lm[j.el].y);
    const arc=clamp(Math.atan2(dyA,Math.abs(dxA)||1e-3)*180/Math.PI,20,80);
    // trunk lean at release: mid-shoulder vs mid-hip against vertical.
    // Sign: + = leaning FORWARD (toward the hoop, i.e. the way the shooter faces).
    const lean=(()=>{
      const vals=near(relIdx,1).map(i=>{
        const f=series[i];
        const shM=mid(f.lm[L.Lsh],f.lm[L.Rsh]), hipM2=mid(f.lm[L.Lhip],f.lm[L.Rhip]);
        const face=Math.sign(f.lm[L.nose].x-hipM2.x)||1;
        return Math.atan2(face*(shM.x-hipM2.x), hipM2.y-shM.y)*180/Math.PI;
      });
      return median(vals);
    })();

    /* ---- per-metric confidence: joint visibility at the frames that matter,
       degraded by glitch repairs on those joints. Metrics below 0.5 are
       reported as unmeasured instead of shown as (possibly wrong) numbers. ---- */
    const glitchPenalty=ids=>clamp(1 - ids.reduce((s,li)=>s+glitchCount[li],0)/(N*0.6), 0.4, 1);
    const armIds=[j.sh,j.el,j.wr], legIds=[L.Lhip,L.Rhip,L.Lkn,L.Rkn,L.Lan,L.Ran];
    const armConfAt=idxs=>median(idxs.map(i=>series[i].armVis))*glitchPenalty(armIds);
    const conf={
      elbowSet:armConfAt(near(setIdx,1)),
      elbowLoad:armConfAt(near(loadIdx,1)),
      elbowRelease:armConfAt(near(relIdx,1)),
      elbowFinish:finFrames.length?armConfAt(finFrames):0.3,
      follow:finFrames.length?armConfAt(finFrames):0.3,
      knee:loadConf*glitchPenalty(legIds),
      jump: jumpIn==null?0:median(near(apexIdx,2).map(i=>series[i].legVis))*glitchPenalty(legIds),
      timing:Math.min(armConfAt(near(relIdx,1)), median(near(apexIdx,1).map(i=>Math.min(series[i].lm[L.Lhip].v,series[i].lm[L.Rhip].v)))),
      tempo:armConfAt([dipIdx,relIdx]),
      setpt:Math.min(armConfAt(near(setIdx,1)), series[setIdx].lm[L.nose].v),
      balance:median([liftoffIdx,landIdx].map(i=>series[i].legVis))*glitchPenalty(legIds),
      arc:armConfAt(near(relIdx,1)),
      lean:median(near(relIdx,1).map(i=>{
        const f=series[i];
        return Math.min(f.lm[L.Lsh].v,f.lm[L.Rsh].v,f.lm[L.Lhip].v,f.lm[L.Rhip].v);
      })),
    };
    if(!view.ok){ ["elbowSet","elbowLoad","elbowRelease","elbowFinish","arc"].forEach(k=>conf[k]*=0.75); }

    const metrics={elbowSet,elbowLoad,elbowRelease,elbowFinish,knee:clamp(loadFlex,0,90),
      jump:jumpIn, timing, tempo, setpt, follow, balance, arc, lean};

    // VALIDITY GATE: a real shot cocks the elbow (~60-110°) with the ball above the
    // shoulder before extending. An arm that stayed near-straight overhead is a
    // catch, rebound or ball retrieve — reporting it as a "shot" poisons every
    // average. Only reject when we SAW the arm clearly (conf ≥ 0.5).
    if(conf.elbowSet>=0.5 && elbowSet>135) return;

    shots.push({idx:shots.length, side,
      keys:{dipIdx,loadIdx,setIdx,relIdx,apexIdx,finishIdx:finEnd,liftoffIdx,landIdx},
      metrics, conf, series});
  });

  const targets=MODELS[modelKey].targets;
  shots.forEach(s=>{ s.score=scoreShot(s, targets, mode); });

  const avgVis=mean(frames.flatMap(f=>[f.lm[j.sh].v,f.lm[j.el].v,f.lm[j.wr].v,f.lm[j.kn].v]));
  const warnings=[];
  if(view.msg) warnings.push(view.msg);
  if(inchScale==null) warnings.push("Set the player's height to get jump height & landing drift in inches.");
  return {shots, side, view, quality:(avgVis>0.7&&view.ok)?"good":"warn", avgVis, personPx, warnings};
}

/* ---------------- scoring ---------------- */
export function metricHidden(key, mode){
  return mode==="ft" && (key==="timing"||key==="jump");
}
export function scoreMetric(val, tgt){
  if(val==null||tgt.cueOnly) return null;
  const {min,max,ideal}=tgt;
  if(min<=-9999) return null;
  if(val>=min && val<=max){
    const half=Math.max(ideal-min,max-ideal)||1;
    return clamp(100-Math.abs(val-ideal)/half*15,85,100);
  }
  const d= val<min ? (min-val) : (val-max);
  const span=Math.max((max-min),1);
  return clamp(85 - d/span*120, 0, 84);
}
export function scoreShot(shot, targets, mode){
  let sum=0,n=0;
  METRIC_ORDER.forEach(key=>{
    const tgt=targets[key]; if(!tgt||tgt.cueOnly) return;
    if(metricHidden(key,mode)) return;
    if((shot.conf[key]??1)<0.5) return;      // never grade what we couldn't measure
    const sc=scoreMetric(shot.metrics[key],tgt);
    if(sc===null) return;
    sum+=sc; n++;
  });
  return Math.round(n?sum/n:0);
}
export function consistency(shots, mode){
  if(shots.length<2) return {score:60,label:"Need more reps",desc:"Record 3–4 shots in one clip to measure repeatability."};
  const keys=["elbowSet","tempo","setpt","arc"].concat(mode==="ft"?[]:["timing"]);
  const varScore=[];
  keys.forEach(k=>{
    const vals=shots.filter(s=>(s.conf[k]??1)>=0.5 && s.metrics[k]!=null).map(s=>s.metrics[k]);
    if(vals.length<2) return;
    const sd=std(vals), mu=Math.abs(mean(vals))||1;
    const cv=sd/(mu+ (k==="timing"||k==="setpt"?30:1));
    varScore.push(clamp(100-cv*220,0,100));
  });
  if(!varScore.length) return {score:50,label:"Low data",desc:"Couldn't compare reps reliably — film a cleaner side-on clip."};
  const score=Math.round(mean(varScore));
  const label=score>=80?"Elite":score>=65?"Solid":score>=50?"Streaky":"Inconsistent";
  const desc=score>=65?"Your reps look alike — that repeatability is what makes shots fall.":"Your shots vary rep to rep. Groove the same motion every time.";
  return {score,label,desc};
}
