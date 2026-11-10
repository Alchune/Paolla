const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].flatMap(match => {
  const src = match[1].match(/src="([^"]+)"/);
  return src ? (/^https?:/.test(src[1]) ? [] : [fs.readFileSync(path.join(root, src[1].split('?')[0]), 'utf8')]) : [match[2]];
});
function harness() {
  const nodes = new Map(), callbacks = [], storage = new Map();
  function element() {
    return {innerHTML:'', textContent:'', style:{}, dataset:{}, children:[], classList:{add(){},remove(){}},
      setAttribute(){}, addEventListener(){}, appendChild(child){this.children.push(child);},
      insertAdjacentElement(_position, child){nodes.set(child.id, child);},
      querySelector(selector){
        if (selector === '.page-header' && this.innerHTML.includes('class="page-header"')) {
          if (this.headerHTML !== this.innerHTML) {this.headerHTML=this.innerHTML;this.header=element();}
          return this.header;
        }
        if (selector === '[data-production-report-link]') return this.children.find(n=>n.dataset.productionReportLink) || null;
        return null;
      }, querySelectorAll(){return [];}};
  }
  function node(id) {if(!nodes.has(id)) nodes.set(id,element());return nodes.get(id);}
  const context = {console,Blob,Intl,Date,Map,Set,Promise,encodeURIComponent,decodeURIComponent,escape,unescape,
    atob:s=>Buffer.from(s,'base64').toString('binary'), btoa:s=>Buffer.from(s,'binary').toString('base64'),
    document:{readyState:'loading',getElementById:node,querySelector:node,querySelectorAll:()=>[],createElement:element,
      addEventListener:(event,fn)=>callbacks.push({event,fn})},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    setTimeout(){},clearTimeout(){},setInterval(){},confirm:()=>true,
    fetch:()=>{throw Error('Network forbidden');},MutationObserver:class{observe(){}},
    supabase:{createClient:()=>({auth:{getSession:()=>new Promise(()=>{})},from:()=>{throw Error('Database access forbidden');}})}};
  context.window=context;
  vm.createContext(context);
  scripts.forEach((source,index)=>vm.runInContext(source,context,{filename:'script-'+index}));
  const run=source=>vm.runInContext(source,context);
  run("state.user={id:'test-user'};state.warehouse={id:'test-warehouse'};state.accessMode='owner';state.orders=[];state.products=[];");
  const hook=callbacks.find(c=>c.event==='DOMContentLoaded' && c.fn.name==='installProductionReportUI');
  if(hook) hook.fn();
  return {context,node,run,callbacks};
}
test('production reports have a static sidebar entry and a runtime shortcut after all overrides',()=>{
  const h=harness();
  assert(html.includes('id="nav-production-report"'));
  h.run("navigate('production')");
  const header=h.node('page-content').querySelector('.page-header');
  const button=header.querySelector('[data-production-report-link]');
  assert(button,'Final production renderer must offer the report shortcut');
  button.onclick();
  assert.equal(h.run('state.currentPage'),'production-report');
  assert(h.node('page-content').innerHTML.includes('Звіт: виготовлено за період'));
});
test('report dates, model, and presets keep the report on screen without writing data',()=>{
  const h=harness();
  h.run("navigate('production-report')");
  const before=h.run('JSON.stringify(state.orders)');
  for(const code of ["setProductionReportField('from','2026-10-01')","setProductionReportField('to','2026-11-10')", "setProductionReportField('model','N2 Бежева')", "setProductionReportPreset('month')", "setProductionReportPreset('previous')", "setProductionReportPreset('all')"]){
    h.run(code);
    assert.equal(h.run('state.currentPage'),'production-report');
    assert(h.node('page-content').innerHTML.includes('Звіт: виготовлено за період'),code);
    assert(!h.node('page-content').innerHTML.includes('Немає активних нарядів'),code);
  }
  assert.equal(h.run('productionReportDateRange().from'),'');
  assert.equal(h.run('productionReportDateRange().to'),'');
  assert.equal(h.run('JSON.stringify(state.orders)'),before);
});
test('production receipt report respects partial receipts and inclusive Kyiv date boundaries',()=>{
  const h=harness();
  h.run(`state.orders=[{id:'one',product_id:'p1',product:'N2 Бежева',quantity:160,received:false,
    received_stock:{quantity:100,entries:[{quantity:40,received_at:'2026-10-31T22:30:00Z'},{quantity:60,received_at:'2026-11-10T21:59:59Z'}]}},
    {id:'two',product_id:'p1',product:'N2 Бежева',quantity:20,received:true},
    {id:'outside',product_id:'p1',product:'N2 Бежева',quantity:50,received:true,warehouse_received_at:'2026-11-10T22:00:00Z'}];`);
  const report=JSON.parse(h.run("JSON.stringify(productionReportRows('2026-11-01','2026-11-10',''))"));
  assert.deepEqual(report.rows,[{name:'N2 Бежева',quantity:100,count:1}]);
  assert.equal(report.missingDate,20);
});
test('installation is idempotent and preserves existing role restrictions',()=>{
  const h=harness();
  assert.equal(typeof h.context.installProductionReportUI,'function');
  const renderer=h.context.renderProduction;
  h.context.installProductionReportUI();
  assert.equal(h.context.renderProduction,renderer);
  h.run("state.accessMode='worker';navigate('production-report')");
  assert.equal(h.run('state.currentPage'),'production-report');
  assert.equal(h.run("canAccessPage('team')"),false);
  h.run("navigate('production')");
  assert(h.node('page-content').innerHTML.includes('Всі операції') || h.node('page-content').innerHTML.includes('Всі операц'));
});
