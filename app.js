import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getDatabase, ref, get, onValue, update, push, set } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const $ = id => document.getElementById(id);
const aliases = {
  chavalillo: 'chavalillo@repartidores.petsmart.app',
  chavalilla: 'chavalilla@repartidores.petsmart.app'
};
// These settings match the preset currently used by the project. Unsigned images are publicly accessible.
const cloudinaryCloudName = 'decztjlu9';
const cloudinaryUploadPreset = 'petsmart_entregas';
const maxPhotoBytes = 10 * 1024 * 1024;
const maxPhotoCount = 6;
// Página pública original del inventario. Se reutiliza sin copiar ni rediseñar su interfaz.
const clientTrackingBaseUrl = 'https://informespetsmart.github.io/InventarioPetSmart2026/';
const trackingStates = ['Solicitud Recibida', 'Preparando', 'Enviado', 'En ruta', 'En destino', 'Entregado', 'Fotografía'];

let activeUser = null;
let activeDriver = '';
let activeRole = '';
let trackingSnapshots = {};
let stopTracking = null;
let activeTrackingOrder = null;
let activeTrackingSnapshot = null;
let products = {};
let evidence = {};
let stopProducts = null;
let activeScreen = 'list';
let listFilter = 'asignadas';
let dateFilter = 'hoy';
let trackingDateFilter = 'hoy';
let activeOrderId = '';
let selectedFiles = [];
let previewUrls = [];
let evidenceSignature = '';
let loadingEvidence = false;
let toastHandle = null;
let listError = '';


