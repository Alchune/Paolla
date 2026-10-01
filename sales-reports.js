// Read-only sales reporting. Quantities in operation items are already in stock units.
const salesReportFilters = new Map();
function salesReportDateValid(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
    Number.isFinite(Date.parse(value + 'T12:00:00Z')) &&
    new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}
function salesReportModelKey(item) {
  return item.product_id != null && item.product_id !== '' ? 'id:' + item.product_id : 'name:' + (item.product_name || 'Без назви');
}
function salesReportModelOptions(products, operations) {
  const models = new Map(products.map(p => ['id:' + p.id, p.name || 'Без назви']));
  operations.filter(isPostedOperation).filter(o => o.type === 'outgoing').forEach(o => {
    operationItems(o).forEach(item => {
      const key = salesReportModelKey(item);
      if (!models.has(key)) models.set(key, item.product_name || 'Товар #' + item.product_id);
    });
  });
  return [...models].sort((a, b) => a[1].localeCompare(b[1], 'uk', {numeric:true}));
}
function buildSalesReport(operations, products, filters) {
  if (!salesReportDateValid(filters.from) || !salesReportDateValid(filters.to) || filters.from > filters.to) {
    throw new Error('Вкажіть коректний період: дата початку має бути не пізнішою за дату кінця.');
  }
  const byId = new Map(products.map(p => [String(p.id), p]));
  const rows = [], models = new Map(), parties = new Map(), units = new Map(), docs = new Set();
  let missingDates = 0, missingQuantities = 0, total = 0;
  operations.forEach((op, index) => {
    if (op.type !== 'outgoing' || !isPostedOperation(op)) return;
    const party = String(op.counterparty || '').trim();
    if (filters.party && party !== filters.party) return;
    const items = operationItems(op).filter(item => !filters.model || salesReportModelKey(item) === filters.model);
    if (!items.length) return;
    const date = filters.basis === 'document' ? op.date : operationDisplayDate(op);
    if (!salesReportDateValid(date)) { missingDates++; return; }
    if (date < filters.from || date > filters.to) return;
    items.forEach(item => {
      const quantity = Number(item.quantity);
      if (item.quantity == null || item.quantity === '' || !Number.isFinite(quantity)) { missingQuantities++; return; }
      const product = byId.get(String(item.product_id));
      let unit = String(item.product_unit || item.unit || product?.unit || 'шт');
      if (/^пар/i.test(unit)) unit = 'пар';
      const amount = quantity * (Number(item.price) || 0);
      const modelKey = salesReportModelKey(item), key = JSON.stringify([modelKey, unit]);
      const row = {date, documentDate:op.date || '', postingDate:operationDisplayDate(op),
        document:String(op.id ?? index + 1), party:party || 'Без контрагента', model:product?.name || item.product_name || 'Без назви',
        unit, quantity, amount, docKey:index, modelKey};
      rows.push(row); docs.add(index); total += amount;
      units.set(unit, (units.get(unit) || 0) + quantity);
      if (!models.has(key)) models.set(key, {model:row.model, unit, quantity:0, amount:0, docs:new Set()});
      const model = models.get(key); model.quantity += quantity; model.amount += amount; model.docs.add(index);
      if (!parties.has(party)) parties.set(party, {party:row.party, units:new Map(), amount:0, docs:new Set(), models:new Set()});
      const client = parties.get(party); client.amount += amount; client.docs.add(index); client.models.add(modelKey);
      client.units.set(unit, (client.units.get(unit) || 0) + quantity);
    });
  });
  return {rows:rows.sort((a,b) => b.date.localeCompare(a.date) || a.model.localeCompare(b.model, 'uk')),
    models:[...models.values()].sort((a,b) => b.amount - a.amount || a.model.localeCompare(b.model, 'uk', {numeric:true})),
    parties:[...parties.values()].sort((a,b) => b.amount - a.amount || a.party.localeCompare(b.party, 'uk')),
    units, total:Math.round(total * 100) / 100, documents:docs.size,
    modelCount:new Set(rows.map(r => r.modelKey)).size, missingDates, missingQuantities};
}
function currentSalesReportFilters() {
  const key = activePageStorageKey();
  if (!salesReportFilters.has(key)) {
    const year = warehouseCalendarDate(Date.now()).slice(0,4);
    salesReportFilters.set(key, {from:year + '-01-01', to:year + '-12-31', model:'', party:'', basis:'posting'});
  }
  return salesReportFilters.get(key);
}
function readSalesReportFilters() {
  const filters = currentSalesReportFilters();
  for (const key of ['from', 'to', 'model', 'party', 'basis']) filters[key] = document.getElementById('report-' + key).value;
  return filters;
}
function applySalesReportFilters() { readSalesReportFilters(); renderSalesReports(); }
function salesReportPreset(preset) {
  const filters = readSalesReportFilters(), today = warehouseCalendarDate(Date.now());
  const year = Number(today.slice(0,4)) - (preset === 'previous' ? 1 : 0);
  filters.from = preset === 'month' ? today.slice(0,7) + '-01' : year + '-01-01';
  filters.to = preset === 'month' ? today : year + '-12-31';
  renderSalesReports();
}
function resetSalesReportFilters() { salesReportFilters.delete(activePageStorageKey()); renderSalesReports(); }
function salesReportUnitSummary(units) {
  return [...units].map(([unit, quantity]) => formatMoney(quantity) + ' ' + unit).join('; ') || '0';
}
function renderSalesReports() {
  const filters = currentSalesReportFilters(), esc = escapeHtml;
  const models = salesReportModelOptions(state.products, state.operations);
  const parties = [...new Set([...state.clients.map(c => String(c.name || '').trim()),
    ...state.operations.filter(o => o.type === 'outgoing').map(o => String(o.counterparty || '').trim())])]
    .filter(Boolean).sort((a,b) => a.localeCompare(b,'uk',{numeric:true}));
  const options = (values, selected) => values.map(([value,label]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  let report, error;
  try { report = buildSalesReport(state.operations, state.products, filters); } catch (e) { error = e.message; }
  const empty = (columns, message='За обраними фільтрами продажів немає.') => `<tr><td colspan="${columns}" style="text-align:center;padding:24px;color:var(--text2)">${message}</td></tr>`;
  document.getElementById('page-content').innerHTML = `
<div class="table-container" style="margin-bottom:20px">
  <div class="table-header"><h3>Продажі за період</h3></div>
  <div style="padding:20px">
    <form onsubmit="event.preventDefault();applySalesReportFilters()">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px">
        <div class="form-group"><label class="form-label" for="report-from">Дата початку</label><input class="form-input" type="date" id="report-from" value="${esc(filters.from)}" required></div>
        <div class="form-group"><label class="form-label" for="report-to">Дата кінця</label><input class="form-input" type="date" id="report-to" value="${esc(filters.to)}" required></div>
        <div class="form-group"><label class="form-label" for="report-model">Модель</label><select class="form-input" id="report-model"><option value="">Усі моделі</option>${options(models, filters.model)}</select></div>
        <div class="form-group"><label class="form-label" for="report-party">Контрагент</label><select class="form-input" id="report-party"><option value="">Усі контрагенти</option>${options(parties.map(p => [p,p]), filters.party)}</select></div>
        <div class="form-group"><label class="form-label" for="report-basis">Період за датою</label><select class="form-input" id="report-basis">${options([['posting','Проведення / списання'],['document','Документа']], filters.basis)}</select></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 16px">
        <button class="btn btn-primary" type="submit">Показати звіт</button>
        <button class="btn btn-secondary" type="button" onclick="salesReportPreset('year')">Цей рік</button>
        <button class="btn btn-secondary" type="button" onclick="salesReportPreset('previous')">Минулий рік</button>
        <button class="btn btn-secondary" type="button" onclick="salesReportPreset('month')">Цей місяць</button>
        <button class="btn btn-secondary" type="button" onclick="resetSalesReportFilters()">Скинути</button>
      </div>
    </form>
    <div style="color:var(--text2);font-size:13px">Лише проведені видатки. Межі періоду включено. ${filters.basis === 'document' ? 'Відбір за датою документа, зокрема для історичних продажів без дати списання.' : 'Відбір за датою списання зі складу (часовий пояс Києва).'} Суми розраховано за цінами у видатках.</div>
  </div>
</div>
${error ? `<div role="alert" class="table-container" style="padding:20px;color:var(--red)">${esc(error)}</div>` : `
${report.missingDates ? `<div role="status" class="table-container" style="padding:16px;margin-bottom:20px">Не включено документів без коректної ${filters.basis === 'document' ? 'дати документа' : 'дати списання'}: <b>${report.missingDates}</b> (серед обраних моделей і контрагентів за всі дати). ${filters.basis === 'posting' ? 'Для історичних продажів оберіть «Документа».' : ''}</div>` : ''}
${report.missingQuantities ? `<div role="status">Пропущено рядків без коректної кількості: ${report.missingQuantities}</div>` : ''}
<div class="stats-grid">
  <div class="stat-card green"><div class="label">Продано</div><div class="value" style="font-size:26px">${esc(salesReportUnitSummary(report.units))}</div><div class="sub">за ${esc(filters.from)} — ${esc(filters.to)}</div></div>
  <div class="stat-card blue"><div class="label">Сума продажів</div><div class="value">${formatMoney(report.total)}</div><div class="sub">за цінами видатків</div></div>
  <div class="stat-card"><div class="label">Моделей</div><div class="value">${report.modelCount}</div><div class="sub">у вибірці</div></div>
  <div class="stat-card yellow"><div class="label">Видатків</div><div class="value">${report.documents}</div><div class="sub">проведених документів</div></div>
</div>
<div class="table-container" style="margin-bottom:20px"><div class="table-header"><h3>За моделями</h3><button class="btn btn-secondary" onclick="exportSalesReportCSV()"${report.rows.length ? '' : ' disabled'}>📊 CSV</button></div>
<div style="overflow-x:auto"><table><thead><tr><th>Модель</th><th>Продано</th><th>Видатків</th><th>Сума</th></tr></thead><tbody>
${report.models.map(r => `<tr><td>${esc(r.model)}</td><td>${formatMoney(r.quantity)} ${esc(r.unit)}</td><td>${r.docs.size}</td><td>${formatMoney(r.amount)}</td></tr>`).join('') || empty(4)}
</tbody></table></div></div>
<div class="table-container" style="margin-bottom:20px"><div class="table-header"><h3>За контрагентами</h3></div>
<div style="overflow-x:auto"><table><thead><tr><th>Контрагент</th><th>Продано</th><th>Моделей</th><th>Видатків</th><th>Сума</th></tr></thead><tbody>
${report.parties.map(r => `<tr><td>${esc(r.party)}</td><td>${esc(salesReportUnitSummary(r.units))}</td><td>${r.models.size}</td><td>${r.docs.size}</td><td>${formatMoney(r.amount)}</td></tr>`).join('') || empty(5)}
</tbody></table></div></div>
<details class="table-container"><summary style="padding:20px;cursor:pointer;font-weight:600">Видатки у звіті (${report.rows.length} рядків)</summary>
<div style="overflow-x:auto"><table><thead><tr><th>Дата у звіті</th><th>Документ</th><th>Контрагент</th><th>Модель</th><th>Кількість</th><th>Сума</th></tr></thead><tbody>
${report.rows.map(r => `<tr><td>${esc(r.date)}</td><td>#${esc(r.document)}</td><td>${esc(r.party)}</td><td>${esc(r.model)}</td><td>${formatMoney(r.quantity)} ${esc(r.unit)}</td><td>${formatMoney(r.amount)}</td></tr>`).join('') || empty(6)}
</tbody></table></div></details>`}`;
}
function salesReportCSV(report) {
  const cell = value => '"' + String(value ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""') + '"';
  const rows = [['Дата у звіті','Дата документа','Дата списання','Документ','Контрагент','Модель','Кількість','Одиниця','Сума'],
    ...report.rows.map(r => [r.date,r.documentDate,r.postingDate,r.document,r.party,r.model,String(r.quantity).replace('.',','),r.unit,String(Math.round(r.amount*100)/100).replace('.',',')])];
  return '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n');
}
function exportSalesReportCSV() {
  const filters = currentSalesReportFilters();
  const report = buildSalesReport(state.operations, state.products, filters);
  const url = URL.createObjectURL(new Blob([salesReportCSV(report)], {type:'text/csv;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = `Paolla-продажі-${filters.from}-${filters.to}.csv`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
