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
const source=receipts.length===1?`https://api.npmjs.org/downloads/point/${created}:${latest.end}/${name}`:'https://github.com/theihtishaam/omni-skills-forge/blob/main/docs/npm-downloads.json';
const plain=`**Total npm downloads: ${downloads.toLocaleString('en-US')}** · Through **${latest.end}**. [npm data](${source}).\n\nGitHub refreshes this number every two days. The npm README records the total when this version was published. Downloads include automated installs; they are not unique users.`;
const readme=await readFile(path.join(root,'README.md'),'utf8');
if(!readme.includes('<!-- NPM_TOTAL_START -->')||!readme.includes('<!-- NPM_TOTAL_END -->'))throw Error('Missing README download markers');
const updatedReadme=readme.replace(/<!-- NPM_TOTAL_START -->[\s\S]*?<!-- NPM_TOTAL_END -->/,'<!-- NPM_TOTAL_START -->\n'+plain+'\n<!-- NPM_TOTAL_END -->');
await mkdir(path.join(root,'assets'),{recursive:true});
await mkdir(path.join(root,'docs'),{recursive:true});
await writeFile(path.join(root,'README.md'),updatedReadme);
await writeFile(path.join(root,'docs/npm-downloads.json'),JSON.stringify(data,null,2)+'\n');
await writeFile(path.join(root,'docs/catalog-stats.json'),JSON.stringify(catalog,null,2)+'\n');
console.log(JSON.stringify({downloads,milestone,coverageEnd:latest.end,skillFiles:catalog.skillFiles,categoryPaths:catalog.categoryPaths}));
