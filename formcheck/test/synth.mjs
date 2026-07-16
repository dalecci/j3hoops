/* Synthetic shot generator — builds MediaPipe-style landmark frames from a
   parametric side-view skeleton with KNOWN ground-truth kinematics, then
   optionally corrupts them (noise, impulse glitches, dropouts, camera pan).
   Ground truth is computed from the same clean geometry the frames come from. */

import { L, angle } from "../engine.js";

const D2R=Math.PI/180;

/* Skeleton proportions as fractions of body height. */
const P={shank:0.25, thigh:0.245, torso:0.30, neck:0.09, uarm:0.17, farm:0.16};

/* Build one frame of joints for a right-handed shooter facing +x.
   pose: {kneeFlex (deg), shoulderAng σ (deg from straight-down, forward+),
          forearmAng ρ (deg from straight-down, forward+), jump (image units, >=0),
          lean (x drift of whole body)} */
export function buildFrame(pose, opt={}){
  const h=opt.bodyH ?? 0.55;          // person height in image units
  const ground=opt.ground ?? 0.92;
  const cx=(opt.cx ?? 0.5)+(pose.lean||0);
  const S=P.shank*h, T=P.thigh*h, TO=P.torso*h, NK=P.neck*h, U=P.uarm*h, F=P.farm*h;
  const φ=(pose.kneeFlex||0)*D2R;

  const ankle={x:cx, y:ground-(pose.jump||0)};
  const knee ={x:ankle.x+S*Math.sin(φ/2), y:ankle.y-S*Math.cos(φ/2)};
  const hip  ={x:knee.x -T*Math.sin(φ/2), y:knee.y -T*Math.cos(φ/2)};
  const sh   ={x:hip.x, y:hip.y-TO};
  const nose ={x:sh.x+0.02*h, y:sh.y-NK};

  const σ=(pose.shoulderAng||10)*D2R, ρ=(pose.forearmAng||100)*D2R;
  const elbow={x:sh.x+U*Math.sin(σ), y:sh.y+U*Math.cos(σ)};
  const wrist={x:elbow.x+F*Math.sin(ρ), y:elbow.y+F*Math.cos(ρ)};

  // guide arm: mirrors at lower amplitude
  const σg=σ*0.8, ρg=ρ*0.85;
  const elbowG={x:sh.x-0.02*h+U*Math.sin(σg)*0.95, y:sh.y+U*Math.cos(σg)};
  const wristG={x:elbowG.x+F*Math.sin(ρg)*0.9, y:elbowG.y+F*Math.cos(ρg)};

  const lm=Array.from({length:33},()=>({x:0,y:0,v:0}));
  const put=(i,p,v)=>{lm[i]={x:p.x,y:p.y,v};};
  const off=0.012*h; // far-side joints slightly offset & less visible
  put(L.nose,nose,0.98);
  put(L.Rsh,sh,0.95);              put(L.Lsh,{x:sh.x-off,y:sh.y+off*0.4},0.7);
  put(L.Rel,elbow,0.95);           put(L.Lel,{x:elbowG.x,y:elbowG.y},0.6);
  put(L.Rwr,wrist,0.95);           put(L.Lwr,{x:wristG.x,y:wristG.y},0.6);
  put(L.Rhip,hip,0.92);            put(L.Lhip,{x:hip.x-off,y:hip.y+off*0.3},0.75);
  put(L.Rkn,knee,0.92);            put(L.Lkn,{x:knee.x-off,y:knee.y+off*0.3},0.7);
  put(L.Ran,ankle,0.9);            put(L.Lan,{x:ankle.x-off,y:ankle.y},0.7);
  return lm;
}

const lerp=(a,b,f)=>a+(b-a)*f;
const ease=f=>f*f*(3-2*f); // smoothstep — no teleports between phases

/* Pose script for one shot. Phases (durations s):
   stand → dip(load) → drive-to-set → extend(release) → follow → recover.
   Returns {poseAt(t), keyTimes, dur} for a shot starting at t=0. */