// Logo oficial compartido con el inventario: configuracion/negocio/logoUrl.
// No crea ni reemplaza una imagen de marca; presenta el recurso que ya usa la boleta y el catálogo.
function applyOfficialBusinessLogo(rawUrl, persist = false) {
  const url = typeof rawUrl === 'string' && /^https:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : '';
  const loginImg = $('businessLogoLogin');
  const headerImg = $('businessLogoHeader');
  const loginFallback = $('loginBrandFallback');
  const headerFallback = $('headerBrandFallback');
  const favicon = $('dynamicFavicon');
  if (!url) {
    loginImg?.classList.add('hidden'); headerImg?.classList.add('hidden');
    loginFallback?.classList.remove('hidden'); headerFallback?.classList.remove('hidden');
    if (persist) { try { localStorage.removeItem('petsmart-business-logo-url'); } catch (_) {} }
    return;
  }
  const onLogoError = () => {
    loginImg?.classList.add('hidden'); headerImg?.classList.add('hidden');
    loginFallback?.classList.remove('hidden'); headerFallback?.classList.remove('hidden');
    if (favicon) { favicon.href = './icon-delivery-v15.svg'; favicon.type = 'image/svg+xml'; }
    try { localStorage.removeItem('petsmart-business-logo-url'); } catch (_) {}
  };
  [loginImg, headerImg].filter(Boolean).forEach(img => {
    img.onerror = onLogoError;
    img.onload = () => {
      if (img.id === 'businessLogoLogin') { loginFallback?.classList.add('hidden'); loginImg?.classList.remove('hidden'); }
      if (img.id === 'businessLogoHeader') { headerFallback?.classList.add('hidden'); headerImg?.classList.remove('hidden'); }
    };
    img.src = url;
  });
  // La pestaña del navegador también usa el mismo recurso oficial cuando el origen lo permite.
  if (favicon) { favicon.href = url; favicon.removeAttribute('type'); }
  if (persist) { try { localStorage.setItem('petsmart-business-logo-url', url); } catch (_) {} }
}
function listenForOfficialBusinessLogo() {
  // Mostrar última URL conocida mientras llega la configuración actual de Firebase.
  try { applyOfficialBusinessLogo(localStorage.getItem('petsmart-business-logo-url') || '', false); } catch (_) {}
  onValue(ref(db, 'configuracion/negocio/logoUrl'), snapshot => {
    applyOfficialBusinessLogo(snapshot.val() || '', true);
  }, error => {
    // No se impide el inicio de sesión si las reglas no permiten leer esta ruta.
    console.warn('No se pudo leer el logo oficial desde configuracion/negocio/logoUrl:', error?.code || error?.message || error);
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function normalizeDriver(value) {
  const name = String(value || '').trim().toLowerCase();
  if (name.includes('chavalillo')) return 'Chavalillo';
  if (name.includes('chavalilla')) return 'Chavalilla';
  return '';
}
function normalizeFirebaseKey(value) {
  return String(value || '').replace(/[.#$\[\]/]/g, '_');
}
function limaTodayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function deliveryDateKey(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`;
  const local = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (local) return `${local[3]}-${String(local[2]).padStart(2,'0')}-${String(local[1]).padStart(2,'0')}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed);
}
function isTodayDelivery(order) { return deliveryDateKey(order.fechaEntrega) === limaTodayKey(); }
function fmtDate(value) {
  if (!value) return 'Por coordinar';
  const str = String(value);
  const [y, m, d] = str.split('-').map(Number);
  if (y && m && d) return new Date(y, m - 1, d, 12).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? str : parsed.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
}
function orderStatus(items) {
  // La miniapp solo utiliza dos estados operativos. Los estados históricos
  // (Preparando, En camino, En destino, Incidencia, etc.) se conservan en BD,
  // pero se presentan como Pendiente hasta que todas las líneas estén Entregado.
  const statuses = items.map(p => String(p.entregaEstado || 'Pendiente'));
  return statuses.length && statuses.every(s => s === 'Entregado') ? 'Entregado' : 'Pendiente';
}
function hasDeliveryInfo(product) {
  return !!(
    String(product.envio || '').trim() ||
    String(product.direccionEntrega || '').trim() ||
    String(product.fechaEntrega || '').trim() ||
    String(product.horarioEntrega || '').trim()
  );
}
function deliveryGroupKey(product, productId) {
  const saleGroup = String(product?.ventaGrupoId || '').trim();
  if (saleGroup) return saleGroup;
  const receipt = String(product?.comprobanteNumero || '').trim();
  if (receipt && !['—', '-', 'N/A', 'SIN NÚMERO', 'SIN NUMERO'].includes(receipt.toUpperCase())) {
    return 'comprobante-' + receipt.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
  return String(productId || product?.id || '').trim();
}
function allDeliveryItems() {
  const grouped = new Map();
  Object.entries(products || {}).forEach(([productId, product]) => {
    if (!product || product.estado !== 'vendido') return;
    const groupId = deliveryGroupKey(product, productId);
    if (!groupId) return;
    if (!grouped.has(groupId)) grouped.set(groupId, { id: groupId, items: [], first: product, driver: '', hasDelivery: false });
    const group = grouped.get(groupId);
    group.items.push({ ...product, id: productId });
    if (hasDeliveryInfo(product)) group.hasDelivery = true;
    const assigned = normalizeDriver(product.repartidorAsignado || product.repartidorAsignadoEmail || '');
    if (!group.driver && assigned) group.driver = assigned;
    if (String(product.fechaVenta || '') < String(group.first.fechaVenta || '')) group.first = product;
  });
  return [...grouped.values()].filter(group => group.hasDelivery).map(group => {
    const p = group.first || {};
    const driverItem = group.items.find(item => normalizeDriver(item.repartidorAsignado || item.repartidorAsignadoEmail || ''));
    const driver = normalizeDriver((driverItem && (driverItem.repartidorAsignado || driverItem.repartidorAsignadoEmail)) || group.driver || '');
    return {
      ...group,
      driver,
      status: orderStatus(group.items),
      clienteNombre: p.clienteNombre || 'Cliente sin nombre',
      telefono: p.clienteTelefono || '',
      direccion: p.direccionEntrega || '',
      distrito: p.distrito || '',
      envio: p.envio || '',
      fechaVenta: p.fechaVenta || '',
      fechaEntrega: p.fechaEntrega || '',
      horario: p.horarioEntrega || '',
      pedido: p.comprobanteNumero || '',
      observacion: p.observacion || '',
      productsText: group.items.map(item => `${item.nombre || 'Producto'}${Number(item.cantidad || 1) > 1 ? ` × ${Number(item.cantidad)}` : ''}`).join(', '),
      productCount: group.items.length,
      updatedAt: p.entregaActualizadoEn || '',
      deliveryObservation: p.entregaObservacion || '',
      history: Array.isArray(p.entregaHistorial) ? p.entregaHistorial : []
    };
  }).sort((a, b) => String(a.fechaEntrega || a.fechaVenta || '').localeCompare(String(b.fechaEntrega || b.fechaVenta || '')));
}
function assignedOrders() {
  if (!activeDriver) return [];
  return allDeliveryItems().filter(order => order.driver === activeDriver);
}
function currentOrder() {
  return assignedOrders().find(order => order.id === activeOrderId) || null;
}
function setTheme(theme, persist = true) {
  const mode = theme === 'dark' ? 'dark' : 'light';
  document.body.classList.toggle('theme-dark', mode === 'dark');
  if (persist) {
    try { localStorage.setItem('petsmart-entregas-theme', mode); } catch (_) {}
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = mode === 'dark' ? '#071526' : '#fffaf5';
  $('themeLight')?.classList.toggle('active', mode === 'light');
  $('themeDark')?.classList.toggle('active', mode === 'dark');
  $('loginThemeBtn').textContent = mode === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
}
function getTheme() {
  try { return localStorage.getItem('petsmart-entregas-theme') || 'light'; } catch (_) { return 'light'; }
}
function showToast(message, kind = '', ms = 4200) {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast${kind ? ` ${kind}` : ''}`;
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => toast.classList.add('hidden'), ms);
}
function showLogin(message = '') {
  $('loginScreen').classList.remove('hidden');
  $('appScreen').classList.add('hidden');
  if (message) {
    $('loginMsg').textContent = message;
    $('loginMsg').classList.remove('hidden');
  } else {
    $('loginMsg').classList.add('hidden');
    $('loginMsg').textContent = '';
  }
}
function showApp() {
  $('loginScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  $('helloName').textContent = activeRole === 'admin' ? 'Centro de administración' : `¡Hola, ${activeDriver}!`;
  $('settingName').textContent = activeRole === 'admin' ? 'Administrador' : (activeDriver || 'Repartidor');
  $('settingEmail').textContent = activeUser?.email || '';
  // Las cuentas de repartidor conservan su flujo. Las demás cuentas creadas manualmente
  // en Firebase Authentication se reservan para el administrador (la app no permite registro).
  $('deliveriesNavBtn').classList.toggle('hidden', activeRole === 'admin');
  $('trackingNavBtn').classList.toggle('hidden', activeRole !== 'admin');
}
function showScreen(screen) {
  if (!['list', 'detail', 'photos', 'settings', 'tracking'].includes(screen)) screen = 'list';
  if (activeRole === 'admin' && ['list', 'detail', 'photos'].includes(screen)) screen = 'tracking';
  if (activeRole === 'driver' && screen === 'tracking') screen = 'list';
  activeScreen = screen;
  $('deliveriesView').classList.toggle('hidden', screen !== 'list');
  $('detailView').classList.toggle('hidden', screen !== 'detail');
  $('photosView').classList.toggle('hidden', screen !== 'photos');
  $('settingsView').classList.toggle('hidden', screen !== 'settings');
  $('trackingView').classList.toggle('hidden', screen !== 'tracking');
  const subpage = screen === 'detail' || screen === 'photos';
  $('backBtn').classList.toggle('hidden', !subpage);
  $('headerBrand').classList.toggle('hidden', subpage);
  $('headerTitle').classList.toggle('hidden', !subpage);
  $('headerAction').classList.toggle('hidden', subpage);
  if (screen === 'detail') {
    $('headerTitle').querySelector('strong').textContent = 'Detalle de entrega';
    $('headerSubtitle').textContent = currentOrder()?.pedido ? `Pedido ${currentOrder().pedido}` : 'Información del pedido';
  } else if (screen === 'photos') {
    $('headerTitle').querySelector('strong').textContent = 'Agregar fotos';
    $('headerSubtitle').textContent = 'Evidencia de entrega';
  } else if (screen === 'tracking') {
    $('headerTitle').querySelector('strong').textContent = 'Seguimiento';
    $('headerSubtitle').textContent = 'Administración de pedidos';
  }
  $('bottomNav').classList.toggle('hidden', subpage);
  $('bottomNav').querySelectorAll('[data-screen]').forEach(btn => btn.classList.toggle('active', btn.dataset.screen === screen));
  if (screen === 'list') renderList();
  else if (screen === 'detail') renderDetail();
  else if (screen === 'photos') renderPhotos();
  else if (screen === 'tracking') renderTrackingList();
}
function statusChip(status) {
  const cls = status === 'Entregado' ? 'done' : '';
  return `<span class="status-chip ${cls}">${escapeHtml(status)}</span>`;
}
function imageOrFallback(product, classes = 'product-thumb') {
  if (product?.imagenUrl) return `<img class="${classes}" src="${escapeHtml(product.imagenUrl)}" alt="${escapeHtml(product.nombre || 'Producto')}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling?.classList.remove('hidden')"><span class="${classes} thumb-fallback hidden" aria-hidden="true">${pawIcon()}</span>`;
  return `<span class="${classes} thumb-fallback" aria-hidden="true">${pawIcon()}</span>`;
}
function pawIcon() {
  return '<svg viewBox="0 0 64 64" width="32" height="32" fill="currentColor" aria-hidden="true"><ellipse cx="17" cy="17" rx="7" ry="10" transform="rotate(-30 17 17)"/><ellipse cx="31" cy="10" rx="7" ry="10"/><ellipse cx="47" cy="17" rx="7" ry="10" transform="rotate(30 47 17)"/><path d="M32 29c-8-10-24-7-25 5-1 9 9 9 15 18 5 8 13 8 18 0 6-9 16-9 15-18-1-12-15-15-23-5Z"/></svg>';
}
function renderList() {
  if (!$('orders')) return;
  const orders = assignedOrders();
  const q = $('search').value.trim().toLowerCase();
  const matching = orders.filter(order => [order.clienteNombre, order.telefono, order.direccion, order.distrito, order.pedido, order.productsText, order.id].join(' ').toLowerCase().includes(q));
  const todayOrders = matching.filter(isTodayDelivery);
  const historyOrders = matching.filter(order => !isTodayDelivery(order));
  $('countToday').textContent = todayOrders.length;
  $('countHistory').textContent = historyOrders.length;
  const shown = dateFilter === 'hoy' ? todayOrders : historyOrders;
  $('listCount').textContent = `${shown.length} ${shown.length === 1 ? 'pedido' : 'pedidos'}`;
  $('orders').innerHTML = shown.map(order => {
    const product = order.items[0] || {};
    const reference = order.pedido ? `#${order.pedido}` : `#${order.id.slice(-8).toUpperCase()}`;
    const schedule = [fmtDate(order.fechaEntrega), order.horario].filter((value, index) => value && !(index === 0 && value === 'Por coordinar')).join(' · ');
    return `<button type="button" class="delivery-card" data-open="${escapeHtml(order.id)}" aria-label="Abrir entrega de ${escapeHtml(order.clienteNombre)}">${imageOrFallback(product)}<span class="delivery-main"><span class="delivery-topline"><span class="order-number">${escapeHtml(reference)}</span>${statusChip(order.status)}</span><span class="customer-name">${escapeHtml(order.clienteNombre)}</span><span class="driver-mini"><span class="avatar">${escapeHtml(order.driver.slice(0, 1))}</span><span class="driver-copy"><span class="driver-label">Transportador:</span><strong class="driver-name">${escapeHtml(order.driver)}</strong></span></span><span class="card-meta">${escapeHtml([schedule, order.distrito].filter(Boolean).join(' · ') || 'Entrega por coordinar')}</span><span class="product-summary">${escapeHtml(order.productsText || 'Productos del pedido')}</span></span><span class="chevron" aria-hidden="true">›</span></button>`;
  }).join('');
  $('loadingOrders').classList.add('hidden');
  $('ordersEmpty').classList.toggle('hidden', shown.length > 0);
  $('orders').classList.toggle('hidden', shown.length === 0);
  $('emptyTitle').textContent = dateFilter === 'hoy' ? 'No tienes entregas programadas para hoy' : 'Todavía no hay entregas en el historial';
  $('emptyCopy').textContent = dateFilter === 'hoy' ? 'Aquí aparecerán únicamente los pedidos cuya fecha de entrega corresponde al día de hoy.' : 'Aquí se muestran las entregas de otras fechas y los pedidos sin fecha coordinada.';
  if (listError) {
    $('emptyTitle').textContent = 'No se pudieron cargar los pedidos'; $('emptyCopy').textContent = listError;
    $('ordersEmpty').classList.remove('hidden'); $('orders').classList.add('hidden');
  }
}

function renderDetail() {
  const order = currentOrder();
  if (!order) {
    $('detailView').innerHTML = '<div class="empty-state"><h3>Esta entrega ya no está asignada</h3><p>Actualiza la lista o comunícate con administración.</p></div>';
    return;
  }
  const reference = order.pedido ? `#${order.pedido}` : `#${order.id.slice(-8).toUpperCase()}`;
  const schedule = [fmtDate(order.fechaEntrega), order.horario].filter((v, i) => v && !(i === 0 && v === 'Por coordinar')).join(' · ') || 'Por coordinar';
  const productsHtml = order.items.map(product => `<div class="product-row">${imageOrFallback(product, 'product-thumb')}<span style="min-width:0;flex:1"><strong>${escapeHtml(product.nombre || 'Producto')}</strong><small>${escapeHtml(product.talla ? `Talla: ${product.talla}` : 'Producto del pedido')}</small></span></div>`).join('');
  const nextOptions = ['Pendiente', 'Entregado'].map(status => `<option value="${status}" ${order.status === status ? 'selected' : ''}>${status}</option>`).join('');
  $('detailView').innerHTML = `
    <div class="order-card"><div class="order-id-row"><span class="order-code">Pedido ${escapeHtml(reference)}</span>${statusChip(order.status)}</div>
      <div class="detail-person"><span class="avatar" style="width:30px;height:30px">${escapeHtml(order.clienteNombre.trim().slice(0,1).toUpperCase() || 'C')}</span><span>${escapeHtml(order.clienteNombre)}</span></div>
      <div class="detail-line"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12Z"/><circle cx="12" cy="9" r="2.3"/></svg><span>${escapeHtml([order.direccion, order.distrito].filter(Boolean).join(', ') || 'Sin dirección registrada')}</span></div>
      <div class="detail-line"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>${escapeHtml(schedule)}</span></div>
      ${order.envio ? `<div class="detail-line"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"/><circle cx="7.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/></svg><span>${escapeHtml(order.envio)}</span></div>` : ''}
    </div>
    <div class="mini-section-title">Repartidor asignado</div><div class="assigned-driver"><span class="avatar" style="width:38px;height:38px;font-size:12px">${escapeHtml(order.driver.slice(0,1))}</span><span style="flex:1"><strong>${escapeHtml(order.driver)}</strong><small>Esta entrega está asignada a tu cuenta</small></span></div>
    <div class="mini-section-title">Productos (${order.items.length})</div><div class="section-card" style="padding:8px 13px">${productsHtml || '<p class="small-note">No se encontraron productos.</p>'}</div>
    <div class="mini-section-title">Cliente</div><div class="section-card"><div class="detail-person" style="margin-top:0"><span>${escapeHtml(order.clienteNombre)}</span></div><div class="detail-line"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z"/></svg><span>${escapeHtml(order.telefono || 'Teléfono no registrado')}</span></div>${order.observacion ? `<div class="detail-line"><span>Referencia: ${escapeHtml(order.observacion)}</span></div>` : ''}</div>
    <div class="mini-section-title">Observación</div><div class="section-card"><label for="deliveryObservation" class="small-note" style="display:block;margin-bottom:7px">Anota información importante sobre esta entrega. La observación no cambia el estado del pedido.</label><textarea id="deliveryObservation" class="field-input" rows="3" maxlength="500" placeholder="Escribe una observación (opcional)…">${escapeHtml(order.deliveryObservation || '')}</textarea><button id="saveObservationBtn" class="secondary" type="button" style="width:100%;margin-top:9px">Guardar observación</button></div>
    <div class="section-card"><label for="detailStatus" style="display:block;font-size:11px;font-weight:900;margin-bottom:7px">Actualizar estado de entrega</label><select id="detailStatus" class="field-input">${nextOptions}</select><p class="small-note" style="margin:8px 0 0">Solo puedes seleccionar Pendiente o Entregado. El estado se sincroniza en las líneas de la venta.</p></div>
    <div class="detail-actions"><button class="primary" data-open-photos="${escapeHtml(order.id)}" type="button">${cameraIcon()} Ver fotos de entrega</button>${order.status !== 'Entregado' ? `<button class="secondary" data-delivered="${escapeHtml(order.id)}" type="button">Marcar como entregado</button>` : `<div class="status-chip done" style="justify-content:center;padding:10px">Pedido entregado</div>`}</div>`;
  $('detailView').querySelector('#detailStatus')?.addEventListener('change', async event => {
    const next = event.target.value;
    if (next !== order.status) await updateOrderStatus(order, next);
  });
  $('detailView').querySelector('#saveObservationBtn')?.addEventListener('click', async () => {
    const value = $('deliveryObservation')?.value.trim() || '';
    await saveDeliveryObservation(order, value);
  });
  $('detailView').querySelector('[data-open-photos]')?.addEventListener('click', () => {
    activeOrderId = order.id;
    selectedFiles = [];
    previewUrls.forEach(url => URL.revokeObjectURL(url)); previewUrls = [];
    showScreen('photos');
  });
  $('detailView').querySelector('[data-delivered]')?.addEventListener('click', async () => {
    if (confirm(`¿Marcar el pedido ${reference} como entregado?`)) await updateOrderStatus(order, 'Entregado');
  });
}
function cameraIcon() {
  return '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h3l2-3h6l2 3h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/></svg>';
}
function photoArray(groupId) {
  const value = evidence[normalizeFirebaseKey(groupId)] || evidence[groupId] || {};
  const entries = Array.isArray(value)
    ? value.map((photo, index) => [String(index), photo])
    : Object.entries(value || {});
  return entries.map(([key, photo]) => ({ ...photo, id: photo?.id || key }))
    .filter(photo => photo && photo.secureUrl)
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
}
function renderPhotos() {
  const order = currentOrder();
  if (!order) {
    $('photosView').innerHTML = '<div class="empty-state"><h3>Esta entrega ya no está asignada</h3><p>Regresa a la lista para ver tus pedidos actuales.</p></div>';
    return;
  }
  const existing = photoArray(order.id);
  const existingHtml = existing.map(photo => `<div class="photo-tile saved-photo-tile"><a class="saved-photo-open" href="${escapeHtml(photo.secureUrl)}" target="_blank" rel="noopener" aria-label="Abrir foto ${escapeHtml(photo.fileName || '')}"><img src="${escapeHtml(photo.secureUrl)}" alt="Evidencia guardada" loading="lazy"></a><span class="saved-photo-name">${escapeHtml(photo.fileName || 'Foto guardada')}</span></div>`).join('');
  const previews = selectedFiles.map((file, index) => `<div class="photo-tile"><img src="${escapeHtml(previewUrls[index] || '')}" alt="Foto nueva seleccionada"><button class="remove-preview" type="button" data-remove-file="${index}" aria-label="Quitar imagen">×</button></div>`).join('');
  const canAdd = selectedFiles.length + existing.length < maxPhotoCount;
  $('photosView').innerHTML = `<div class="order-card"><div class="order-id-row"><strong class="order-code">Pedido ${escapeHtml(order.pedido || order.id.slice(-8).toUpperCase())}</strong>${statusChip(order.status)}</div><div class="detail-person"><span class="avatar">${escapeHtml(order.clienteNombre.slice(0,1).toUpperCase())}</span>${escapeHtml(order.clienteNombre)}</div></div>
    <div class="photo-intro"><span style="color:var(--blue);margin-top:1px">${cameraIcon()}</span><div><strong>Toma las fotos de la entrega</strong><p>Asegúrate de que la imagen sea clara y muestre la evidencia necesaria. Puedes tomar una fotografía o elegirla desde la galería. Máximo ${maxPhotoCount} imágenes por pedido.</p></div></div>
    ${existing.length ? `<div class="mini-section-title">Fotos guardadas (${existing.length})</div><div class="photo-grid">${existingHtml}</div>` : '<p class="small-note" style="margin:15px 2px">Todavía no hay fotos registradas en este pedido.</p>'}
    <div class="mini-section-title">${selectedFiles.length ? `Fotos nuevas (${selectedFiles.length})` : 'Agregar fotografías'}</div>
    <div class="photo-grid">${previews}</div>
    ${canAdd ? `<div class="photo-source-grid">
      <button class="photo-source-button" id="takePhotoBtn" type="button"><span class="photo-source-icon">${cameraIcon()}</span><strong>Tomar fotografía</strong><small>Abrir la cámara del dispositivo</small></button>
      <button class="photo-source-button" id="chooseGalleryBtn" type="button"><span class="photo-source-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg></span><strong>Elegir de galería</strong><small>Seleccionar fotos guardadas en el teléfono</small></button>
      <input id="cameraPhotoInput" class="hidden" type="file" accept="image/*" capture="environment" multiple>
      <input id="galleryPhotoInput" class="hidden" type="file" accept="image/*" multiple>
    </div>` : ''}
    <div id="photoMsg" class="small-note" style="margin-top:12px" role="status" aria-live="polite"></div>
    <div class="photo-footer" style="position:sticky;bottom:calc(72px + env(safe-area-inset-bottom));padding:12px 0 4px;background:var(--bg)"><button id="uploadPhotosBtn" class="primary" type="button" ${selectedFiles.length ? '' : 'disabled'}>Guardar evidencia (${selectedFiles.length})</button><button id="backToDetail" class="secondary" style="width:100%;margin-top:8px" type="button">Volver al pedido</button></div>
    <p class="small-note" style="margin-top:9px">Las cargas de Cloudinary configuradas actualmente usan un preset sin firma. Este enlace puede ser público; utiliza solo imágenes de prueba hasta implementar carga privada.</p>`;
  // La cámara y la galería usan el mismo proceso de validación y carga.
  $('photosView').querySelector('#takePhotoBtn')?.addEventListener('click', () => $('cameraPhotoInput')?.click());
  $('photosView').querySelector('#chooseGalleryBtn')?.addEventListener('click', () => $('galleryPhotoInput')?.click());
  const handlePhotoSelection = event => {
    const incoming = [...(event.target.files || [])];
    event.target.value = '';
    if (!incoming.length) return;
    const orderNow = currentOrder();
    const alreadySaved = orderNow ? photoArray(orderNow.id).length : 0;
    const available = Math.max(0, maxPhotoCount - alreadySaved - selectedFiles.length);
    const notices = [];
    if (!available) {
      $('photoMsg').textContent = `Este pedido ya alcanzó el máximo de ${maxPhotoCount} fotografías.`;
      return;
    }
    const accepted = [];
    for (const file of incoming) {
      if (!file.type || !file.type.startsWith('image/')) {
        notices.push(`${file.name}: formato de imagen no válido.`);
        continue;
      }
      if (file.size > maxPhotoBytes) {
        notices.push(`${file.name}: supera el límite de 10 MB.`);
        continue;
      }
      if (accepted.length >= available) {
        notices.push(`Solo puedes agregar ${available} foto(s) más a este pedido.`);
        break;
      }
      accepted.push(file);
    }
    accepted.forEach(file => { selectedFiles.push(file); previewUrls.push(URL.createObjectURL(file)); });
    renderPhotos();
    if (notices.length) {
      $('photoMsg').textContent = notices.join(' ');
      $('photoMsg').classList.add('danger');
    } else if (accepted.length) {
      $('photoMsg').textContent = `${accepted.length} fotografía(s) seleccionada(s).`;
    }
  };
  $('photosView').querySelector('#cameraPhotoInput')?.addEventListener('change', handlePhotoSelection);
  $('photosView').querySelector('#galleryPhotoInput')?.addEventListener('change', handlePhotoSelection);
  $('photosView').querySelectorAll('[data-remove-file]').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.removeFile);
    if (previewUrls[index]) URL.revokeObjectURL(previewUrls[index]);
    selectedFiles.splice(index, 1); previewUrls.splice(index, 1); renderPhotos();
  }));
  $('photosView').querySelector('#uploadPhotosBtn')?.addEventListener('click', uploadPhotos);
  $('photosView').querySelector('#backToDetail')?.addEventListener('click', () => showScreen('detail'));
}
async function updateOrderStatus(order, newStatus) {
  const valid = ['Pendiente', 'Entregado'];
  if (!valid.includes(newStatus) || !order) return;
  const now = new Date().toISOString();
  const first = order.items[0] || {};
  const history = Array.isArray(first.entregaHistorial) ? first.entregaHistorial.slice() : [];
  if (String(order.status) !== newStatus) history.push({ estado: newStatus, fecha: now, nota: '' });
  const updates = {};
  order.items.forEach(product => {
    updates[`productos/${product.id}/entregaEstado`] = newStatus;
    updates[`productos/${product.id}/entregaActualizadoEn`] = now;
    updates[`productos/${product.id}/entregaHistorial`] = history;
    // Mantener el registro de venta complementario alineado con el mismo pedido.
    updates[`ventas/${product.id}/entregaEstado`] = newStatus;
    updates[`ventas/${product.id}/entregaActualizadoEn`] = now;
    updates[`ventas/${product.id}/entregaHistorial`] = history;
  });
  try {
    await update(ref(db), updates);
    showToast(`Estado actualizado: ${newStatus}.`, 'success');
    await refreshProductsOnce();
  } catch (error) {
    console.error('No se pudo actualizar el estado:', error);
    showToast('No se pudo guardar el estado. Revisa los permisos de Firebase.', 'error', 6000);
    renderDetail();
  }
}
async function saveDeliveryObservation(order, observation) {
  if (!order) return;
  const now = new Date().toISOString();
  const first = order.items[0] || {};
  const history = Array.isArray(first.entregaHistorial) ? first.entregaHistorial.slice() : [];
  history.push({ estado: order.status, fecha: now, nota: observation ? `Observación: ${observation}` : 'Observación eliminada' });
  const updates = {};
  order.items.forEach(product => {
    updates[`productos/${product.id}/entregaObservacion`] = observation;
    updates[`productos/${product.id}/entregaObservacionActualizadoEn`] = now;
    updates[`productos/${product.id}/entregaHistorial`] = history;
    updates[`ventas/${product.id}/entregaObservacion`] = observation;
    updates[`ventas/${product.id}/entregaObservacionActualizadoEn`] = now;
    updates[`ventas/${product.id}/entregaHistorial`] = history;
  });
  const button = $('saveObservationBtn');
  if (button) { button.disabled = true; button.textContent = 'Guardando…'; }
  try {
    await update(ref(db), updates);
    showToast(observation ? 'Observación guardada.' : 'Observación eliminada.', 'success');
    await refreshProductsOnce();
  } catch (error) {
    console.error('No se pudo guardar la observación:', error);
    showToast('No se pudo guardar la observación. Revisa los permisos de Firebase.', 'error', 6000);
    if (button) { button.disabled = false; button.textContent = 'Guardar observación'; }
  }
}
async function refreshProductsOnce() {
  try {
    const snapshot = await get(ref(db, 'productos'));
    products = snapshot.exists() ? snapshot.val() : {};
    await loadEvidenceForAssignedGroups(true);
    renderList();
    if (activeScreen === 'detail') renderDetail();
  } catch (error) { console.warn('No se pudo refrescar manualmente el listado:', error); }
}
async function loadEvidenceForAssignedGroups(force = false) {
  if (!activeDriver || loadingEvidence) return;
  const orders = assignedOrders();
  const signature = orders.map(order => order.id).sort().join('|');
  if (!force && signature === evidenceSignature) return;
  loadingEvidence = true;
  evidenceSignature = signature;
  const nextEvidence = {};
  try {
    await Promise.all(orders.map(async order => {
      try {
        const key = normalizeFirebaseKey(order.id);
        const snapshot = await get(ref(db, `entregasEvidencias/${key}`));
        nextEvidence[key] = snapshot.exists() ? snapshot.val() : {};
      } catch (error) {
        console.warn('No se pudo leer evidencia del pedido asignado', order.id, error);
        nextEvidence[normalizeFirebaseKey(order.id)] = {};
      }
    }));
    evidence = nextEvidence;
    if (activeScreen === 'photos') renderPhotos();
  } finally {
    loadingEvidence = false;
  }
}
function askPhotoUploadConfirmation(order, files) {
  const dialog = $('uploadConfirmDialog');
  const details = $('uploadConfirmDetails');
  if (!dialog || !details || typeof dialog.showModal !== 'function') {
    const names = files.map(file => `• ${file.name}`).join('\n');
    return Promise.resolve(window.confirm(
      `Vas a subir ${files.length} fotografía(s) al pedido ${order.pedido || order.id.slice(-8).toUpperCase()}.\n\n${names}\n\nUna vez cargadas, no podrás eliminarlas desde la app. ¿Confirmas la carga?`
    ));
  }
  const orderLabel = order.pedido || order.id.slice(-8).toUpperCase();
  const rows = files.map((file, index) => {
    const preview = previewUrls[index] || '';
    const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
    return `<li class="upload-confirm-file"><img src="${escapeHtml(preview)}" alt="Vista previa ${index + 1}"><span><strong>${escapeHtml(file.name)}</strong><small>${sizeMb} MB · ${escapeHtml(file.type || 'Imagen')}</small></span></li>`;
  }).join('');
  details.innerHTML = `<div class="upload-confirm-order"><span>Pedido</span><strong>${escapeHtml(orderLabel)}</strong></div><div class="upload-confirm-total"><strong>${files.length}</strong><span>${files.length === 1 ? 'fotografía seleccionada' : 'fotografías seleccionadas'}</span></div><ul class="upload-confirm-files">${rows}</ul>`;
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

async function uploadPhotos() {
  const order = currentOrder();
  const target = $('photoMsg');
  if (!order) { showToast('La entrega ya no está asignada a tu cuenta.', 'error'); showScreen('list'); return; }
  if (!selectedFiles.length) { target.textContent = 'Selecciona al menos una fotografía.'; return; }
  if (selectedFiles.length + photoArray(order.id).length > maxPhotoCount) { target.textContent = `Este pedido ya tiene fotos. El máximo permitido por pedido es ${maxPhotoCount}.`; return; }
  let button = $('uploadPhotosBtn');
  if (!button || button.dataset.busy === '1') return;
  button.dataset.busy = '1';
  button.disabled = true;
  button.textContent = 'Esperando confirmación…';
  let confirmed = false;
  try {
    confirmed = await askPhotoUploadConfirmation(order, selectedFiles);
  } catch (confirmationError) {
    console.error('No se pudo mostrar la confirmación de fotografías:', confirmationError);
    confirmed = window.confirm(`¿Confirmas subir ${selectedFiles.length} fotografía(s) a este pedido?`);
  }
  button = $('uploadPhotosBtn') || button; // La lista puede haberse vuelto a dibujar mientras se mostraba el diálogo.
  if (!confirmed) {
    button.dataset.busy = '';
    button.disabled = selectedFiles.length === 0;
    button.textContent = `Guardar evidencia (${selectedFiles.length})`;
    showToast('Carga cancelada. No se subió ninguna fotografía.');
    return;
  }
  const current = currentOrder();
  if (!current || current.id !== order.id) {
    button.dataset.busy = '';
    button.disabled = selectedFiles.length === 0;
    button.textContent = `Guardar evidencia (${selectedFiles.length})`;
    showToast('El pedido ya no está asignado a tu cuenta. No se subieron las fotos.', 'error', 6000);
    showScreen('list');
    return;
  }
  button.textContent = 'Subiendo evidencia…';
  let cloudinaryCount = 0, firebaseCount = 0;
  const key = normalizeFirebaseKey(order.id);
  try {
    for (const file of selectedFiles) {
      const metadataRef = push(ref(db, `entregasEvidencias/${key}`));
      const evidenceId = metadataRef.key;
      const formData = new FormData();
      formData.append('file', file);
      formData.append('upload_preset', cloudinaryUploadPreset);
      formData.append('folder', `PetSmart2026/Entregas/${key}`);
      formData.append('context', `ventaGrupoId=${key}|uploadedBy=${activeDriver}`);
      const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/image/upload`, { method: 'POST', body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.secure_url) throw new Error(data?.error?.message || `Cloudinary respondió HTTP ${response.status}.`);
      cloudinaryCount++;
      const metadata = {
        id: evidenceId,
        ventaGrupoId: key,
        cloudinaryPublicId: data.public_id || '',
        secureUrl: data.secure_url,
        fileName: file.name,
        contentType: file.type,
        size: file.size,
        uploadedBy: activeDriver,
        uploadedAt: new Date().toISOString(),
        storageProvider: 'cloudinary'
      };
      try {
        await set(metadataRef, metadata);
        firebaseCount++;
      } catch (dbError) {
        throw new Error(`La foto ${file.name} llegó a Cloudinary, pero Firebase rechazó guardar su registro (${dbError.code || dbError.message || 'error de permisos'}). No repitas la carga sin verificar la carpeta de Cloudinary.`);
      }
    }
    selectedFiles = [];
    previewUrls.forEach(url => URL.revokeObjectURL(url)); previewUrls = [];
    await loadEvidenceForAssignedGroups(true);
    showToast(`Listo: ${firebaseCount} foto(s) registradas.`, 'success');
    renderPhotos();
  } catch (error) {
    console.error('Resultado de carga de evidencia:', { cloudinaryCount, firebaseCount, error });
    target.textContent = cloudinaryCount > firebaseCount
      ? `Carga parcial: ${cloudinaryCount} foto(s) llegaron a Cloudinary y ${firebaseCount} registro(s) se guardaron. ${error.message || ''} No repitas la carga sin revisar primero Cloudinary.`
      : (error.message || 'No se pudo completar la carga.');
    target.classList.add('danger');
  } finally {
    const currentButton = $('uploadPhotosBtn');
    if (currentButton) { currentButton.dataset.busy = ''; currentButton.disabled = selectedFiles.length === 0; currentButton.textContent = `Guardar evidencia (${selectedFiles.length})`; }
  }
}

function normalizeTrackingStatus(value) {
  const status = String(value || 'Solicitud Recibida').trim();
  if (status === 'En camino') return 'En ruta';
  if (status === 'Recibido') return 'Solicitud Recibida';
  return trackingStates.includes(status) ? status : 'Solicitud Recibida';
}
function getTrackingSnapshotForOrder(order) {
  if (!order) return null;
  const match = Object.entries(trackingSnapshots || {}).find(([token, snapshot]) => snapshot && String(snapshot.ventaGrupoId || '') === String(order.id));
  return match ? { token: match[0], ...match[1] } : null;
}
function getTrackingStatusForOrder(order) {
  const snapshot = getTrackingSnapshotForOrder(order);
  if (snapshot) return normalizeTrackingStatus(snapshot.estado);
  const productStatus = order?.items?.find(item => item.estadoEnvio)?.estadoEnvio;
  return productStatus ? normalizeTrackingStatus(productStatus) : '';
}
function renderTrackingList() {
  const host = $('trackingOrders');
  if (!host || activeRole !== 'admin') return;
  const all = allDeliveryItems();
  const q = ($('trackingSearch')?.value || '').trim().toLowerCase();
  const matching = all.filter(order => [order.clienteNombre, order.telefono, order.direccion, order.distrito, order.pedido, order.productsText, order.id].join(' ').toLowerCase().includes(q));
  const todayOrders = matching.filter(isTodayDelivery);
  const historyOrders = matching.filter(order => !isTodayDelivery(order));
  $('trackingTodayCount').textContent = todayOrders.length;
  $('trackingHistoryCount').textContent = historyOrders.length;
  const orders = trackingDateFilter === 'hoy' ? todayOrders : historyOrders;
  $('trackingCount').textContent = `${orders.length} ${orders.length === 1 ? 'pedido' : 'pedidos'}`;
  host.innerHTML = orders.map(order => {
    const snapshot = getTrackingSnapshotForOrder(order);
    const status = getTrackingStatusForOrder(order);
    const stateLabel = status || 'Sin seguimiento';
    const stateClass = status === 'Entregado' ? 'done' : (status ? '' : 'none');
    const ref = order.pedido ? `#${order.pedido}` : `#${String(order.id).slice(-8).toUpperCase()}`;
    const meta = [order.distrito, fmtDate(order.fechaEntrega), order.horario].filter(Boolean).join(' · ');
    return `<article class="tracking-card"><div class="tracking-card-main"><div class="tracking-card-top"><span class="tracking-card-ref">${escapeHtml(ref)}</span><span class="tracking-state ${stateClass}">${escapeHtml(stateLabel)}</span></div><strong class="tracking-customer">${escapeHtml(order.clienteNombre)}</strong><span class="tracking-meta">${escapeHtml(meta || 'Entrega por coordinar')}${order.telefono ? ` · ${escapeHtml(order.telefono)}` : ''}</span><span class="tracking-products">${escapeHtml(order.productsText || 'Productos del pedido')}</span></div><button type="button" class="tracking-open" data-tracking-open="${escapeHtml(order.id)}">${snapshot ? 'Administrar' : 'Activar enlace'}</button></article>`;
  }).join('');
  $('trackingLoading').classList.add('hidden');
  $('trackingEmpty').classList.toggle('hidden', orders.length > 0);
  if (!orders.length) {
    $('trackingEmptyTitle').textContent = q ? 'No encontramos pedidos' : (trackingDateFilter === 'hoy' ? 'No hay entregas para hoy' : 'El historial está vacío');
    $('trackingEmptyCopy').textContent = q ? 'Prueba con otro cliente, número de pedido o distrito.' : 'Los pedidos de otras fechas se conservan en el historial.';
  }
}

function trackingClientUrl(token) {
  return `${clientTrackingBaseUrl}?seguimiento=${encodeURIComponent(token)}`;
}
function renderTrackingDialog() {
  if (!activeTrackingOrder || !activeTrackingSnapshot) return;
  const order = activeTrackingOrder;
  const snapshot = activeTrackingSnapshot;
  const status = normalizeTrackingStatus(snapshot.estado);
  $('trackingDialogTitle').textContent = order.pedido ? `Pedido #${order.pedido}` : 'Seguimiento del pedido';
  $('trackingDialogSubtitle').textContent = `${order.clienteNombre || 'Cliente'} · ${status}`;
  const details = [
    ['Cliente', order.clienteNombre || '—'],
    ['Teléfono', order.telefono || '—'],
    ['Distrito', order.distrito || '—'],
    ['Dirección', order.direccion || '—'],
    ['Fecha de entrega', fmtDate(order.fechaEntrega)],
    ['Horario', order.horario || 'Por coordinar']
  ];
  $('trackingDialogDetails').innerHTML = details.map(([label, value]) => `<div class="tracking-detail-cell"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('trackingStatusGrid').innerHTML = trackingStates.map(state => `<button type="button" class="tracking-state-button ${state === status ? 'active' : ''}" data-tracking-state="${escapeHtml(state)}">${state === status ? '✓ ' : ''}${escapeHtml(state)}</button>`).join('');
  const url = trackingClientUrl(snapshot.token);
  $('trackingClientFrame').src = url;
  $('trackingAdminDialog').classList.remove('hidden');
}
async function openTrackingManager(groupId) {
  if (activeRole !== 'admin') return;
  const order = allDeliveryItems().find(item => String(item.id) === String(groupId));
  if (!order) { showToast('No se encontró el pedido seleccionado.'); return; }
  const firstWithGroup = order.items.find(item => String(item.ventaGrupoId || '').trim());
  const saleGroup = String(firstWithGroup?.ventaGrupoId || '').trim();
  if (!saleGroup) {
    showToast('Este pedido antiguo no tiene ventaGrupoId. No se generó un enlace para evitar asociarlo a otra venta.', 'error', 6500);
    return;
  }
  try {
    let snapshot = getTrackingSnapshotForOrder(order);
    let token = snapshot?.token || '';
    // Si un producto conserva un token antiguo que no apunta al mismo grupo, no se reutiliza.
    if (snapshot && String(snapshot.ventaGrupoId || '') !== saleGroup) { snapshot = null; token = ''; }
    if (!snapshot) {
      const now = new Date().toISOString();
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      do {
        token = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      } while (trackingSnapshots[token]);
      snapshot = {
        token,
        ventaGrupoId: saleGroup,
        pedidoNumero: String(order.pedido || firstWithGroup.comprobanteNumero || ''),
        clienteNombre: String(order.clienteNombre || ''),
        clienteTelefono: String(order.telefono || ''),
        direccion: String(order.direccion || ''),
        distrito: String(order.distrito || ''),
        fechaEntrega: String(order.fechaEntrega || ''),
        horarioEntrega: String(order.horario || ''),
        estado: 'Solicitud Recibida',
        creadoEn: firstWithGroup.fechaVenta || now,
        actualizadoEn: now,
        historial: [{ estado: 'Solicitud Recibida', fecha: firstWithGroup.fechaVenta || now }],
        items: order.items.map(item => ({ nombre: item.nombre || '', cantidad: Number(item.cantidad) || 1, imagenUrl: item.imagenUrl || '' }))
      };
      await set(ref(db, `ventas/_seguimientoPublico/${token}`), snapshot);
      trackingSnapshots[token] = snapshot;
    }
    const updates = {};
    order.items.forEach(item => {
      if (!item.id) return;
      updates[`productos/${item.id}/seguimientoToken`] = token;
      updates[`productos/${item.id}/estadoEnvio`] = normalizeTrackingStatus(snapshot.estado);
    });
    if (Object.keys(updates).length) await update(ref(db), updates);
    activeTrackingOrder = order;
    activeTrackingSnapshot = { ...snapshot, token };
    $('trackingAdminDialog').classList.remove('hidden');
    renderTrackingDialog();
  } catch (error) {
    console.error('No se pudo preparar el seguimiento:', error);
    showToast(`No se pudo preparar el seguimiento: ${error?.message || 'revisa las reglas de Firebase'}`, 'error', 6500);
  }
}
async function updateTrackingStatusFromMiniapp(status) {
  if (activeRole !== 'admin' || !activeTrackingOrder || !activeTrackingSnapshot || !trackingStates.includes(status)) return;
  const snapshot = activeTrackingSnapshot;
  const now = new Date().toISOString();
  try {
    const updates = {};
    activeTrackingOrder.items.forEach(item => {
      if (!item.id) return;
      updates[`productos/${item.id}/estadoEnvio`] = status;
      updates[`productos/${item.id}/seguimientoToken`] = snapshot.token;
    });
    if (Object.keys(updates).length) await update(ref(db), updates);
    const history = Array.isArray(snapshot.historial) ? snapshot.historial.slice() : [];
    if (normalizeTrackingStatus(snapshot.estado) !== status) history.push({ estado: status, fecha: now });
    const next = { ...snapshot, estado: status, actualizadoEn: now, historial: history };
    await set(ref(db, `ventas/_seguimientoPublico/${snapshot.token}`), next);
    activeTrackingSnapshot = next;
    trackingSnapshots[snapshot.token] = next;
    renderTrackingDialog();
    renderTrackingList();
    showToast(`Seguimiento actualizado: ${status}`, 'success');
  } catch (error) {
    console.error('No se pudo actualizar el estado del seguimiento:', error);
    showToast(`No se pudo actualizar: ${error?.message || 'revisa las reglas de Firebase'}`, 'error', 6500);
  }
}
async function copyClientTrackingLink() {
  if (!activeTrackingSnapshot?.token) return;
  const url = trackingClientUrl(activeTrackingSnapshot.token);
  try {
    await navigator.clipboard.writeText(url);
    showToast('Enlace de seguimiento copiado.', 'success');
  } catch (error) {
    showToast('No se pudo copiar automáticamente. Usa «Abrir vista del cliente» para copiar la dirección desde el navegador.', 'error', 6000);
  }
}
function closeTrackingManager() {
  $('trackingAdminDialog').classList.add('hidden');
  $('trackingClientFrame').src = 'about:blank';
  activeTrackingOrder = null;
  activeTrackingSnapshot = null;
}
function startTrackingListener() {
  if (Array.isArray(stopTracking)) stopTracking.forEach(unsubscribe => { try { unsubscribe(); } catch (_) {} });
  else if (typeof stopTracking === 'function') stopTracking();
  stopTracking = [];
  if (activeRole !== 'admin') return;
  const tokens = [...new Set(Object.values(products || {}).map(item => String(item?.seguimientoToken || '').trim()).filter(Boolean))];
  trackingSnapshots = {};
  if (!tokens.length) {
    $('trackingLoading')?.classList.add('hidden');
    renderTrackingList();
    return;
  }
  $('trackingLoading')?.classList.remove('hidden');
  let loaded = 0;
  const markLoaded = () => {
    loaded += 1;
    if (loaded >= tokens.length) $('trackingLoading')?.classList.add('hidden');
  };
  tokens.forEach(token => {
    const unsubscribe = onValue(ref(db, `ventas/_seguimientoPublico/${token}`), snapshot => {
      if (snapshot.exists()) trackingSnapshots[token] = snapshot.val() || {};
      else delete trackingSnapshots[token];
      renderTrackingList();
      if (activeTrackingSnapshot?.token === token && snapshot.exists()) {
        activeTrackingSnapshot = { ...snapshot.val(), token };
        $('trackingDialogSubtitle').textContent = `${activeTrackingOrder?.clienteNombre || 'Cliente'} · ${normalizeTrackingStatus(activeTrackingSnapshot.estado)}`;
        $('trackingStatusGrid').innerHTML = trackingStates.map(state => `<button type="button" class="tracking-state-button ${state === normalizeTrackingStatus(activeTrackingSnapshot.estado) ? 'active' : ''}" data-tracking-state="${escapeHtml(state)}">${state === normalizeTrackingStatus(activeTrackingSnapshot.estado) ? '✓ ' : ''}${escapeHtml(state)}</button>`).join('');
      }
      markLoaded();
    }, error => {
      console.error(`No se pudo leer ventas/_seguimientoPublico/${token}:`, error);
      markLoaded();
    });
    stopTracking.push(unsubscribe);
  });
}
function startProductListener() {
  if (stopProducts) stopProducts();
  listError = '';
  $('loadingOrders').classList.remove('hidden');
  $('ordersEmpty').classList.add('hidden');
  stopProducts = onValue(ref(db, 'productos'), snapshot => {
    products = snapshot.exists() ? snapshot.val() : {};
    listError = '';
    if (activeRole === 'admin') startTrackingListener();
    $('loadingOrders').classList.add('hidden');
    renderList();
    if (activeRole === 'admin' && activeScreen === 'tracking') renderTrackingList();
    const visible = currentOrder();
    if (activeScreen === 'detail') {
      if (!visible) { showScreen('list'); showToast('Esta entrega ya no está asignada a tu cuenta.'); }
      else renderDetail();
    } else if (activeScreen === 'photos') {
      if (!visible) { showScreen('list'); showToast('Esta entrega ya no está asignada a tu cuenta.'); }
    }
    void loadEvidenceForAssignedGroups(false);
  }, error => {
    console.error('No se pudieron cargar los pedidos:', error);
    listError = 'Firebase no permitió leer el listado de ventas. Revisa la configuración y las reglas de Realtime Database.';
    $('loadingOrders').classList.add('hidden');
    renderList();
    if (activeRole === 'admin') {
      $('trackingLoading')?.classList.add('hidden');
      $('trackingEmptyTitle').textContent = 'No se pudieron cargar los pedidos';
      $('trackingEmptyCopy').textContent = 'Firebase no permitió leer productos. Revisa las reglas de Realtime Database.';
      $('trackingEmpty').classList.remove('hidden');
    }
  });
}
function authErrorMessage(error) {
  const messages = {
    'auth/invalid-credential': 'Usuario o contraseña incorrectos.',
    'auth/wrong-password': 'La contraseña es incorrecta.',
    'auth/user-not-found': 'Esta cuenta no existe en Firebase Authentication.',
    'auth/invalid-email': 'El correo configurado para este usuario no es válido.',
    'auth/too-many-requests': 'Hubo demasiados intentos. Espera unos minutos e inténtalo otra vez.',
    'auth/network-request-failed': 'No se pudo conectar con Firebase. Comprueba tu conexión.',
    'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase Authentication. Añádelo en Authorized domains.',
    'auth/operation-not-allowed': 'Firebase Authentication no tiene habilitado el proveedor Email/Password.',
    'auth/api-key-not-valid': 'Firebase rechazó la clave API configurada. Comprueba que firebase-config.js use la clave web del proyecto petsmart-inventario y que sus restricciones permitan este dominio y la API de Identity Toolkit.'
  };
  return messages[error?.code] || `No se pudo iniciar sesión (${error?.code || 'error'}). Comprueba la cuenta y la configuración de Firebase.`;
}
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const username = $('username').value.trim().toLowerCase();
  const password = $('password').value;
  const alias = username.includes('@') ? Object.keys(aliases).find(key => aliases[key] === username) : username;
  const email = aliases[alias] || (username.includes('@') ? username : '');
  if (!email) { showLogin('Escribe Chavalillo, Chavalilla o el correo de tu cuenta administradora.'); return; }
  const button = $('loginBtn');
  button.disabled = true; button.textContent = 'Ingresando…';
  try {
    await signInWithEmailAndPassword(auth, email, password);
    $('password').value = '';
  } catch (error) {
    console.error('No se pudo iniciar sesión:', error);
    showLogin(authErrorMessage(error));
  } finally {
    button.disabled = false; button.textContent = 'Iniciar sesión';
  }
});
$('trackingSearch').addEventListener('input', renderTrackingList);
$('trackingOrders').addEventListener('click', event => {
  const button = event.target.closest('[data-tracking-open]');
  if (button) void openTrackingManager(button.dataset.trackingOpen);
});
$('trackingStatusGrid').addEventListener('click', event => {
  const button = event.target.closest('[data-tracking-state]');
  if (button) void updateTrackingStatusFromMiniapp(button.dataset.trackingState);
});
$('trackingCloseBtn').addEventListener('click', closeTrackingManager);
$('trackingAdminDialog').addEventListener('click', event => { if (event.target === $('trackingAdminDialog')) closeTrackingManager(); });
$('trackingCopyBtn').addEventListener('click', () => void copyClientTrackingLink());
$('trackingOpenBtn').addEventListener('click', () => {
  if (!activeTrackingSnapshot?.token) return;
  window.open(trackingClientUrl(activeTrackingSnapshot.token), '_blank', 'noopener');
});
$('search').addEventListener('input', renderList);
document.querySelectorAll('[data-date-filter]').forEach(button => button.addEventListener('click', () => {
  dateFilter = button.dataset.dateFilter;
  document.querySelectorAll('[data-date-filter]').forEach(item => item.classList.toggle('active', item === button));
  renderList();
}));
document.querySelectorAll('[data-tracking-date-filter]').forEach(button => button.addEventListener('click', () => {
  trackingDateFilter = button.dataset.trackingDateFilter;
  document.querySelectorAll('[data-tracking-date-filter]').forEach(item => item.classList.toggle('active', item === button));
  renderTrackingList();
}));
document.querySelectorAll('[data-screen]').forEach(button => button.addEventListener('click', () => showScreen(button.dataset.screen)));
$('headerAction').addEventListener('click', () => showScreen('settings'));
$('backBtn').addEventListener('click', () => showScreen(activeScreen === 'photos' ? 'detail' : (activeRole === 'admin' ? 'tracking' : 'list')));
$('logoutBtn').addEventListener('click', async () => {
  try { await signOut(auth); } catch (error) { console.error('Error al cerrar sesión:', error); }
});
$('themeLight').addEventListener('click', () => { setTheme('light'); showToast('Tema claro activado.'); });
$('themeDark').addEventListener('click', () => { setTheme('dark'); showToast('Tema oscuro activado.'); });
$('loginThemeBtn').addEventListener('click', () => setTheme(document.body.classList.contains('theme-dark') ? 'light' : 'dark'));

onAuthStateChanged(auth, user => {
  activeUser = user || null;
  if (!user) {
    if (stopProducts) { stopProducts(); stopProducts = null; }
    if (Array.isArray(stopTracking)) { stopTracking.forEach(unsubscribe => { try { unsubscribe(); } catch (_) {} }); stopTracking = []; } else if (typeof stopTracking === 'function') { stopTracking(); stopTracking = []; }
    activeDriver = ''; activeRole = ''; products = {}; trackingSnapshots = {}; evidence = {}; evidenceSignature = ''; listError = '';
    activeOrderId = ''; selectedFiles = [];
    closeTrackingManager();
    previewUrls.forEach(url => URL.revokeObjectURL(url)); previewUrls = [];
    showLogin();
    return;
  }
  activeDriver = normalizeDriver(user.email || '');
  activeRole = activeDriver ? 'driver' : 'admin';
  evidence = {}; evidenceSignature = ''; activeOrderId = '';
  showApp();
  if (activeRole === 'driver') {
    if (Array.isArray(stopTracking)) { stopTracking.forEach(unsubscribe => { try { unsubscribe(); } catch (_) {} }); stopTracking = []; } else if (typeof stopTracking === 'function') { stopTracking(); stopTracking = []; }
    trackingSnapshots = {};
    showScreen('list');
  } else {
    showScreen('tracking');
  }
  startProductListener();
});
listenForOfficialBusinessLogo();
setTheme(getTheme(), false);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(registration => registration.update().catch(() => {})).catch(error => console.warn('No se registró la PWA:', error)));
}
