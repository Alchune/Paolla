const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].flatMap(match => {
  const src = match[1].match(/src="([^"]+)"/);
  if (src) return /^https?:/.test(src[1]) ? [] : [fs.readFileSync(path.join(root, src[1]), 'utf8')];
  return match[2].trim() ? [match[2]] : [];
});
const clone = value => JSON.parse(JSON.stringify(value));
const blank = () => ({ products: [], operations: [], orders: [], recipes: [], production: [], clients: [], workshops: [] });
const product = (quantity=100) => ({ id:'p1', name:'Model', unit:'пари', quantity, price:10, min_qty:0, category:'Взуття', pairs_per_box:8 });
const item = (quantity=20) => ({ product_id:'p1', product_name:'Model', product_unit:'пари', quantity, price:10 });
const outgoing = (status='reserved', quantity=20) => ({ id:1, type:'outgoing', status, date:'2026-09-08', counterparty:'Test', items:[item(quantity)] });
const encode = data => Buffer.from('{"alg":"none"}').toString('base64') + '.' + Buffer.from(JSON.stringify(data)).toString('base64') + '.';
const decode = row => JSON.parse(Buffer.from(row.payload.split('.')[1], 'base64').toString());
function database(data=blank()) {
  return { row: data === null ? null : { warehouse_id:'wh-test', modified_at:'2026-09-08T00:00:00.000Z', created_at:'2026-06-01T00:00:00.000Z', payload:encode(data) }, writes:[], readError:null, writeError:null, responseLost:false, readAfterWriteError:false, gate:null };
}
async function harness(db=database()) {
  const nodes = new Map(), notices = [], timers = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value:'', innerHTML:'', style:{}, dataset:{}, options:[], disabled:false,
      classList:{add(){}, remove(){}}, addEventListener(){}, setAttribute(){}, appendChild(){},
      querySelector(){return null;}, querySelectorAll(){return [];} });
    return nodes.get(id);
  }
  let booting = true, closeCount = 0;
  const ctx = {
    console, Blob, Intl, Date, Map, Set, Promise, encodeURIComponent, decodeURIComponent, escape, unescape,
    atob:s=>Buffer.from(s,'base64').toString('binary'), btoa:s=>Buffer.from(s,'binary').toString('base64'),
    document:{ readyState:'loading', getElementById:node, querySelector:node,
      querySelectorAll:selector=> selector === '[data-mutation-disabled]' ? [...nodes.values()].filter(n=>n.dataset.mutationDisabled) : [],
      addEventListener(){} },
    localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;}, clearTimeout(){},setInterval(){},
    confirm:()=>true, fetch:()=>{throw Error('Real network access is forbidden in regression tests');},
    MutationObserver:class {observe(){}},
    supabase:{createClient:()=>({
      auth:{
        getSession:async()=> booting ? await new Promise(()=>{}) : ({data:{session:ctx.noSession ? null : {user:{id:'u1'},expires_at:ctx.expiring ? 1 : 9999999999}},error:null}),
        refreshSession:async()=>({data:{session:ctx.refreshError?null:{user:{id:'u1'}}},error:ctx.refreshError?{message:'expired'}:null})
      },
      from:table=>{
        if (table !== 'warehouse_snapshots') {
          (db.metadataRequests ||= []).push(table);
          const result = table === 'warehouse_members' ? db.membershipResult : db.warehouseResult;
          const q = { select(){return q;},eq(){return q;},order(){return q;},limit(){return q;},
            maybeSingle:async()=>result,single:async()=>result,
            insert(){throw Error('Unexpected warehouse creation during failed loading');} };
          return q;
        }
        assert.equal(table,'warehouse_snapshots');
        let action='read',values,filters=[];
        const query={
          select(){return query;}, eq(key,value){filters.push([key,value]);return query;}, is(key,value){filters.push([key,value]);return query;},
          update(next){action='update';values=next;return query;}, insert(next){action='insert';values=next;return query;},
          async maybeSingle(){
            if (action==='read') return {data:db.readError?null:clone(db.row),error:db.readError&&{message:db.readError}};
            if (db.gate) await db.gate;
            db.writes.push({action,values:clone(values),filters:clone(filters)});
            if (db.writeError) return {data:null,error:{message:db.writeError}};
            if (action==='insert' && db.row) return {data:null,error:{code:'23505',message:'duplicate warehouse_id'}};
            if (action==='update' && (!db.row || !filters.every(([key,value]) => db.row[key] === value))) return {data:null,error:null};
            db.row={...db.row,...clone(values)};
            if (db.readAfterWriteError) db.readError='offline';
            if (db.responseLost) return {data:null,error:{message:'response lost'}};
            return {data:clone(db.row),error:null};
          }
        };
        return query;
      },
      storage:{from:()=>({upload:async()=>({error:null})})}
    })}
  };
  ctx.window=ctx;
  vm.createContext(ctx);
  scripts.forEach((source,index)=>vm.runInContext(source,ctx,{filename:'script-'+index}));
  booting=false;
  const run=source=>vm.runInContext(source,ctx);
  ctx.showNotif=(text,type='success')=>notices.push({text,type});
  ctx.closeModal=()=>{closeCount++;};
  for (const name of ['renderInventory','renderOperation','renderOrders','openOrderView','refreshCurrentPage']) ctx[name]=()=>{};
  run("state.user={id:'u1'};state.warehouse={id:'wh-test'}");
  await run('loadSnapshotForCurrent()');
  return {ctx,run,node,notices,timers,db,state:()=>JSON.parse(run('JSON.stringify(state)')),closeCount:()=>closeCount,
    operationForm(items=[item()]) {
      node('op-counterparty').value='Test';node('op-date').value='2026-09-08';
      // Exercise the real collector with form rows, including pair/box metadata.
      node('op-items-body').querySelectorAll=()=>items.map(it=>({dataset:{pairsPerBox:String(it.pairs_per_box||8)},querySelector:selector=>({
        '.item-product':{value:it.product_id,options:[{text:it.product_name}],selectedIndex:0},
        '.item-qty':{value:String(it.entered_quantity??it.quantity)},
        '.item-price':{value:String(it.price??0)},
        '.item-quantity-unit':{value:it.quantity_unit||'pairs'}
      })[selector]}));
    },
    orderForm({quantity=20,productId='p1',editId=null,operations=[]}={}) {
      node('o-client').value='Test';node('o-product').value=productId;node('o-qty').value=String(quantity);node('o-num').value='0001';
      ctx._editingOrderId=editId;ctx._orderOps=clone(operations);
    }
  };
}
const fixture = extra => ({...blank(), products:[product()], ...extra});

