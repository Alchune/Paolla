// Snapshot writes use an atomic modified_at predicate, not an unconditional upsert.
// Keep confirmed data separate from edits until the server acknowledges the write.
const SNAPSHOT_COLLECTIONS = ['products', 'operations', 'orders', 'recipes', 'production', 'clients', 'workshops'];
let snapshotSync = { warehouseId: null, loaded: false, row: null, confirmed: null, pending: null };
let dataMutationBusy = false;
let snapshotWriteBusy = false;

function cloneData(value) { return JSON.parse(JSON.stringify(value)); }
function snapshotData() {
  const result = {};
  SNAPSHOT_COLLECTIONS.forEach(key => { result[key] = cloneData(state[key] || []); });
  return result;
}
function replaceSnapshotData(data) {
  SNAPSHOT_COLLECTIONS.forEach(key => { state[key] = cloneData(data[key] || []); });
}
function decodeSnapshot(row) {
  if (!row) return Object.fromEntries(SNAPSHOT_COLLECTIONS.map(key => [key, []]));
  if (typeof row.payload !== 'string') throw new Error('Некоректний формат даних складу. Збереження заблоковано.');
  const data = JSON.parse(decodeURIComponent(escape(atob(row.payload.split('.')[1]))));
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.operations)) {
    throw new Error('Некоректний формат даних складу. Збереження заблоковано.');
  }
  SNAPSHOT_COLLECTIONS.forEach(key => {
    if (data[key] === undefined) data[key] = [];
    if (!Array.isArray(data[key])) throw new Error('Пошкоджено дані складу: ' + key);
    if (key !== 'workshops' && data[key].some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('Пошкоджено записи складу: ' + key);
    }
  });
  // Preserve the old loader's duplicate-ID cleanup for existing snapshots.
  ['products', 'orders'].forEach(key => {
    if (data[key].some(item => item.id == null)) throw new Error('Запис без ідентифікатора: ' + key);
    data[key] = Array.from(new Map(data[key].map(item => [String(item.id), item])).values());
  });
  // Old records are linked only when the name has a single, unambiguous match.
  data.orders.forEach(order => {
    if (order.product_id != null) return;
    const matches = data.products.filter(product => product.name === order.product);
    if (matches.length === 1) order.product_id = matches[0].id;
  });
  return data;
}
function acceptSnapshot(row, warehouseId) {
  const decoded = decodeSnapshot(row);
  if (String(state.warehouse?.id) !== String(warehouseId)) throw new Error('Склад змінився. Оновіть дані.');
  replaceSnapshotData(decoded);
  snapshotSync = { warehouseId: String(warehouseId), loaded: true, row: row && cloneData(row), confirmed: snapshotData(), pending: null };
}
async function readSnapshot(warehouseId) {
  const { data, error } = await sb.from('warehouse_snapshots').select('*').eq('warehouse_id', warehouseId).maybeSingle();
  if (error) throw new Error('Не вдалося завантажити склад: ' + error.message);
  // Validate before changing either confirmed data or the visible state.
  decodeSnapshot(data);
  return data;
}
async function loadSnapshotForCurrent() {
  if (!state.warehouse) throw new Error('Спершу оберіть склад.');
  const warehouseId = String(state.warehouse.id);
  snapshotSync.loaded = false;
  if (snapshotSync.warehouseId !== warehouseId) {
    replaceSnapshotData({});
    snapshotSync = { warehouseId, loaded: false, row: null, confirmed: null, pending: null };
  }
  const row = await readSnapshot(warehouseId);
  acceptSnapshot(row, warehouseId);
}
function assertSnapshotReady() {
  if (!state.warehouse || !snapshotSync.loaded || snapshotSync.warehouseId !== String(state.warehouse.id)) {
    throw new Error('Дані складу не завантажено. Натисніть «Повторити завантаження».');
  }
}
async function ensureWriteSession() {
  const { data, error } = await sb.auth.getSession();
  if (error || !data?.session) throw new Error('Сесія завершилася. Увійдіть знову; дані не збережено.');
  if (data.session.expires_at && data.session.expires_at * 1000 < Date.now() + 60000) {
    const refreshed = await sb.auth.refreshSession();
    if (refreshed.error || !refreshed.data?.session) throw new Error('Не вдалося оновити сесію. Увійдіть знову.');
  }
}
function encodeSnapshot(data) {
  return btoa(JSON.stringify({ alg: 'none' })) + '.' + btoa(unescape(encodeURIComponent(JSON.stringify(data)))) + '.';
}
function nextSnapshotTime(previous) {
  return new Date(Math.max(Date.now(), (Date.parse(previous) || 0) + 1)).toISOString();
}
async function reconcileSnapshotWrite() {
  const pending = snapshotSync.pending;
  if (!pending) return 'none';
  const remote = await readSnapshot(pending.warehouseId);
  if (remote?.payload === pending.payload) {
    acceptSnapshot(remote, pending.warehouseId);
    return 'committed';
  }
  const unchanged = remote?.payload === pending.previousRow?.payload &&
    remote?.modified_at === pending.previousRow?.modified_at;
  acceptSnapshot(remote, pending.warehouseId);
  return unchanged ? 'not-committed' : 'conflict';
}
async function saveSnapshot() {
  assertSnapshotReady();
  if (snapshotWriteBusy || snapshotSync.pending) throw new Error('Попередній запис ще не підтверджено. Повторіть дію для перевірки.');
  snapshotWriteBusy = true;
  const previousData = snapshotSync.confirmed;
  try {
    await ensureWriteSession();
    const warehouseId = snapshotSync.warehouseId;
    const previousRow = snapshotSync.row;
    const payload = encodeSnapshot(snapshotData());
    const values = { payload, modified_at: nextSnapshotTime(previousRow?.modified_at) };
    snapshotSync.pending = { warehouseId, payload, previousRow: previousRow && cloneData(previousRow) };
    let request;
    if (previousRow) {
      request = sb.from('warehouse_snapshots').update(values).eq('warehouse_id', warehouseId);
      request = previousRow.modified_at == null ? request.is('modified_at', null) : request.eq('modified_at', previousRow.modified_at);
    } else {
      // A unique warehouse_id rejects racing first writes rather than replacing them.
      request = sb.from('warehouse_snapshots').insert({ warehouse_id: warehouseId, ...values, created_at: values.modified_at });
    }
    const { data, error } = await request.select('*').maybeSingle();
    if (error) throw new Error('Не вдалося зберегти: ' + error.message);
    if (!data) throw new Error('Дані змінив інший користувач або запис недоступний. Перевірте дані й повторіть дію.');
    if (data.payload !== payload) throw new Error('База не підтвердила надіслані дані.');
    acceptSnapshot(data, warehouseId);
  } catch (error) {
    if (previousData) replaceSnapshotData(previousData);
    if (snapshotSync.pending) {
      let resolution;
      try { resolution = await reconcileSnapshotWrite(); }
      catch (_) {
        throw new Error('Результат запису не підтверджено. Повторіть дію для перевірки; введені поля залишилися у формі.');
      }
      if (resolution === 'committed') { await publishCatalog(); return; }
      if (resolution === 'conflict') throw new Error('Дані змінив інший користувач. Завантажено актуальний стан; перевірте введені значення й повторіть дію.');
    }
    throw error;
  } finally {
    snapshotWriteBusy = false;
  }
  // Catalog failure must not turn a confirmed warehouse write into a retry.
  await publishCatalog();
}

