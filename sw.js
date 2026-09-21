// Casca do app em cache pra abrir rápido e a carteirinha funcionar sem sinal dentro do restaurante.
// Só GET do mesmo domínio e a biblioteca de QR passam por aqui: chamadas ao Supabase são POST e vão direto pra rede.
const CACHE = 'nvd-card-v2';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg'];
const LIB_QR = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(SHELL).catch(() => {});
    // a lib é cross-origin: sem ela em cache o QR não desenha quando o cliente está offline
    try { await c.add(new Request(LIB_QR, { mode: 'cors', credentials: 'omit' })); } catch (err) {}
  }));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

function guardar(req, res) {
  if (res && res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // rede primeiro: correção publicada aparece na hora; o cache só entra quando está sem internet
    e.respondWith(fetch(req).then((res) => guardar(req, res)).catch(() => caches.match(req).then((m) => m || caches.match('./index.html'))));
  } else if (req.url === LIB_QR) {
    e.respondWith(caches.match(req).then((m) => m || fetch(req).then((res) => guardar(req, res))));
  }
});
