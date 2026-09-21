# NVD CARD

Clube de descontos em restaurantes e empresas parceiras (estilo Duo Gourmet). O cliente paga um plano, recebe uma carteirinha digital com QR code e o parceiro valida e registra o uso do benefício na hora.

App único (`index.html`, HTML/JS puro, sem build), instalável como PWA. Backend no Supabase.

## Três perfis, um app

| Perfil | O que faz |
|---|---|
| **Cliente** | Cria conta, escolhe plano, paga por Pix, usa a carteirinha (QR + PIN que mudam a cada 30 s), vê parceiros e histórico. |
| **Parceiro (atendente)** | Escaneia o QR (ou digita código + PIN), vê se a carteirinha está ativa, escolhe o benefício e confirma o uso. Pode estornar em até 60 min. |
| **Admin** | Confirma pagamentos, gerencia membros, parceiros, benefícios, planos, acessos e configurações (chave Pix, WhatsApp). |

## Como a validação funciona

- Cada membro tem um `codigo` público (8 caracteres) e um `qr_secret` que só o servidor e o próprio app dele conhecem.
- A cada janela de 30 s o app calcula `HMAC-SHA256(secret, "q|codigo|janela")` e desenha o QR `NVD1.<codigo>.<janela>.<assinatura>`. O PIN de 6 dígitos vem do mesmo segredo. Tudo é calculado no aparelho, então **funciona sem internet** dentro do restaurante.
- O servidor refaz a conta, aceita ~1 minuto de tolerância e recusa print antigo. O mesmo QR não valida em dois estabelecimentos em menos de 2 minutos.
- Validar (passo 1) e confirmar o uso (passo 2) são separados: a validação vale 15 minutos, o limite do benefício (ex.: 1 por mês) é checado no servidor.

## Backend (Supabase "Portal Colab", `defwtvwmxntoliuwzjnf`)

Totalmente isolado do Portal:

- Tudo vive no schema **`nvd`** (não exposto pela API). Nenhuma tabela referencia `auth.users` ou tabelas do Portal.
- O app só chama funções `public.nvd_*` (RPC) com a chave pública. Cada uma valida o token de sessão e o papel dentro do banco.
- Login próprio (`nvd.usuarios` + `nvd.sessoes`, senha com bcrypt, só o hash do token é guardado). Não usa Supabase Auth.
- Limites anti-abuso (login, cadastro, validação) em `nvd.tentativas`.
- O SQL está no histórico de migrações do projeto: `nvd_card_01` a `nvd_card_07` (Dashboard → Database → Migrations, ou `supabase db pull`).

## Pagamento

Hoje é **Pix manual**: o cliente paga, toca "Já paguei", o admin confere no banco e confirma. Toda ativação passa por `nvd.aplicar_pagamento()`, que é o ponto onde um gateway (Asaas, Mercado Pago etc.) vai se plugar: um webhook (Edge Function) confirma o pagamento e chama a mesma função.

## Rodar local

```powershell
powershell -ExecutionPolicy Bypass -File _static_server.ps1 -Port 8797
```

Abrir `http://localhost:8797`. O QR usa `crypto.subtle`, que só existe em `https://` ou `localhost`.

## Publicar

Qualquer hospedagem estática com HTTPS (GitHub Pages, por exemplo). Publicar a pasta inteira: `index.html`, `sw.js`, `manifest.json`, `icon*.png`, `icon.svg`, `apple-touch-icon.png`.

## Bibliotecas (com integridade fixada)

- `qrcode-generator` 1.4.4 (cdnjs, SRI sha512): desenha o QR. O service worker guarda uma cópia para abrir offline.
- `jsQR` 1.4.0 (jsDelivr, SRI sha256): leitor de QR, carregado só se o navegador não tiver `BarcodeDetector` (iPhone/Safari, Firefox).

## Pendências conhecidas

- Gateway de pagamento automático (hoje Pix manual).
- Upload de logo do parceiro (hoje é link de imagem).
- Notificações (vencimento do plano, pagamento confirmado).
- Termos de uso e política de privacidade revisados por advogado (o cadastro só tem uma linha de consentimento).
- Leitura de QR pela câmera testada apenas por simulação; falta validar em celular real (Android e iPhone).