function setMutationBusy(busy) {
  dataMutationBusy = busy;
  if (busy) {
    document.querySelectorAll('button, input, select, textarea').forEach(element => {
      if (!element.disabled) { element.dataset.mutationDisabled = '1'; element.disabled = true; }
    });
  } else {
    document.querySelectorAll('[data-mutation-disabled]').forEach(element => {
      element.disabled = false;
      delete element.dataset.mutationDisabled;
    });
  }
}
function installMutationGuards() {
  const names = ['saveClient', 'deleteClient', 'saveProduct', 'deleteProduct', 'duplicateProduct',
    'archiveProduct', 'unarchiveProduct', 'archiveOperation', 'unarchiveOperation', 'saveOperation',
    'saveReservation', 'unpostOperation', 'deleteOperation', 'saveInventoryCorrection', 'newWorkshop',
    'saveOrder', 'deleteOrder', 'updateOrderStatus', 'toggleOrderOp', 'receiveOrderStock',
    'saveRecipe', 'advanceDeptStatus', 'confirmStartProduction', 'completeProduction'];
  names.forEach(name => {
    const action = window[name];
    if (typeof action !== 'function') throw new Error('Missing data action: ' + name);
    window[name] = async function(...args) {
      if (dataMutationBusy) return;
      setMutationBusy(true);
      const before = snapshotData();
      try {
        assertSnapshotReady();
        if (snapshotSync.pending) {
          const resolution = await reconcileSnapshotWrite();
          if (resolution === 'committed') {
            await publishCatalog();
            closeModal();
            refreshCurrentPage();
            showNotif('Попередню дію збережено. Повторного запису не виконано.', 'success');
            return;
          }
          if (resolution === 'conflict') throw new Error('Завантажено зміни іншого користувача. Перевірте форму й повторіть дію.');
        }
        return await action.apply(this, args);
      } catch (error) {
        replaceSnapshotData(snapshotSync.confirmed || before);
        showNotif(error.message || 'Не вдалося зберегти дані. Повторіть дію.', 'error');
      } finally {
        setMutationBusy(false);
      }
    };
  });
  document.addEventListener('click', event => {
    if (dataMutationBusy) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  // Keep the original form available while an uncertain write is being resolved.
  ['navigate', 'closeModal', 'openClientModal', 'openProductModal', 'openOperationModal',
    'openOrderModal', 'openOrderView', 'openRecipeModal', 'openStartProductionModal'].forEach(name => {
    const open = window[name];
    window[name] = function(...args) {
      if (snapshotSync.pending) return showNotif('Спершу повторіть попередню дію, щоб перевірити збереження.', 'error');
      return open.apply(this, args);
    };
  });
}

function operationItems(operation) {
  if (!operation) return [];
  if (Array.isArray(operation.items) && operation.items.length) return operation.items;
  if (operation.product_id != null || operation.product_name) {
    return [{ product_id: operation.product_id, product_name: operation.product_name,
      product_unit: operation.product_unit || operation.unit, quantity: operation.quantity, price: operation.price }];
  }
  return [];
}
function isPostedOperation(operation) {
  if (!operation) return false;
  if (operation.type === 'incoming') return !['draft', 'reserved', 'cancelled'].includes(operation.status);
  // The original single-item format created outgoing movements without a status.
  return operation.type === 'outgoing' && (operation.status === 'conducted' || !operation.status);
}
function operationTotal(operation) {
  return Math.round(operationItems(operation).reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0) * 100) / 100;
}
function requireProduct(productId) {
  const product = state.products.find(item => String(item.id) === String(productId));
  if (!product) throw new Error('Товар не знайдено. Уточніть товар до зміни залишку.');
  return product;
}
function resolveOrderProduct(order) {
  if (order.product_id != null) return requireProduct(order.product_id);
  const matches = state.products.filter(product => product.name === order.product);
  if (matches.length !== 1) throw new Error('Не вдалося однозначно визначити товар наряду. Відредагуйте наряд і оберіть товар.');
  return matches[0];
}
function positiveQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0 || roundOperationQuantity(quantity) <= 0) throw new Error('Введіть коректну кількість більше 0.');
  return roundOperationQuantity(quantity);
}
function applyOperationTransition(previous, next) {
  const changes = new Map();
  function add(operation, multiplier) {
    if (!isPostedOperation(operation)) return;
    const direction = operation.type === 'incoming' ? 1 : -1;
    operationItems(operation).forEach(item => {
      const product = requireProduct(item.product_id);
      const delta = multiplier * direction * positiveQuantity(item.quantity);
      changes.set(product, (changes.get(product) || 0) + delta);
    });
  }
  add(previous, -1);
  add(next, 1);
  changes.forEach((delta, product) => {
    const quantity = Number(product.quantity);
    if (!Number.isFinite(quantity)) throw new Error('Некоректний залишок товару: ' + product.name);
    product.quantity = roundOperationQuantity(quantity + delta);
  });
}
function isActiveOrder(order) {
  return !order.received && !['completed', 'shipped', 'cancelled'].includes(order.status);
}
function localISODate() {
  const date = new Date();
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
function newRecordId() {
  // Preserve numeric IDs for existing inline action attributes while avoiding same-ms collisions.
  const used = new Set(SNAPSHOT_COLLECTIONS.flatMap(key => (state[key] || []).map(item => item && item.id)));
  let value = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  while (used.has(value)) value++;
  return value;
}