export function shotScript(cfg={}){
  const kneeLoad=cfg.kneeLoad ?? 48;
  const jumpImg =cfg.jumpImg ?? 0.055;    // image-unit jump height
  const durs={stand:cfg.stand??0.6, dip:0.35, drive:0.30, ext:0.12, follow:0.45, recover:0.5};
  const tDipEnd=durs.stand+durs.dip;
  const tSet=tDipEnd+durs.drive;
  const tRel=tSet+durs.ext;
  const apexAfterRel=cfg.apexAfterRel ?? 0.08;
  const halfFlight=cfg.halfFlight ?? 0.23;
  const tApex=tRel+apexAfterRel;
  const dur=tRel+durs.follow+durs.recover;

  // arm angles: stand(σ15,ρ110 ball at chest) → dip(σ20,ρ15 ball drops to thigh)
  //             → set(σ90,ρ180 cocked L) → rel(σ170,ρ182) → follow(σ168,ρ176)
  function poseAt(t){
    let kneeFlex=4, σ=15, ρ=110;
    if(t<durs.stand){ /* stand */ }
    else if(t<tDipEnd){ const f=ease((t-durs.stand)/durs.dip); kneeFlex=lerp(4,kneeLoad,f); σ=lerp(15,20,f); ρ=lerp(110,15,f); }
    else if(t<tSet){ const f=ease((t-tDipEnd)/durs.drive); kneeFlex=lerp(kneeLoad,10,f); σ=lerp(20,90,f); ρ=lerp(15,180,f); }
    else if(t<tRel){ const f=ease((t-tSet)/durs.ext); kneeFlex=lerp(10,2,f); σ=lerp(90,170,f); ρ=lerp(180,182,f); }
    else if(t<tRel+durs.follow){ const f=ease((t-tRel)/durs.follow); kneeFlex=2; σ=lerp(170,168,f); ρ=lerp(182,176,f); }
    else { const f=ease((t-tRel-durs.follow)/durs.recover); kneeFlex=lerp(2,4,f); σ=lerp(168,15,f); ρ=lerp(176,110,f); }
    // flight: parabola around apex
    let jump=0;
    const dtA=t-tApex;
    if(Math.abs(dtA)<halfFlight){ jump=jumpImg*(1-(dtA/halfFlight)**2); }
    return {kneeFlex,shoulderAng:σ,forearmAng:ρ,jump};
  }
  return {poseAt, dur, keyTimes:{tDipEnd,tSet,tRel,tApex}};
}

/* Generate a clip of nShots consecutive shots. Returns {frames, truth[]} where
   truth[i] holds exact ground-truth values computed from the clean geometry. */
export function makeClip({nShots=4, fps=30, kneeLoad=48, jumpIn=10, heightIn=70,
                          jitter=0, lefty=false, ft=false, opt={}}={}){
  const bodyH=opt.bodyH ?? 0.55;
  // engine converts: personPx = (ankleY-noseY)*1.08 → jump image units from inches
  const personPx=(P.shank+P.thigh+P.torso+P.neck)*bodyH*1.08;
  const frames=[]; const truth=[];
  let t0=0;
  const dt=1/fps;
  for(let s=0;s<nShots;s++){
    const kl=kneeLoad + (jitter? (s%2?jitter:-jitter):0);
    const jImg= ft?0:(jumpIn/heightIn)*personPx;
    const sc=shotScript({kneeLoad:kl, jumpImg:jImg, apexAfterRel:ft?0:0.08});
    // clean pass for ground truth at keyframes
    const setPose=sc.poseAt(sc.keyTimes.tSet), loadPose=sc.poseAt(sc.keyTimes.tDipEnd);
    const gt={ kneeLoad:kl,
      elbowSet:elbowOf(setPose,{bodyH}), elbowLoad:elbowOf(loadPose,{bodyH}),
      elbowRelease:elbowOf(sc.poseAt(sc.keyTimes.tRel),{bodyH}),
      jumpIn: ft?0:jumpIn,
      timingMs:(sc.keyTimes.tRel-sc.keyTimes.tApex)*1000,
      tempoMs:(sc.keyTimes.tRel-sc.keyTimes.tDipEnd)*1000,
      tRel:t0+sc.keyTimes.tRel };
    truth.push(gt);
    for(let t=0;t<sc.dur;t+=dt){
      const lm=buildFrame(sc.poseAt(t),{bodyH});
      frames.push({t:t0+t, lm});
    }
    t0+=sc.dur;
  }
  if(lefty) frames.forEach(f=>{
    f.lm.forEach(p=>{p.x=1-p.x;});
    // swap L/R landmark indices so labels stay anatomically correct
    [[L.Lsh,L.Rsh],[L.Lel,L.Rel],[L.Lwr,L.Rwr],[L.Lhip,L.Rhip],[L.Lkn,L.Rkn],[L.Lan,L.Ran]]
      .forEach(([a,b])=>{const tmp=f.lm[a]; f.lm[a]=f.lm[b]; f.lm[b]=tmp;});
  });
  return {frames, truth};
}
function elbowOf(pose,opt){
  const lm=buildFrame(pose,opt);
  return angle(lm[L.Rsh],lm[L.Rel],lm[L.Rwr]);
}

