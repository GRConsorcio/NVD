// Casca do app guardada no aparelho: abre na hora, mesmo com internet fraca ou sem sinal, e se atualiza sozinha em segundo plano.
// Estratégia "guarda e atualiza": responde com o que está guardado (instantâneo) e busca a versão nova por trás.
// Se o index.html mudou, avisa a página, que mostra "Nova versão disponível" e deixa o usuário escolher quando atualizar.
// Só GET passa por aqui: as chamadas ao Supabase são POST e vão direto pra rede (nunca guardamos dado de cliente).
const CACHE = 'nvd-card-v10';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg', './icon-192.png', './apple-touch-icon.png'];
const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'; // leitor de QR de reserva (versão fixa, nunca muda)
const PAGINA = './index.html';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) =>
    // 'reload' ignora o cache HTTP do navegador: a casca nova nasce realmente nova. Um arquivo que falhe não derruba os outros
    Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))
  ));
});

// A mensagem pode chegar antes da página estar ouvindo, então o aviso também fica gravado no cache (com a hora): a página confere
// ao abrir e ao voltar pra tela, e só mostra "nova versão" se o aviso for mais novo que a abertura dela.
const FLAG = './__novo';
async function marcarNovaVersao() {
  const c = await caches.open(CACHE);
  await c.put(new Request(FLAG), new Response(String(Date.now())));
  const cs = await self.clients.matchAll({ type: 'window' });
  cs.forEach((cl) => cl.postMessage({ tipo: 'nova-versao' }));
}

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    const antigos = ks.filter((k) => k !== CACHE);
    await Promise.all(antigos.map((k) => caches.delete(k)));
    await self.clients.claim();
    // havia uma versão anterior do app instalada: quem está com a página aberta ainda roda o código antigo
    if (antigos.length) await marcarNovaVersao();
  })());
});

// busca na rede (validando com o servidor, sem confiar no cache HTTP), guarda e, se for a página e ela mudou, avisa
async function atualizar(req, chave, ehPagina) {
  const res = await fetch(req, { cache: 'no-cache' });
  if (!res || !res.ok) return res;
  const c = await caches.open(CACHE);
  let mudou = false;
  if (ehPagina) {
    const antigo = await c.match(chave);
    mudou = !!antigo && (await antigo.clone().text()) !== (await res.clone().text());
  }
  await c.put(chave, res.clone());
  if (mudou) await marcarNovaVersao();
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.url === JSQR) {
    // versão fixa: o que está guardado vale pra sempre; só vai à rede na primeira vez
    e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((m) => m || fetch(req).then((res) => {
      if (res && res.ok) c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  if (url.origin !== self.location.origin) return;

  const ehPagina = req.mode === 'navigate' || url.pathname.endsWith('/index.html');
  // toda navegação abre a mesma página (ignora ?utm=... etc.)
  const chave = ehPagina ? new Request(PAGINA) : req;
  e.respondWith((async () => {
    const guardado = await caches.match(chave, { ignoreSearch: ehPagina });
    const rede = atualizar(ehPagina ? new Request(PAGINA) : req, chave, ehPagina);
    if (guardado) {
      e.waitUntil(rede.catch(() => {})); // segue atualizando por trás, sem segurar a resposta
      return guardado;
    }
    try { return await rede; }
    catch (err) {
      // sem cache e sem rede: na navegação, ao menos devolve a página se ela existir; senão erro de rede normal
      const pag = ehPagina ? await caches.match(PAGINA) : null;
      return pag || Response.error();
    }
  })());
});
