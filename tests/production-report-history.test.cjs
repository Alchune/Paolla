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
function historyFixture(h) {
  h.run(`state.products=[{id:'a',name:'Модель A',quantity:700},{id:'b',name:'Модель B',quantity:300},{id:'c',name:'Модель C',quantity:400}];
    state.orders=[
      {id:'partial',product_id:'a',product:'Модель A',quantity:200,received:false,
        received_stock:{quantity:100,entries:[{quantity:40,received_at:'2026-11-04T10:00:00Z'},{quantity:60,received_at:null}]}},
      {id:'legacy',product_id:'a',product:'Модель A',quantity:20,received:true,date:'2026-11-05'},
      {id:'invalid-date',product_id:'b',product:'Модель B',quantity:30,received:true,warehouse_received_at:'not-a-date'},
      {id:'dated',product_id:'c',product:'Модель C',quantity:10,received:true,warehouse_received_at:'2026-10-10T10:00:00Z'},
      {id:'not-received',product_id:'a',product:'Модель A',quantity:999,received:false,date:'2026-11-05'}];`);
}
function result(h, from='', to='', model='') {
  return JSON.parse(h.run(`JSON.stringify(productionReportRows(${JSON.stringify(from)},${JSON.stringify(to)},${JSON.stringify(model)}))`));
}
test('all-time includes dated and undated actual receipts, with per-model undated subsets and no writes',()=>{
  const h=harness();historyFixture(h);
  const before=h.run('JSON.stringify({orders:state.orders,products:state.products,operations:state.operations})');
  const report=result(h);
  assert.equal(report.allTime,true);
  assert.equal(report.undatedQuantity,110);
  assert.deepEqual(report.rows,[
    {name:'Модель A',quantity:120,count:2,undatedQuantity:80},
    {name:'Модель B',quantity:30,count:1,undatedQuantity:30},
    {name:'Модель C',quantity:10,count:1,undatedQuantity:0}
  ]);
  assert.equal(report.rows.reduce((s,r)=>s+r.quantity,0),160);
  assert.equal(report.rows.reduce((s,r)=>s+r.undatedQuantity,0),110);
  assert.equal(h.run('JSON.stringify({orders:state.orders,products:state.products,operations:state.operations})'),before);
});
test('bounded and one-sided ranges exclude undated receipts even when an order date exists',()=>{
  const h=harness();historyFixture(h);
  for(const [from,to] of [['2026-11-01','2026-11-30'],['2026-11-01','']]) {
    const report=result(h,from,to);
    assert.equal(report.allTime,false);
    assert.equal(report.undatedQuantity,0);
    assert.equal(report.missingDate,110);
    assert.deepEqual(report.rows,[{name:'Модель A',quantity:40,count:1}]);
  }
  const through=result(h,'','2026-11-30');
  assert.equal(through.allTime,false);
  assert.equal(through.rows.reduce((s,r)=>s+r.quantity,0),50);
});
test('model selection filters both totals and undated subtotals including undated-only models',()=>{
  const h=harness();historyFixture(h);
  assert.deepEqual(result(h,'','','Модель B').rows,[{name:'Модель B',quantity:30,count:1,undatedQuantity:30}]);
  assert.equal(result(h,'','','Модель B').undatedQuantity,30);
  assert.equal(result(h,'','','Модель A').undatedQuantity,80);
  assert.equal(result(h,'','','Модель C').undatedQuantity,0);
  assert.deepEqual(result(h,'','','Невідома').rows,[]);
});
test('all-time UI and presets retain the report, show undated quantities and do not change warehouse data',()=>{
  const h=harness();historyFixture(h);
  const before=h.run('JSON.stringify({orders:state.orders,products:state.products})');
  h.run("navigate('production-report');setProductionReportPreset('all')");
  let content=h.node('page-content').innerHTML;
  assert(content.includes('Зокрема без відомої дати: <strong>110 пар</strong>'));
  assert(content.includes('<th>З них без дати</th>'));
  assert(content.includes('<td>Модель A</td><td>120</td><td>80</td><td>2</td>'));
  assert(!content.includes('не включено до вибраного періоду'));
  h.run("setProductionReportField('from','2026-11-01');setProductionReportField('to','2026-11-30')");
  content=h.node('page-content').innerHTML;
  assert(!content.includes('<th>З них без дати</th>'));
  assert(content.includes('110 пар без достовірної дати прийняття не включено'));
  h.run("setProductionReportPreset('all')");
  assert.equal(h.run('state.currentPage'),'production-report');
  assert(h.node('page-content').innerHTML.includes('Зокрема без відомої дати: <strong>110 пар</strong>'));
  assert.equal(h.run('JSON.stringify({orders:state.orders,products:state.products})'),before);
});
test('CSV matches all-time totals and includes the undated subset without double counting',()=>{
  const h=harness();historyFixture(h);
  const csv=h.run("productionReportCSVWithHistory(productionReportRows('','',''))");
  assert.equal(csv,'\uFEFF"Модель";"Виготовлено, пар";"З них без дати, пар";"Нарядів"\r\n'+
    '"Модель A";"120";"80";"2"\r\n"Модель B";"30";"30";"1"\r\n"Модель C";"10";"0";"1"\r\n"РАЗОМ";"160";"110";""');
  const bounded=h.run("productionReportCSVWithHistory(productionReportRows('2026-11-01','2026-11-30',''))");
  assert(!bounded.includes('З них без дати'));
  assert(bounded.includes('"РАЗОМ";"40";""'));
});
test('empty history and invalid receipt quantities produce no phantom production',()=>{
  const h=harness();
  assert.deepEqual(result(h).rows,[]);
  assert.equal(result(h).undatedQuantity,0);
  h.run(`state.orders=[{id:'empty',product:'X',received:true,quantity:0},
    {id:'bad',product:'X',received_stock:{quantity:0,entries:[{quantity:-1},{quantity:'NaN'},{quantity:null},{quantity:'Infinity'},{quantity:0}]}},
    {id:'new',product:'X',quantity:100,received:false}];`);
  assert.deepEqual(result(h).rows,[]);
  assert.equal(result(h).undatedQuantity,0);
});
test('all-time supports received_stock fallback and counts a mixed receipt order once',()=>{
  const h=harness();
  h.run(`state.orders=[{id:'stock',product:'A',quantity:500,received:false,received_stock:{quantity:7}},
    {id:'mixed',product:'A',quantity:10,received:true,received_stock:{quantity:10,entries:[{quantity:3},{quantity:2,received_at:'2026-11-05T10:00:00Z'},{quantity:5}]}}];`);
  assert.deepEqual(result(h).rows,[{name:'A',quantity:17,count:2,undatedQuantity:15}]);
});
test('invalid periods are not treated as all-time and cannot be exported',()=>{
  const h=harness();historyFixture(h);
  for(const [from,to] of [['2026-11-30','2026-11-01'],['2026-02-30',''],['no-date',''],['','bad']]) {
    assert.throws(()=>result(h,from,to),/коректний період/);
  }
  h.run("navigate('production-report');setProductionReportField('from','2026-12-01');setProductionReportField('to','2026-11-01')");
  assert(h.node('page-content').innerHTML.includes('role="alert"'));
  assert(h.node('page-content').innerHTML.includes(' disabled>⬇️ CSV'));
});
test('report labels are HTML escaped and CSV formula prefixes are neutralized',()=>{
  const h=harness();
  h.run(`state.orders=[{id:'unsafe',product:'=2+3',quantity:5,received:true},
    {id:'html',product:'<b>"test"</b>',quantity:3,received:true}];navigate('production-report');setProductionReportPreset('all');`);
  assert(h.node('page-content').innerHTML.includes('&lt;b&gt;&quot;test&quot;&lt;/b&gt;'));
  assert(!h.node('page-content').innerHTML.includes('<td><b>'));
  assert(h.run("productionReportCSVWithHistory(productionReportRows('','',''))").includes('"\'=2+3"'));
});
