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

let activeUser = null;
let activeDriver = '';
let products = {};
let evidence = {};
let stopProducts = null;
let activeScreen = 'list';
let listFilter = 'asignadas';
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
  const touchIcon = $('dynamicTouchIcon');
  if (!url) {
    loginImg?.classList.add('hidden'); headerImg?.classList.add('hidden');
    loginFallback?.classList.remove('hidden'); headerFallback?.classList.remove('hidden');
    if (persist) { try { localStorage.removeItem('petsmart-business-logo-url'); } catch (_) {} }
    return;
  }
  const onLogoError = () => {
    loginImg?.classList.add('hidden'); headerImg?.classList.add('hidden');
    loginFallback?.classList.remove('hidden'); headerFallback?.classList.remove('hidden');
    if (favicon) { favicon.href = './icon.svg'; favicon.type = 'image/svg+xml'; }
    if (touchIcon) touchIcon.href = './icon.svg';
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
  if (touchIcon) touchIcon.href = url;
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
function fmtDate(value) {
  if (!value) return 'Por coordinar';
  const str = String(value);
  const [y, m, d] = str.split('-').map(Number);
  if (y && m && d) return new Date(y, m - 1, d, 12).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? str : parsed.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
}
function orderStatus(items) {
  const statuses = items.map(p => String(p.entregaEstado || 'Pendiente'));
  if (statuses.includes('Incidencia')) return 'Incidencia';
  if (statuses.length && statuses.every(s => s === 'Entregado')) return 'Entregado';
  if (statuses.includes('En destino')) return 'En destino';
  if (statuses.includes('En camino')) return 'En camino';
  if (statuses.includes('Preparando')) return 'Preparando';
  return 'Pendiente';
}
function hasDeliveryInfo(product) {
  return !!(
    String(product.envio || '').trim() ||
    String(product.direccionEntrega || '').trim() ||
    String(product.fechaEntrega || '').trim() ||
    String(product.horarioEntrega || '').trim()
  );
}
function allDeliveryItems() {
  const grouped = new Map();
  Object.entries(products || {}).forEach(([productId, product]) => {
    if (!product || product.estado !== 'vendido' || !hasDeliveryInfo(product)) return;
    const groupId = String(product.ventaGrupoId || productId);
    if (!grouped.has(groupId)) grouped.set(groupId, { id: groupId, items: [], first: product, driver: '' });
    const group = grouped.get(groupId);
    group.items.push({ ...product, id: productId });
    const assigned = normalizeDriver(product.repartidorAsignado || product.repartidorAsignadoEmail || '');
    if (!group.driver && assigned) group.driver = assigned;
    if (String(product.fechaVenta || '') < String(group.first.fechaVenta || '')) group.first = product;
  });
  return [...grouped.values()].map(group => {
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
      updatedAt: p.entregaActualizadoEn || '',
      incidence: p.entregaIncidencia || '',
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
  $('helloName').textContent = `¡Hola, ${activeDriver}!`;
  $('settingName').textContent = activeDriver || 'Repartidor';
  $('settingEmail').textContent = activeUser?.email || '';
}
function showScreen(screen) {
  if (!['list', 'detail', 'photos', 'settings'].includes(screen)) screen = 'list';
  activeScreen = screen;
  $('deliveriesView').classList.toggle('hidden', screen !== 'list');
  $('detailView').classList.toggle('hidden', screen !== 'detail');
  $('photosView').classList.toggle('hidden', screen !== 'photos');
  $('settingsView').classList.toggle('hidden', screen !== 'settings');
  const subpage = screen === 'detail' || screen === 'photos';
  $('backBtn').classList.toggle('hidden', !subpage);
  $('headerBrand').classList.toggle('hidden', subpage);
  $('headerTitle').classList.toggle('hidden', !subpage);
  $('headerAction').classList.toggle('hidden', subpage);
  if (screen === 'detail') {
    $('headerTitle').querySelector('strong').textContent = 'Detalle de entrega';
    $('headerSubtitle').textContent = currentOrder()?.pedido ? `Pedido ${currentOrder().pedido}` : 'Información del pedido';
  }
  if (screen === 'photos') {
    $('headerTitle').querySelector('strong').textContent = 'Agregar fotos';
    $('headerSubtitle').textContent = 'Evidencia de entrega';
  }
  $('bottomNav').classList.toggle('hidden', subpage);
  $('bottomNav').querySelectorAll('[data-screen]').forEach(btn => btn.classList.toggle('active', (screen === 'list' && btn.dataset.screen === 'list') || (screen === 'settings' && btn.dataset.screen === 'settings')));
  if (screen === 'list') renderList();
  else if (screen === 'detail') renderDetail();
  else if (screen === 'photos') renderPhotos();
}
function statusChip(status) {
  const cls = status === 'Entregado' ? 'done' : status === 'Incidencia' ? 'issue' : '';
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
  const assignedCount = orders.filter(order => order.status !== 'Entregado').length;
  const deliveredCount = orders.filter(order => order.status === 'Entregado').length;
  $('countAssigned').textContent = assignedCount;
  $('countDelivered').textContent = deliveredCount;
  $('countAll').textContent = orders.length;
  const shown = matching.filter(order => listFilter === 'asignadas' ? order.status !== 'Entregado' : listFilter === 'entregadas' ? order.status === 'Entregado' : true);
  $('listCount').textContent = `${shown.length} ${shown.length === 1 ? 'pedido' : 'pedidos'}`;
  $('orders').innerHTML = shown.map(order => {
    const product = order.items[0] || {};
    const reference = order.pedido ? `#${order.pedido}` : `#${order.id.slice(-8).toUpperCase()}`;
    const schedule = [fmtDate(order.fechaEntrega), order.horario].filter((value, index) => value && !(index === 0 && value === 'Por coordinar')).join(' · ');
    return `<button type="button" class="delivery-card" data-open="${escapeHtml(order.id)}" aria-label="Abrir entrega de ${escapeHtml(order.clienteNombre)}">
      ${imageOrFallback(product)}
      <span class="delivery-main"><span class="delivery-topline"><span class="order-number">${escapeHtml(reference)}</span>${statusChip(order.status)}</span><span class="customer-name">${escapeHtml(order.clienteNombre)}</span><span class="product-summary">${escapeHtml(order.productsText || 'Productos del pedido')}</span><span class="card-meta">${escapeHtml([schedule, order.distrito].filter(Boolean).join(' · ') || 'Entrega por coordinar')}</span><span class="driver-mini"><span class="avatar">${escapeHtml(order.driver.slice(0, 1))}</span>${escapeHtml(order.driver)}</span></span>
      <span class="chevron" aria-hidden="true">›</span></button>`;
  }).join('');
  $('loadingOrders').classList.add('hidden');
  $('ordersEmpty').classList.toggle('hidden', shown.length > 0);
  $('orders').classList.toggle('hidden', shown.length === 0);
  if (listError) {
    $('emptyTitle').textContent = 'No se pudieron cargar los pedidos';
    $('emptyCopy').textContent = listError;
    $('ordersEmpty').classList.remove('hidden');
    $('orders').classList.add('hidden');
  } else if (!orders.length) {
    $('emptyTitle').textContent = 'Todavía no tienes entregas asignadas';
    $('emptyCopy').textContent = 'Cuando el administrador te asigne una venta desde el inventario aparecerá aquí.';
  } else if (!shown.length) {
    $('emptyTitle').textContent = q ? 'No encontramos resultados' : 'No hay pedidos en este filtro';
    $('emptyCopy').textContent = q ? 'Prueba buscar por nombre, número de pedido, distrito o producto.' : 'Puedes cambiar el filtro para revisar las entregas de otra etapa.';
  }
  $('orders').querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => {
    activeOrderId = button.dataset.open;
    showScreen('detail');
  }));
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
  const phone = String(order.telefono || '').replace(/[^0-9+]/g, '');
  const nextOptions = ['Pendiente', 'Preparando', 'En camino', 'En destino', 'Entregado', 'Incidencia'].map(status => `<option value="${status}" ${order.status === status ? 'selected' : ''}>${status}</option>`).join('');
  $('detailView').innerHTML = `
    <div class="order-card"><div class="order-id-row"><span class="order-code">Pedido ${escapeHtml(reference)}</span>${statusChip(order.status)}</div>
      <div class="detail-person"><span class="avatar" style="width:30px;height:30px">${escapeHtml(order.clienteNombre.trim().slice(0,1).toUpperCase() || 'C')}</span><span>${escapeHtml(order.clienteNombre)}</span></div>
      <div class="detail-line"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12Z"/><circle cx="12" cy="9" r="2.3"/></svg><span>${escapeHtml([order.direccion, order.distrito].filter(Boolean).join(', ') || 'Sin dirección registrada')}</span></div>
      <div class="detail-line"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>${escapeHtml(schedule)}</span></div>
      ${order.envio ? `<div class="detail-line"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"/><circle cx="7.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/></svg><span>${escapeHtml(order.envio)}</span></div>` : ''}
    </div>
    <div class="mini-section-title">Repartidor asignado</div><div class="assigned-driver"><span class="avatar" style="width:38px;height:38px;font-size:12px">${escapeHtml(order.driver.slice(0,1))}</span><span style="flex:1"><strong>${escapeHtml(order.driver)}</strong><small>Esta entrega está asignada a tu cuenta</small></span></div>
    <div class="mini-section-title">Productos (${order.items.length})</div><div class="section-card" style="padding:8px 13px">${productsHtml || '<p class="small-note">No se encontraron productos.</p>'}</div>
    <div class="mini-section-title">Cliente</div><div class="section-card"><div class="detail-person" style="margin-top:0"><span>${escapeHtml(order.clienteNombre)}</span></div><div class="detail-line"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z"/></svg><span>${escapeHtml(order.telefono || 'Teléfono no registrado')}</span>${phone ? `<a class="secondary" style="margin-left:auto;padding:7px 10px;min-height:0" href="tel:${escapeHtml(phone)}">Llamar</a>` : ''}</div>${order.observacion ? `<div class="detail-line"><span>Referencia: ${escapeHtml(order.observacion)}</span></div>` : ''}</div>
    ${order.status === 'Incidencia' && order.incidence ? `<div class="section-card" style="border-color:#ffc7d0"><strong class="danger" style="font-size:12px">Incidencia registrada</strong><p style="font-size:12px;margin:6px 0 0">${escapeHtml(order.incidence)}</p></div>` : ''}
    <div class="section-card"><label for="detailStatus" style="display:block;font-size:11px;font-weight:900;margin-bottom:7px">Actualizar estado de entrega</label><select id="detailStatus" class="field-input">${nextOptions}</select><p class="small-note" style="margin:8px 0 0">El estado se sincroniza en el registro del inventario y en los registros de venta existentes.</p></div>
    <div class="detail-actions"><button class="primary" data-open-photos="${escapeHtml(order.id)}" type="button">${cameraIcon()} Ver fotos de entrega</button>${order.status !== 'Entregado' ? `<button class="secondary" data-delivered="${escapeHtml(order.id)}" type="button">Marcar como entregado</button>` : `<div class="status-chip done" style="justify-content:center;padding:10px">Pedido entregado</div>`}</div>`;
  $('detailView').querySelector('#detailStatus')?.addEventListener('change', async event => {
    const next = event.target.value;
    if (next !== order.status) await updateOrderStatus(order, next);
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
  return (Array.isArray(value) ? value : Object.values(value || {})).filter(photo => photo && photo.secureUrl).sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
}
function renderPhotos() {
  const order = currentOrder();
  if (!order) {
    $('photosView').innerHTML = '<div class="empty-state"><h3>Esta entrega ya no está asignada</h3><p>Regresa a la lista para ver tus pedidos actuales.</p></div>';
    return;
  }
  const existing = photoArray(order.id);
  const existingHtml = existing.map(photo => `<a class="photo-tile" href="${escapeHtml(photo.secureUrl)}" target="_blank" rel="noopener" aria-label="Abrir foto ${escapeHtml(photo.fileName || '')}"><img src="${escapeHtml(photo.secureUrl)}" alt="Evidencia guardada" loading="lazy"><span style="position:absolute;left:7px;right:7px;bottom:6px;border-radius:8px;padding:5px;background:rgba(7,20,36,.72);color:white;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(photo.fileName || 'Foto guardada')}</span></a>`).join('');
  const previews = selectedFiles.map((file, index) => `<div class="photo-tile"><img src="${escapeHtml(previewUrls[index] || '')}" alt="Foto nueva seleccionada"><button class="remove-preview" type="button" data-remove-file="${index}" aria-label="Quitar imagen">×</button></div>`).join('');
  const canAdd = selectedFiles.length < maxPhotoCount;
  $('photosView').innerHTML = `<div class="order-card"><div class="order-id-row"><strong class="order-code">Pedido ${escapeHtml(order.pedido || order.id.slice(-8).toUpperCase())}</strong>${statusChip(order.status)}</div><div class="detail-person"><span class="avatar">${escapeHtml(order.clienteNombre.slice(0,1).toUpperCase())}</span>${escapeHtml(order.clienteNombre)}</div></div>
    <div class="photo-intro"><span style="color:var(--blue);margin-top:1px">${cameraIcon()}</span><div><strong>Toma las fotos de la entrega</strong><p>Asegúrate de que la imagen sea clara y muestre la evidencia necesaria. Puedes guardar hasta ${maxPhotoCount} imágenes por pedido.</p></div></div>
    ${existing.length ? `<div class="mini-section-title">Fotos guardadas (${existing.length})</div><div class="photo-grid">${existingHtml}</div>` : '<p class="small-note" style="margin:15px 2px">Todavía no hay fotos registradas en este pedido.</p>'}
    <div class="mini-section-title">${selectedFiles.length ? `Fotos nuevas (${selectedFiles.length})` : 'Agregar fotografías'}</div>
    <div class="photo-grid">${previews}${canAdd ? `<label class="add-photo-tile"><input id="photoInput" class="hidden" type="file" accept="image/*" capture="environment" multiple><span>${cameraIcon()}</span>Agregar fotos<small>JPG, PNG, WEBP · máx. 10 MB</small></label>` : ''}</div>
    <div id="photoMsg" class="small-note" style="margin-top:12px"></div>
    <div class="photo-footer" style="position:sticky;bottom:calc(72px + env(safe-area-inset-bottom));padding:12px 0 4px;background:var(--bg)"><button id="uploadPhotosBtn" class="primary" type="button" ${selectedFiles.length ? '' : 'disabled'}>Guardar evidencia (${selectedFiles.length})</button><button id="backToDetail" class="secondary" style="width:100%;margin-top:8px" type="button">Volver al pedido</button></div>
    <p class="small-note" style="margin-top:9px">Las cargas de Cloudinary configuradas actualmente usan un preset sin firma. Este enlace puede ser público; utiliza solo imágenes de prueba hasta implementar carga privada.</p>`;
  $('photosView').querySelector('#photoInput')?.addEventListener('change', event => {
    const incoming = [...(event.target.files || [])];
    if (selectedFiles.length + incoming.length > maxPhotoCount) {
      $('photoMsg').textContent = `Puedes guardar como máximo ${maxPhotoCount} fotos por pedido.`;
      incoming.length = Math.max(0, maxPhotoCount - selectedFiles.length);
    }
    const invalid = incoming.find(file => !file.type.startsWith('image/') || file.size > maxPhotoBytes);
    if (invalid) {
      $('photoMsg').textContent = `${invalid.name} no es una imagen válida o supera los 10 MB.`;
      event.target.value = '';
      return;
    }
    incoming.forEach(file => { selectedFiles.push(file); previewUrls.push(URL.createObjectURL(file)); });
    renderPhotos();
  });
  $('photosView').querySelectorAll('[data-remove-file]').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.removeFile);
    if (previewUrls[index]) URL.revokeObjectURL(previewUrls[index]);
    selectedFiles.splice(index, 1); previewUrls.splice(index, 1); renderPhotos();
  }));
  $('photosView').querySelector('#uploadPhotosBtn')?.addEventListener('click', uploadPhotos);
  $('photosView').querySelector('#backToDetail')?.addEventListener('click', () => showScreen('detail'));
}
async function updateOrderStatus(order, newStatus) {
  const valid = ['Pendiente', 'Preparando', 'En camino', 'En destino', 'Entregado', 'Incidencia'];
  if (!valid.includes(newStatus) || !order) return;
  let reason = '';
  if (newStatus === 'Incidencia') {
    reason = prompt('Describe brevemente la incidencia de esta entrega:')?.trim() || '';
    if (!reason) { showToast('Para registrar una incidencia debes escribir el motivo.', 'error'); renderDetail(); return; }
  }
  const now = new Date().toISOString();
  const first = order.items[0] || {};
  const history = Array.isArray(first.entregaHistorial) ? first.entregaHistorial.slice() : [];
  if (String(order.status) !== newStatus || reason) history.push({ estado: newStatus, fecha: now, nota: reason });
  const updates = {};
  order.items.forEach(product => {
    updates[`productos/${product.id}/entregaEstado`] = newStatus;
    updates[`productos/${product.id}/entregaActualizadoEn`] = now;
    updates[`productos/${product.id}/entregaHistorial`] = history;
    if (reason) updates[`productos/${product.id}/entregaIncidencia`] = reason;
    else if (newStatus !== 'Incidencia') updates[`productos/${product.id}/entregaIncidencia`] = '';
    // Keep the existing additional sale record synchronized without creating a new sale.
    updates[`ventas/${product.id}/entregaEstado`] = newStatus;
    updates[`ventas/${product.id}/entregaActualizadoEn`] = now;
    updates[`ventas/${product.id}/entregaHistorial`] = history;
    if (reason) updates[`ventas/${product.id}/entregaIncidencia`] = reason;
    else if (newStatus !== 'Incidencia') updates[`ventas/${product.id}/entregaIncidencia`] = '';
  });
  try {
    await update(ref(db), updates);
    showToast(`Estado actualizado: ${newStatus}.`, 'success');
    // Live listener updates products; refresh the current view as a fallback.
    await refreshProductsOnce();
  } catch (error) {
    console.error('No se pudo actualizar el estado:', error);
    showToast('No se pudo guardar el estado. Revisa los permisos de Firebase.', 'error', 6000);
    renderDetail();
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
async function uploadPhotos() {
  const order = currentOrder();
  const target = $('photoMsg');
  if (!order) { showToast('La entrega ya no está asignada a tu cuenta.', 'error'); showScreen('list'); return; }
  if (!selectedFiles.length) { target.textContent = 'Selecciona al menos una fotografía.'; return; }
  if (selectedFiles.length + photoArray(order.id).length > maxPhotoCount) { target.textContent = `Este pedido ya tiene fotos. El máximo permitido por pedido es ${maxPhotoCount}.`; return; }
  const button = $('uploadPhotosBtn');
  button.disabled = true; button.textContent = 'Subiendo evidencia…';
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
    const current = $('uploadPhotosBtn');
    if (current) { current.disabled = selectedFiles.length === 0; current.textContent = `Guardar evidencia (${selectedFiles.length})`; }
  }
}
function startProductListener() {
  if (stopProducts) stopProducts();
  listError = '';
  $('loadingOrders').classList.remove('hidden');
  $('ordersEmpty').classList.add('hidden');
  stopProducts = onValue(ref(db, 'productos'), snapshot => {
    products = snapshot.exists() ? snapshot.val() : {};
    listError = '';
    $('loadingOrders').classList.add('hidden');
    renderList();
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
    'auth/operation-not-allowed': 'Firebase Authentication no tiene habilitado el proveedor Email/Password.'
  };
  return messages[error?.code] || `No se pudo iniciar sesión (${error?.code || 'error'}). Comprueba la cuenta y la configuración de Firebase.`;
}
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const username = $('username').value.trim().toLowerCase();
  const password = $('password').value;
  const alias = username.includes('@') ? Object.keys(aliases).find(key => aliases[key] === username) : username;
  const email = aliases[alias];
  if (!email) { showLogin('Usuario no reconocido. Escribe Chavalillo o Chavalilla.'); return; }
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
$('search').addEventListener('input', renderList);
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  listFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button));
  renderList();
}));
document.querySelectorAll('[data-screen]').forEach(button => button.addEventListener('click', () => showScreen(button.dataset.screen)));
$('headerAction').addEventListener('click', () => showScreen('settings'));
$('backBtn').addEventListener('click', () => showScreen(activeScreen === 'photos' ? 'detail' : 'list'));
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
    activeDriver = ''; products = {}; evidence = {}; evidenceSignature = ''; listError = '';
    activeOrderId = ''; selectedFiles = [];
    previewUrls.forEach(url => URL.revokeObjectURL(url)); previewUrls = [];
    showLogin();
    return;
  }
  activeDriver = normalizeDriver(user.email || '');
  if (!activeDriver) {
    showLogin('Esta cuenta no está habilitada como repartidor PetSmart.');
    signOut(auth).catch(() => {});
    return;
  }
  evidence = {}; evidenceSignature = ''; activeOrderId = '';
  showApp(); showScreen('list'); startProductListener();
});
listenForOfficialBusinessLogo();
setTheme(getTheme(), false);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(error => console.warn('No se registró la PWA:', error)));
}
