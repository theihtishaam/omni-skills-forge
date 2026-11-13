import {mkdir, writeFile, readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const name='omni-skills-forge';
const DAY=86400000;
const registry=JSON.parse(await readFile(path.join(root,'registry/master-registry.json'),'utf8'));
const files=(await readdir(path.join(root,'skills'),{recursive:true})).filter(file=>file.endsWith('.md')).map(file=>file.replaceAll('\\','/'));
const fileSet=new Set(files);
if(!Array.isArray(registry.skills)||registry.skills.length!==files.length||new Set(registry.skills.map(row=>row.file)).size!==files.length||registry.skills.some(row=>!fileSet.has(row.file)))throw Error('Catalog registry and shipped Markdown files disagree');
const categories=new Set(registry.skills.map(row=>row.category));
const families={};for(const row of registry.skills){const family=row.category.split('/')[0];families[family]=(families[family]||0)+1;}
const installer=await readFile(path.join(root,'src/installer.js'),'utf8');
const targetBlock=installer.match(/const TOOL_CONFIGS = \{([\s\S]*?)\n\};/);
if(!targetBlock)throw Error('Cannot verify installer target count');
const installerTargets=[...targetBlock[1].matchAll(/^\s*'[^']+':/gm)].length;
if(!installerTargets)throw Error('No installer targets found');
const catalog={skillFiles:files.length,registryEntries:registry.skills.length,distinctNames:new Set(registry.skills.map(row=>row.name)).size,categoryPaths:categories.size,installerTargets,families,refreshedAt:new Date().toISOString()};
async function get(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`Public npm API returned ${response.status}`);
  return response.json();
}
function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value).toISOString().slice(0,10)===value;}
function validate(receipt,start,end){
  if(receipt.package!==name||!Number.isSafeInteger(receipt.downloads)||receipt.downloads<0||receipt.start!==start||receipt.end!==end)throw Error('Incomplete npm download receipt; retaining previous assets');
}
const metadata=await get('https://registry.npmjs.org/'+name);
if(metadata.name!==name)throw Error('Unexpected npm package');
const created=new Date(metadata.time.created).toISOString().slice(0,10);
const latest=await get('https://api.npmjs.org/downloads/point/last-day/'+name);
if(!validDate(latest.end))throw Error('Invalid npm coverage date');
validate(latest,latest.end,latest.end);
if(created<'2015-01-10'||created>latest.end)throw Error('Full lifetime coverage unavailable');
const receipts=[];
for(let cursor=Date.parse(created);cursor<=Date.parse(latest.end);){
  const finish=Math.min(Date.parse(latest.end),cursor+364*DAY);
  const start=new Date(cursor).toISOString().slice(0,10), end=new Date(finish).toISOString().slice(0,10);
  const receipt=await get(`https://api.npmjs.org/downloads/point/${start}:${end}/${name}`);
  validate(receipt,start,end);receipts.push(receipt);cursor=finish+DAY;
}
const downloads=receipts.reduce((total,row)=>total+row.downloads,0);
if(!Number.isSafeInteger(downloads))throw Error('Invalid total');
const milestone=downloads>=1e6?Math.floor(downloads/1e6)+'M+':downloads>=1000?Math.floor(downloads/1000)+'K+':String(downloads);
const data={package:name,downloads,milestone,coverageStart:created,coverageEnd:latest.end,completeSinceCreation:true,refreshedAt:new Date().toISOString(),source:'https://api.npmjs.org/downloads/point/',receipts};
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="230" viewBox="0 0 1200 230" role="img" aria-label="Omni Skills Forge: ${downloads} cumulative npm downloads through ${latest.end}">
<rect x="1" y="1" width="1198" height="228" rx="18" fill="#0b1223" stroke="#344967"/>
<path d="M36 34H110" stroke="#7dd3fc" stroke-width="4"/>
<g font-family="Segoe UI,Arial,sans-serif"><text x="36" y="66" fill="#7dd3fc" font-size="16" font-weight="600">OMNI SKILLS FORGE / PUBLIC NPM DOWNLOADS</text>
<text x="36" y="140" fill="#f0f5ff" font-size="62" font-weight="700">${downloads.toLocaleString('en-US')}</text>
<rect x="400" y="91" width="180" height="59" rx="12" fill="#17213a" stroke="#7dd3fc"/><text x="490" y="132" text-anchor="middle" fill="#eab66e" font-size="35" font-weight="700">${milestone}</text>
<text x="36" y="178" fill="#d0dced" font-size="18">Cumulative package downloads · not unique users</text>
<text x="36" y="208" fill="#9eb4d3" font-size="15">From ${created} through ${latest.end} · Refreshed daily from npm</text>
<path d="M960 75L1095 75L1130 140L1040 183L935 135Z M960 75L1040 183M1095 75L935 135" fill="none" stroke="#334b68" stroke-width="2"/><g fill="#7dd3fc"><circle cx="960" cy="75" r="7"/><circle cx="1095" cy="75" r="7"/><circle cx="1040" cy="183" r="7"/><circle cx="935" cy="135" r="7"/><circle cx="1130" cy="140" r="7"/></g></g></svg>\n`;
const number=value=>value.toLocaleString('en-US');
const combined=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="300" viewBox="0 0 1200 300" role="img" aria-label="Omni Skills Forge: ${number(downloads)} npm downloads, ${number(catalog.skillFiles)} skill files, ${catalog.categoryPaths} categories">
<rect x="1" y="1" width="1198" height="298" rx="18" fill="#0b1223" stroke="#344967"/><path d="M34 34H100" stroke="#eab66e" stroke-width="4"/>
<g font-family="Segoe UI,Arial,sans-serif"><text x="34" y="72" fill="#f0f5ff" font-size="29" font-weight="650">Omni Skills Forge</text><text x="1166" y="70" text-anchor="end" fill="#7dd3fc" font-size="16">${milestone} DOWNLOADS ON NPM</text>
<path d="M411 108V218M806 108V218" stroke="#344967"/>
<text x="34" y="165" fill="#eab66e" font-size="55" font-weight="700">${number(downloads)}</text><text x="34" y="204" fill="#c5d4e8" font-size="19">Total npm downloads</text>
<text x="446" y="165" fill="#7dd3fc" font-size="55" font-weight="700">${number(catalog.skillFiles)}</text><text x="446" y="204" fill="#c5d4e8" font-size="19">Markdown skill files</text>
<text x="846" y="165" fill="#f0f5ff" font-size="55" font-weight="700">${catalog.categoryPaths}</text><text x="846" y="204" fill="#c5d4e8" font-size="19">Category paths</text>
<path d="M34 237H1166" stroke="#26354b"/><text x="34" y="273" fill="#9eb4d3" font-size="15">Downloads through ${latest.end} · Catalog from repository · Refreshes daily</text><text x="1166" y="273" text-anchor="end" fill="#7dd3fc" font-size="15">EXPLORE PROJECT ↗</text></g></svg>\n`;
await mkdir(path.join(root,'assets'),{recursive:true});
await mkdir(path.join(root,'docs'),{recursive:true});
await writeFile(path.join(root,'assets/downloads.svg'),svg);
await writeFile(path.join(root,'docs/npm-downloads.json'),JSON.stringify(data,null,2)+'\n');
await writeFile(path.join(root,'assets/project-stats.svg'),combined);
await writeFile(path.join(root,'docs/catalog-stats.json'),JSON.stringify(catalog,null,2)+'\n');
console.log(JSON.stringify({downloads,milestone,coverageEnd:latest.end,skillFiles:catalog.skillFiles,categoryPaths:catalog.categoryPaths}));