/* A ball-catch / retrieve: arm sweeps overhead nearly STRAIGHT (no cocked elbow),
   with a forward lean — reaches full wrist height like a shot but isn't one.
   Mirrors what real clips show between reps. Returns frames for ~2.2s. */
export function makeCatchMotion(t0=0, fps=30){
  const frames=[];
  for(let t=0;t<2.2;t+=1/fps){
    // straight arm the whole way up: forearm stays collinear with the upper arm
    let σ=15, ρ, knee=8, lean=0;
    if(t<0.5){ σ=15; }
    else if(t<1.0){ const f=ease((t-0.5)/0.5); σ=lerp(15,165,f); knee=lerp(8,20,f); lean=lerp(0,0.03,f); }
    else if(t<1.5){ σ=165; knee=20; lean=0.03; }
    else { const f=ease((t-1.5)/0.7); σ=lerp(165,15,f); knee=lerp(20,8,f); lean=lerp(0.03,0,f); }
    ρ=σ+8;
    const lm=buildFrame({kneeFlex:knee, shoulderAng:σ, forearmAng:ρ, jump:0, lean});
    frames.push({t:t0+t, lm});
  }
  return frames;
}

/* A no-shot control: walking with swinging arms, wrists never above shoulders. */
export function makeWalkClip({secs=8, fps=30}={}){
  const frames=[];
  for(let t=0;t<secs;t+=1/fps){
    const swing=Math.sin(t*2*Math.PI*0.8);
    const lm=buildFrame({kneeFlex:12+8*Math.abs(swing), shoulderAng:15+20*swing, forearmAng:100+15*swing, jump:0, lean:0.02*Math.sin(t*0.7)});
    frames.push({t, lm});
  }
  return frames;
}

/* ---------------- corruptions ---------------- */
export function mulberry(seed){ let a=seed>>>0; return ()=>{ a|=0; a=(a+0x6D2B79F5)|0; let x=Math.imul(a^(a>>>15),1|a); x=(x+Math.imul(x^(x>>>7),61|x))^x; return ((x^(x>>>14))>>>0)/4294967296; }; }

export function addNoise(frames, sigma=0.004, seed=7){
  const rnd=mulberry(seed);
  const gauss=()=>{ let u=0,v=0; while(!u)u=rnd(); while(!v)v=rnd(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
  frames.forEach(f=>f.lm.forEach(p=>{ if(p.v>0){ p.x+=gauss()*sigma; p.y+=gauss()*sigma; } }));
  return frames;
}
/* Single-frame teleports on random joints — the classic MediaPipe impulse glitch. */
export function addGlitches(frames, rate=0.02, mag=0.18, seed=11){
  const rnd=mulberry(seed);
  const joints=[L.Rwr,L.Rel,L.Rkn,L.Ran,L.Lkn,L.Lan];
  frames.forEach(f=>{
    if(rnd()<rate){
      const li=joints[Math.floor(rnd()*joints.length)];
      const p=f.lm[li];
      p.x+=(rnd()-0.5)*2*mag; p.y+=(rnd()-0.5)*2*mag;
    }
  });
  return frames;
}
/* Inject a knee spike at a specific time — regression for the "84° knee" bug. */
export function addKneeSpikeAt(frames, tTarget){
  let best=0,bd=1e9;
  frames.forEach((f,i)=>{const d=Math.abs(f.t-tTarget); if(d<bd){bd=d;best=i;}});
  const f=frames[best];
  f.lm[L.Rkn]={x:f.lm[L.Rkn].x+0.15, y:f.lm[L.Rkn].y-0.12, v:0.9};
  f.lm[L.Lkn]={x:f.lm[L.Lkn].x+0.15, y:f.lm[L.Lkn].y-0.12, v:0.9};
  return best;
}
export function addLegDropout(frames){
  frames.forEach(f=>{[L.Lhip,L.Rhip,L.Lkn,L.Rkn,L.Lan,L.Ran].forEach(li=>{f.lm[li].v=0.15;});});
  return frames;
}
export function addCameraPan(frames, ax=0.04, ay=0.015){
  frames.forEach(f=>{
    const dx=ax*Math.sin(f.t*0.9), dy=ay*Math.sin(f.t*0.6+1);
    f.lm.forEach(p=>{ if(p.v>0){ p.x+=dx; p.y+=dy; } });
  });
  return frames;
}
