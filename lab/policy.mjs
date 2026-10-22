import {readdir,copyFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {checkedPath,jsonFile,saveJSON,sha,sampleHash,textOf} from './common.mjs';

// Deliberately dependency-free baseline. This is lexical similarity, not embeddings.
export function features(sample){
 const text=(sample.initialRequest.messages||[]).filter(m=>['user','assistant'].includes(m.role)).map(m=>textOf(m.content)).join('\n').slice(-65536).toLowerCase();
 const tokens=text.match(/[a-z0-9_]+|[\p{Script=Han}]/gu)||[],map={};
 for(let i=0;i<tokens.length;i++){const t=tokens[i];map[t]=(map[t]||0)+1;if(/^\p{Script=Han}$/u.test(t)&&/^\p{Script=Han}$/u.test(tokens[i+1]||'')){const bigram=t+tokens[i+1];map[bigram]=(map[bigram]||0)+1;}}
 return map;
}
function cosine(a,b){let dot=0,aa=0,bb=0;for(const [k,v]of Object.entries(a)){aa+=v*v;dot+=v*(b[k]||0);}for(const v of Object.values(b))bb+=v*v;return aa&&bb?dot/Math.sqrt(aa*bb):0;}
export function route(policy,sample){
 let positive=0,negative=0,positiveId=null,negativeId=null;const vector=features(sample);
 for(const item of policy.cases){if(item.inputToolHash!==sha(sample.initialRequest.tools||[]))continue;const score=cosine(vector,item.features);if(item.verdict==='pass'&&score>positive){positive=score;positiveId=item.sampleId;}if(item.verdict==='fail'&&score>negative){negative=score;negativeId=item.sampleId;}}
 return {backend:positive>=policy.threshold&&positive-negative>=policy.margin?'local':'cloud',positive,negative,positiveId,negativeId};
}

export async function build(c){
 const dir=path.join(c.outputDir,'evaluations'),items=[],seen=new Map(),p=c.policy;
 if(!p||!Number.isFinite(p.minSimilarity)||p.minSimilarity<=0||p.minSimilarity>1||!Number.isFinite(p.margin)||p.margin<0||p.margin>1||!Number.isInteger(p.minCalibrationLocal)||p.minCalibrationLocal<1||!Number.isFinite(p.maxFalseLocalRate)||p.maxFalseLocalRate<0||p.maxFalseLocalRate>1)throw new Error('Invalid policy constraints');
 for(const file of (await readdir(dir)).filter(n=>n.endsWith('.json'))){
  const e=await jsonFile(await checkedPath(dir,file));if(!e.eligibleForLearning||e.configFingerprint!==c.fingerprint||e.provisional&&!p.allowProvisional)continue;
  const s=await jsonFile(await checkedPath(path.join(c.outputDir,'samples'),e.sampleId+'.json'));if(sampleHash(s)!==e.sampleHash)continue;
  const run=await jsonFile(await checkedPath(path.join(c.outputDir,'runs'),e.runId+'/run.json'));if(!run.validity.valid||run.sampleHash!==e.sampleHash)continue;
  if(!['train','calibration','test'].includes(s.split))continue;
  const old=seen.get(s.id);if(old&&old.e.verdict!==e.verdict)throw new Error('Conflicting repeated labels for '+s.id+'; resolve before building');
  if(!old||old.e.createdAt<e.createdAt)seen.set(s.id,{s,e});
 }
 items.push(...seen.values());
 const sessions=new Map();for(const {s}of items){const key=s.sessionId||s.id;if(sessions.has(key)&&sessions.get(key)!==s.split)throw new Error('A source conversation crosses data splits');sessions.set(key,s.split);}
 const versions=new Set(items.map(x=>x.e.harnessVersion)),judges=new Set(items.map(x=>sha(x.e.verifier)));
 if(versions.size>1||judges.size>1)throw new Error('Do not mix harness/verifier versions in one policy');
 const train=items.filter(x=>x.s.split==='train'),calibration=items.filter(x=>x.s.split==='calibration');
 const cases=train.map(({s,e})=>({sampleId:s.id,verdict:e.verdict,features:features(s),inputToolHash:sha(s.initialRequest.tools||[]),evidenceRunId:e.runId,provisional:!!e.provisional}));
 let best=null;
 for(let threshold=p.minSimilarity;threshold<=1.000001;threshold+=0.025){
  const candidate={cases,threshold:Math.min(1,threshold),margin:p.margin};let local=0,falseLocal=0;
  for(const {s,e}of calibration)if(route(candidate,s).backend==='local'){local++;if(e.verdict!=='pass')falseLocal++;}
  const rate=local?falseLocal/local:1;
  const passed=cases.some(x=>x.verdict==='pass')&&cases.some(x=>x.verdict==='fail')&&calibration.some(x=>x.e.verdict==='pass')&&calibration.some(x=>x.e.verdict==='fail')&&local>=p.minCalibrationLocal&&rate<=p.maxFalseLocalRate;
  if(!best||passed&&!best.passed||passed===best.passed&&local>best.local)best={...candidate,local,falseLocal,falseLocalRate:rate,passed};
 }
 const data={version:1,representation:'lexical-unigram-han-bigram-v1',configFingerprint:c.fingerprint,harnessVersion:[...versions][0]||null,threshold:best.threshold,margin:best.margin,cases,validation:{passed:best.passed,calibrationSamples:calibration.length,localPredictions:best.local,falseLocal:best.falseLocal,falseLocalRate:best.falseLocalRate,minCalibrationLocal:p.minCalibrationLocal,calibrationEvidence:calibration.map(({s,e})=>({sampleId:s.id,runId:e.runId,verdict:e.verdict}))},provisional:items.some(x=>x.e.provisional)};
 const id=sha(data),policy={...data,id,createdAt:new Date().toISOString()};
 await saveJSON(path.join(c.outputDir,'policies',id+'.json'),policy);return policy;
}

export async function publish(c,id){
 if(!/^[a-f0-9]{64}$/.test(id||''))throw new Error('A policy ID is required');
 const src=await checkedPath(path.join(c.outputDir,'policies'),id+'.json'),policy=await jsonFile(src);
 const {id:storedId,createdAt,...data}=policy;
 if(storedId!==id||sha(data)!==id)throw new Error('Policy hash mismatch');
 if(!policy.validation?.passed||policy.configFingerprint!==c.fingerprint)throw new Error('Policy has not passed held-out calibration for this configuration');
 const dir=path.join(c.outputDir,'releases',id);await mkdir(dir,{recursive:true,mode:0o700});await saveJSON(path.join(dir,'policy.json'),policy);
 await saveJSON(path.join(c.outputDir,'current-policy.json'),{version:1,policyId:id,relativePath:path.join('releases',id,'policy.json'),publishedAt:new Date().toISOString()});
 return {policyId:id,releaseDirectory:dir,activatedOnline:false};
}
