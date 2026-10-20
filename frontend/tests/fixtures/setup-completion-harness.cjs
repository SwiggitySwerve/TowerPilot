/* Offline rendering of the real Recognition page. No dashboard or device I/O. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {html, section} = require('../helpers.cjs');
const WorkspaceStatus = require('../../webui/workspace-status.js');
const LearningStore = require('../../webui/learning-store.js');
const LearningView = require('../../webui/learning-view.js');

async function buildFixture(outcome='awaiting_apply') {
  const config={active_instance:'demo',active_profile:'demo',instances:{demo:{account:'demo',serial:'offline-fixture'}}};
  const phases={cards:{status:'done',results:{names:['Sample preset']}},modules:{status:'done',
    started_at:100,finished_at:160,message:'Module inventory recorded'}};
  const partial=['failed','applied_partial'].includes(outcome);
  const state={phases,player:{},final_screen:{operation_id:'fixture-operation',name:'home',verified:true,observed_at:160}};
  if (partial) phases.bootstrap={status:'needs_attention',kind:'full',started_at:100,finished_at:160,
    message:'Two required controls still need capture.',steps:[
      {id:'home',label:'Verify Home',status:'done'},
      {id:'flow_battle',label:'Battle controls',status:'needs_attention'},
      {id:'finish',label:'Return Home',status:'done'}]};
  const scan={running:false,selection:{mode:partial?'bootstrap':'basic',phases:['m']},state,
    operation:{id:'fixture-operation',revision:9,status:partial?'failed':outcome,context:LearningStore.context(config),
      result_refs:outcome === 'applied_partial' ? {apply_status:'succeeded',apply_error:null} : {},
      error:partial?{code:'capture_incomplete',message:'Not every requested phase completed'}:null},
    card_manifest:{complete:true,cards:[{name:'Sample card A'},{name:'Sample card B',active:true},{name:'Sample card C'}]},
    report:{entries:[{phase:'modules',rel:'modules/sample.png',status:'stale',verified:false}],
      player:{module_inventory_complete:true,modules_equipped:['sample'],modules_copies:Array(6).fill({})}}};
  const slots=new Map(), $=key=>{if(!slots.has(key))slots.set(key,{innerHTML:''});return slots.get(key);};
  const replies={'/api/config':config,'/api/runs':{runs:{sample:{label:'Sample run'}}},
    '/api/readiness':{preset:'sample',ready:false,message:'Two controls still need verification.'},
    '/api/wizard/templates':{have:[],missing_seen:[]},'/api/wizard/required':{required:[]},'/api/catalogue/modules':{modules:[]}};
  const ctx=vm.createContext({S:{view:'calibrate',config},LearningStore,LearningView,WorkspaceStatus,$,
    api:async url=>{if(!(url in replies))throw Error('Unexpected offline request: '+url);return replies[url];},
    pendingPreparation:()=>null,calibrationPreferences:()=>({phases:['c','m'],taps:false,overwrite:false}),
    syncLiveScreen(){},pollCalibrate:async()=>{},pollScreenAnalysis(){},renderScanPlan(){}});
  vm.runInContext(section('function esc(s){','\n\n'),ctx);
  vm.runInContext(section('function calibrationKnowledge(st){','function preparationStorageKey(){'),ctx);
  vm.runInContext(section('function calibrationMode(', 'function calibReport('),ctx);
  vm.runInContext(section('async function renderCalibrate(){','/* Live screen on Calibrate:'),ctx);
  await ctx.renderCalibrate();
  const selected=WorkspaceStatus.selectOperation(scan,ctx.basicScanProgress(scan));
  let panel=$('#panel-screens').innerHTML;
  const fill=(id,markup)=>{panel=panel.replace(new RegExp(`(<div id="${id}">)[\\s\\S]*?(</div>)`),`$1${markup}$2`);};
  fill('workspace-operation',WorkspaceStatus.operationHTML(WorkspaceStatus.operation({...selected,attempt:scan.operation,finalScreen:state.final_screen,now:165})));
  fill('calib-knowledge',`<table><thead><tr><th>Feature</th><th>Saved discoveries</th><th>Recognition images</th></tr></thead><tbody>${ctx.calibrationKnowledge(scan)}</tbody></table>`);
  fill('live-screen','<p class="screen-placeholder">Offline fixture — no device connection</p>');
  let document=html.slice(0,html.indexOf('<script type="application/json"'))+'</body></html>';
  document=document.replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">');
  document=document.replace(/<link rel="stylesheet" href="([^"]+)">/g,(_,file)=>`<style>${fs.readFileSync(path.join(__dirname,'../../webui',file),'utf8')}</style>`);
  document=document.replace(/(<section data-page-panel id="panel-overview"[^>]*>)[\s\S]*?<\/section>/,'<section id="panel-overview" hidden></section>');
  document=document.replace(/<section data-page-panel id="panel-screens"[^>]*><\/section>/,`<section data-page-panel id="panel-screens">${panel}</section>`);
  document=document.replace('<h1 id="page-title">Dashboard</h1>','<h1 id="page-title">Recognition</h1>');
  document=document.replace('Your emulator, current automation and recent activity.','Offline fixture · '+outcome);
  document=document.replace('Checking connection…','Offline fixture · no live requests');
  document=document.replace('id="tab-screens"','aria-current="page" id="tab-screens"');
  return document.replace(/\s+on\w+="[^"]*"/g,'').replace(/href="\/api\/[^\"]*"/g,'href="#offline"');
}

module.exports={buildFixture};
if(require.main === module)buildFixture(process.argv[2]).then(value=>process.stdout.write(value));