test('all browser scripts parse in their real loading order',()=>scripts.forEach(source=>new vm.Script(source)));
test('outgoing product options subtract unposted reservations in stock units',async()=>{
  const h=await harness(database(fixture({operations:[
    {...outgoing('reserved'),items:[{...item(24),quantity_unit:'boxes',entered_quantity:3,pairs_per_box:8},item('4')]},
    {...outgoing('draft',8),id:2,archived:true},
    {id:3,type:'outgoing',status:'reserved',product_id:'p1',quantity:2},
    {...outgoing('conducted',50),id:4},
    {id:5,type:'outgoing',product_id:'p1',quantity:50},
    {...outgoing('cancelled',50),id:6},
    {id:7,type:'incoming',status:'reserved',items:[item(50)]},
    {...outgoing('reserved'),id:8,items:[{...item(50),product_id:'other'}]}
  ]})));
  const before=h.state();
  assert(h.run("buildOperationProductOptions('outgoing')").includes('Model (пари) · 8 пар/ящ. — На складі: 100 · Вільно: 62</option>'));
  assert(h.run("buildOperationProductOptions('incoming')").includes('Model (пари) · 8 пар/ящ. — 100</option>'));
  assert.deepEqual(h.state(),before);
  assert.equal(h.db.writes.length,0);
});
test('free stock labels preserve fractions, negative balances, zero and product ID types',async()=>{
  const h=await harness(database(fixture({products:[
    {...product(0.3),id:1,unit:'м'},
    {...product(0),id:'zero'},
    {...product(10),id:'negative'}
  ],operations:[{...outgoing(),items:[
    {...item('0.1'),product_id:'1'},
    {...item(12),product_id:'negative'}
  ]}]})));
  const options=h.run("buildOperationProductOptions('outgoing')");
  assert(options.includes('Model (м) — На складі: 0.3 · Вільно: 0.2</option>'));
  assert(options.includes('На складі: 0 · Вільно: 0</option>'));
  assert(options.includes('На складі: 10 · Вільно: -2</option>'));
});
test('rejected inventory save restores confirmed stock and permits retry',async()=>{
  const h=await harness(database(fixture({products:[product(10)]})));
  h.node('.inv-pairs[data-id="p1"]').value='15';h.db.writeError='denied';
  await h.run("saveInventoryCorrection('p1')");
  assert.equal(h.state().products[0].quantity,10);assert.equal(h.state().operations.length,0);
  assert(!h.notices.some(n=>n.type==='success'));assert.equal(h.closeCount(),0);
  h.db.writeError=null;await h.run("saveInventoryCorrection('p1')");
  assert.equal(h.db.writes.length,2);assert.equal(decode(h.db.row).products[0].quantity,15);
  await h.run('loadSnapshotForCurrent()');assert.equal(h.state().operations.length,1);
});
test('failed and malformed reads preserve prior data and block writes',async()=>{
  const h=await harness(database(fixture({})));
  h.db.readError='offline';await assert.rejects(h.run('loadSnapshotForCurrent()'));
  h.operationForm();await h.run("saveOperation('outgoing',null)");
  assert.equal(h.db.writes.length,0);assert.equal(h.state().products[0].quantity,100);
  h.db.readError=null;h.db.row.payload='bad';await assert.rejects(h.run('loadSnapshotForCurrent()'));
  assert.equal(h.state().products[0].quantity,100);
});
test('membership lookup errors never create a replacement warehouse',async()=>{
  const h=await harness(database(fixture({})));h.db.membershipResult={data:null,error:{message:'denied'}};
  await assert.rejects(h.run('loadWarehouse()'));
  assert.deepEqual(h.db.metadataRequests,['warehouse_members']);assert.equal(h.db.writes.length,0);
  h.operationForm();await h.run("saveOperation('outgoing',null)");assert.equal(h.db.writes.length,0);
});
test('warehouse metadata read errors stop loading and preserve confirmed stock',async()=>{
  const h=await harness(database(fixture({})));h.db.membershipResult={data:{warehouse_id:'wh-test',access_mode:'owner'},error:null};
  h.db.warehouseResult={data:null,error:{message:'offline'}};
  await assert.rejects(h.run('loadWarehouse()'));assert.equal(h.state().products[0].quantity,100);assert.equal(h.db.writes.length,0);
});
test('a different warehouse never inherits previous warehouse data after a failed read',async()=>{
  const h=await harness(database(fixture({})));h.run("state.warehouse={id:'different'}");h.db.readError='denied';
  await assert.rejects(h.run('loadSnapshotForCurrent()'));assert.equal(h.state().products.length,0);
  await assert.rejects(h.run('saveSnapshot()'));assert.equal(h.db.writes.length,0);
});
test('missing snapshot is created with insert; created_at survives later updates',async()=>{
  const h=await harness(database(null));h.run("state.products=[{id:'p1',name:'Model',quantity:10}]");await h.run('saveSnapshot()');
  const created=h.db.row.created_at;h.run('state.products[0].quantity=11');await h.run('saveSnapshot()');
  assert.deepEqual(h.db.writes.map(w=>w.action),['insert','update']);assert.equal(h.db.row.created_at,created);
});
test('existing duplicate product and order IDs retain the last record',async()=>{
  const h=await harness(database(fixture({products:[product(10),product(20)],orders:[{id:1,number:'old'},{id:1,number:'new'}]})));
  assert.equal(h.state().products.length,1);assert.equal(h.state().products[0].quantity,20);
  assert.equal(h.state().orders.length,1);assert.equal(h.state().orders[0].number,'new');
});
test('two stale clients cannot overwrite each other; explicit retry uses current stock',async()=>{
  const db=database(fixture({})),a=await harness(db),b=await harness(db);a.operationForm([item(10)]);b.operationForm([item(20)]);
  await a.run("saveOperation('outgoing',null)");await b.run("saveOperation('outgoing',null)");
  assert.equal(decode(db.row).products[0].quantity,90);assert.equal(decode(db.row).operations.length,1);
  assert(b.notices.some(n=>n.type==='error'&&n.text.includes('інший користувач')));
  await b.run("saveOperation('outgoing',null)");assert.equal(decode(db.row).products[0].quantity,70);assert.equal(decode(db.row).operations.length,2);
});
test('racing first writes do not replace the winner',async()=>{
  const db=database(null),a=await harness(db),b=await harness(db);
  a.run("state.clients.push({id:1,name:'First'})");await a.run('saveSnapshot()');
  b.run("state.clients.push({id:2,name:'Second'})");await assert.rejects(b.run('saveSnapshot()'));
  assert.equal(decode(db.row).clients[0].name,'First');
});
test('lost write response is reconciled without a second movement',async()=>{
  const h=await harness(database(fixture({})));h.operationForm();h.db.responseLost=true;
  await h.run("saveOperation('outgoing',null)");assert.equal(h.state().products[0].quantity,80);
  assert.equal(h.closeCount(),1);assert.equal(h.db.writes.length,1);assert(h.notices.some(n=>n.type==='success'));
});
test('unconfirmed response and failed read are resolved by retry, not double posting',async()=>{
  const h=await harness(database(fixture({})));h.operationForm();h.db.responseLost=true;h.db.readAfterWriteError=true;
  await h.run("saveOperation('outgoing',null)");assert.equal(h.closeCount(),0);assert.equal(h.state().products[0].quantity,100);
  h.db.readError=null;h.db.readAfterWriteError=false;h.db.responseLost=false;
  await h.run("saveOperation('outgoing',null)");assert.equal(h.db.writes.length,1);assert.equal(h.state().products[0].quantity,80);
});
test('expired or unavailable authentication cannot report a successful save',async()=>{
  for (const mode of ['noSession','refreshError']) {
    const h=await harness(database(fixture({})));h.operationForm();h.ctx[mode]=true;h.ctx.expiring=true;
    await h.run("saveOperation('outgoing',null)");assert.equal(h.db.writes.length,0);assert.equal(h.state().products[0].quantity,100);
    assert(!h.notices.some(n=>n.type==='success'));
  }
});
test('double submission creates one outgoing document',async()=>{
  const h=await harness(database(fixture({})));h.operationForm();
  await h.run("Promise.all([saveOperation('outgoing',null),saveOperation('outgoing',null)])");
  assert.equal(h.state().products[0].quantity,80);assert.equal(h.state().operations.length,1);assert.equal(h.db.writes.length,1);
});
test('other mutation is blocked while a snapshot write is in flight',async()=>{
  const h=await harness(database(fixture({})));h.operationForm();let release;h.db.gate=new Promise(resolve=>release=resolve);
  const pending=h.run("saveOperation('outgoing',null)");await Promise.resolve();
  await h.run("saveReservation(null)");release();await pending;
  assert.equal(h.state().operations.length,1);assert.equal(h.state().products[0].quantity,80);
});
test('deleting a reservation leaves stock unchanged; deleting posted outgoing reverses once',async()=>{
  for (const [status,stock,expected] of [['reserved',100,100],['conducted',80,100]]) {
    const h=await harness(database(fixture({products:[product(stock)],operations:[outgoing(status)]})));
    await h.run("deleteOperation('1','outgoing')");assert.equal(h.state().products[0].quantity,expected);assert.equal(h.state().operations.length,0);
  }
});
test('direct conducted-to-reserved transition is rejected; explicit unpost/repost balances stock',async()=>{
  const h=await harness(database(fixture({products:[product(80)],operations:[outgoing('conducted')]})));h.operationForm();
  await h.run('saveReservation(1)');assert.equal(h.state().operations[0].status,'conducted');assert.equal(h.db.writes.length,0);
  await h.run('unpostOperation(1)');assert.equal(h.state().products[0].quantity,100);
  await h.run("saveOperation('outgoing',1)");assert.equal(h.state().products[0].quantity,80);
  await h.run("saveOperation('outgoing',1)");assert.equal(h.state().products[0].quantity,80);
});
test('reservation edit does not change physical stock',async()=>{
  const h=await harness(database(fixture({operations:[outgoing()]})));h.operationForm([item(50)]);await h.run('saveReservation(1)');
  assert.equal(h.state().products[0].quantity,100);assert.equal(h.state().operations[0].items[0].quantity,50);
});
test('legacy incoming and outgoing edits reverse old quantities',async()=>{
  for (const [type,stock] of [['incoming',120],['outgoing',80]]) {
    const h=await harness(database(fixture({products:[product(stock)],operations:[{id:1,type,...item()}]})));h.operationForm();
    await h.run(`saveOperation('${type}',1)`);assert.equal(h.state().products[0].quantity,stock);
  }
});
test('posted document edit adjusts both products when its item changes',async()=>{
  const h=await harness(database(fixture({products:[product(80),{...product(50),id:'p2',name:'Second'}],operations:[outgoing('conducted')]})));
  h.operationForm([{...item(5),product_id:'p2'}]);await h.run("saveOperation('outgoing',1)");
  assert.deepEqual(h.state().products.map(p=>p.quantity),[100,45]);
});
test('invalid quantities, negative prices and missing products do not write',async()=>{
  for (const bad of [item(Infinity),item(-1),{...item(),price:-5},{...item(),product_id:'missing'}]) {
    const h=await harness(database(fixture({})));h.operationForm([bad]);await h.run("saveOperation('outgoing',null)");
    assert.equal(h.db.writes.length,0);assert.equal(h.state().products[0].quantity,100);
  }
});
test('boxes use the stored pack size and negative stock remains supported',async()=>{
  const h=await harness(database(fixture({})));h.operationForm([{...item(),entered_quantity:15,quantity_unit:'boxes',pairs_per_box:8}]);
  await h.run("saveOperation('outgoing',null)");assert.equal(h.state().products[0].quantity,-20);assert.equal(h.state().operations[0].items[0].quantity,120);
});
test('renamed product is received using its ID; undo uses the saved receipt movement',async()=>{
  const h=await harness(database(fixture({products:[{...product(10.5),name:'Renamed'}],orders:[{id:1,product_id:'p1',product:'Old',quantity:5,operations:[]}]})));
  await h.run("receiveOrderStock('1',true)");assert.equal(h.state().products[0].quantity,15.5);
  await h.run('receiveOrderStock(1,true)');assert.equal(h.db.writes.length,1);
  h.run('state.orders[0].quantity=100');await h.run('receiveOrderStock(1,false)');assert.equal(h.state().products[0].quantity,10.5);
});
test('missing and ambiguous legacy product names do not mark order received',async()=>{
  for (const products of [[product()], [product(),{...product(),id:'p2'}]]) {
    const h=await harness(database(fixture({products,orders:[{id:1,product:products.length===1?'Missing':'Model',quantity:5,operations:[]}]})));
    await h.run('receiveOrderStock(1,true)');assert(!h.state().orders[0].received);assert.equal(h.db.writes.length,0);
  }
});
test('legacy unique product names are linked on load and saved on next write',async()=>{
  const h=await harness(database(fixture({orders:[{id:1,product:'Model',quantity:5,operations:[]}]})));
  assert.equal(h.state().orders[0].product_id,'p1');await h.run('receiveOrderStock(1,true)');assert.equal(decode(h.db.row).orders[0].product_id,'p1');
});
test('editing an active order uses one write and preserves completed steps',async()=>{
  const h=await harness(database(fixture({orders:[{id:1,product_id:'p1',product:'Model',quantity:10,status:'in_production',operations:[{workshop:'Casting',done:true}]}]})));
  h.orderForm({editId:1,quantity:20,operations:[{workshop:'Casting',done:true}]});await h.run('saveOrder()');
  assert.equal(h.db.writes.length,1);assert.equal(h.state().orders.length,1);assert.equal(h.state().orders[0].quantity,20);assert.equal(h.state().orders[0].operations[0].done,true);
});
test('received orders reject edit, delete and workshop cancellation',async()=>{
  for (const action of ['saveOrder()','deleteOrder(1)','toggleOrderOp(1,0,false)']) {
    const h=await harness(database(fixture({orders:[{id:1,product_id:'p1',product:'Model',quantity:10,received:true,status:'ready',operations:[{workshop:'Casting',done:true}]}]})));
    h.orderForm({editId:1});await h.run(action);assert.equal(h.db.writes.length,0);assert.equal(h.state().orders[0].quantity,10);assert.equal(h.state().orders[0].operations[0].done,true);
  }
});
test('new order validates quantities and keeps the selected product ID',async()=>{
  const h=await harness(database(fixture({})));h.orderForm({quantity:0});await h.run('saveOrder()');assert.equal(h.db.writes.length,0);
  h.orderForm({quantity:5});await h.run('saveOrder()');assert.equal(h.state().orders[0].product_id,'p1');assert.equal(h.state().orders[0].quantity,5);
});
test('reports total items and legacy documents while excluding reservations',async()=>{
  const h=await harness(database(fixture({operations:[{id:1,type:'incoming',items:[{quantity:10,price:20}]},{id:2,type:'outgoing',status:'conducted',items:[{quantity:4,price:30}]},{id:3,type:'incoming',quantity:2,price:5,product_id:'p1'},outgoing('reserved',100)]})));
  h.run('renderReports()');const rendered=h.node('page-content').innerHTML;
  assert(rendered.includes('Загальний прихід</div><div class="value">210'));
  assert(rendered.includes('Загальний видаток</div><div class="value">120'));
});
test('dashboard shows stock count and activity without low stock or active orders',async()=>{
  const h=await harness(database(fixture({products:[product(0)],orders:[{id:1,status:'ready',received:true},{id:2,status:'cancelled'},{id:3,status:'shipped'},{id:4,status:'new'}],operations:[outgoing('conducted')]})));
  h.run('renderDashboard()');const rendered=h.node('page-content').innerHTML;
  assert(rendered.includes('Товарів на складі</div><div class="value">1'));
  assert(rendered.includes('Остання активність'));
  assert(rendered.includes('Видаток: Model'));
  assert(!rendered.includes('Мало залишків'));
  assert(!rendered.includes('Активні замовлення'));
  assert.equal(h.db.writes.length,0);
});
test('non-pair product quantity and unit appear in print output',async()=>{
  const h=await harness(database(fixture({operations:[{id:1,type:'incoming',items:[{product_name:'Material',product_unit:'кг',quantity:5,price:2}]}]})));
  let printed='';h.ctx.open=()=>({document:{write:value=>printed+=value,close(){}}});h.run("printOperation(1,'incoming')");
  assert(printed.includes('5 кг'));assert(printed.includes('Сума: 10.00'));
});
test('products with stock or history cannot be hard deleted',async()=>{
  const h=await harness(database(fixture({})));await h.run("deleteProduct('p1')");assert.equal(h.state().products.length,1);assert.equal(h.db.writes.length,0);
});
test('failed reservation and order writes keep forms open and roll back records',async()=>{
  for (const action of ['saveReservation(null)','saveOrder()']) {
    const h=await harness(database(fixture({})));h.operationForm();h.orderForm();h.db.writeError='denied';await h.run(action);
    assert.equal(h.closeCount(),0);assert.equal(h.state().orders.length,0);assert.equal(h.state().operations.length,0);assert(!h.notices.some(n=>n.type==='success'));
  }
});
