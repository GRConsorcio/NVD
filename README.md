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
- A cada janela de 30 s o app calcula `HMAC-SHA256(secret, "q|codigo|janela")` e desenha o QR `NVD1.<codigo>.<janela>.<assinatura>`. O PIN de 6 dígitos vem do mesmo segredo. Tudo é calculado no aparelho do cliente, então **o cliente consegue mostrar o QR mesmo sem internet**. Quem precisa de conexão (mesmo lenta) é o estabelecimento, para validar.
- O servidor refaz a conta e aceita o código gerado nos **últimos ~5 minutos** (e até 1 minuto à frente, se o relógio do celular do cliente estiver adiantado). Assim, quem escaneou com sinal ruim e demorou a mandar ainda valida. Print de QR mais antigo que isso é recusado. O mesmo QR não valida em dois estabelecimentos em menos de 2 minutos.
- Validar (passo 1) e confirmar o uso (passo 2) são separados: a validação vale 15 minutos, o limite do benefício (ex.: 1 por mês) é checado no servidor.
- **Repetir é seguro**: se o atendente validar a mesma carteirinha de novo (rede que caiu no meio, tela reaberta), o servidor devolve a validação que já está aberta em vez de criar outra; e confirmar o uso duas vezes com a mesma validação devolve o mesmo uso, sem registrar em dobro.
- **Sem internet no balcão não valida**: o estabelecimento precisa de conexão (mesmo lenta) para confirmar a assinatura, o status do plano e o limite de uso, que só o servidor sabe. Validar "de cabeça" offline abriria brecha para carteirinha vencida ou uso repetido.

## Backend (Supabase "Portal Colab", `defwtvwmxntoliuwzjnf`)

Totalmente isolado do Portal:

- Tudo vive no schema **`nvd`** (não exposto pela API). Nenhuma tabela referencia `auth.users` ou tabelas do Portal.
- O app só chama funções `public.nvd_*` (RPC) com a chave pública. Cada uma valida o token de sessão e o papel dentro do banco.
- Login próprio (`nvd.usuarios` + `nvd.sessoes`, senha com bcrypt, só o hash do token é guardado). Não usa Supabase Auth.
- Limites anti-abuso (login, cadastro, validação) em `nvd.tentativas`.
- Edge Function `nvd-comprovante` (fonte em `supabase/functions/nvd-comprovante/index.ts`, publicada com `verify_jwt=false` porque o login é próprio): recebe e serve os comprovantes. Detalhes abaixo.
- O SQL está no histórico de migrações do projeto: `nvd_card_01` a `nvd_card_14` (Dashboard → Database → Migrations, ou `supabase db pull`). Região do projeto: `sa-east-1` (São Paulo).

## Pagamento

Hoje é **Pix manual**: o cliente paga, anexa o comprovante (ou só toca "Já paguei"), o admin confere no banco e confirma. Toda ativação passa por `nvd.aplicar_pagamento()`, que é o ponto onde um gateway (Asaas, Mercado Pago etc.) vai se plugar: um webhook (Edge Function) confirma o pagamento e chama a mesma função.

## Comprovante do Pix

Aba **Pagamentos** do cliente: passo 1 pagar (chave, identificador), passo 2 anexar o comprovante em imagem (JPG, PNG, WEBP; HEIC é convertido no aparelho) ou PDF, até 5 MB. Anexar já avisa o admin. Enquanto o pagamento está pendente o arquivo pode ser trocado; depois de confirmado ou cancelado, não.

- Guardado no bucket **privado** `nvd-comprovantes`, sem nenhuma policy: não existe URL pública. Só a Edge Function (chave de serviço) lê e grava.
- O upload passa pela Edge Function, que confere o tipo pelos primeiros bytes do arquivo (não pelo nome), limita o tamanho e valida a sessão no banco (`nvd_comprovante_preparar` / `nvd_comprovante_registrar`, executáveis só pelo `service_role`).
- O admin confere na aba **Comprovantes**: fila "A conferir" (mais antigo primeiro), visualizador de imagem e de PDF, botões **Baixar** e **Abrir**, e as ações Confirmar, Pedir outro comprovante e Cancelar. No computador o visualizador fica ao lado da lista; no celular abre em uma janela. O arquivo é baixado uma vez para a memória do navegador (link temporário de 2 minutos) e só tipos da lista branca (JPG, PNG, WEBP, PDF) viram visualização.
- "Pedir outro comprovante" mantém a cobrança pendente e mostra o motivo ao cliente, que reenvia; o reenvio limpa a recusa.
- Excluir um membro pelo painel apaga os arquivos dele antes da conta. A RPC `nvd_admin_membro_excluir` recusa excluir se ainda houver comprovante guardado, então não sobra arquivo órfão.
- Os comprovantes ficam guardados por tempo indeterminado (vale como registro contábil). Definir uma política de retenção é uma decisão pendente.

## Cancelamento, estorno e devolução

Estados do pagamento: `pendente`, `pago`, `cancelado`, `devolvido`.

- **Cliente cancela** uma cobrança pendente (aba Pagamentos). Se ainda não avisou que pagou, é um cancelamento simples. Se já avisou (ou anexou comprovante), o Pix pode ter chegado: o cancelamento vira automaticamente um pedido de estorno para o admin conferir.
- **Cliente pede estorno** de um pagamento confirmado, com motivo (mínimo 5 caracteres). Um pedido por pagamento; depois de recusado, só pelo suporte.
- **Admin devolve** (aba Pagamentos: filtros Estornos e Devolvidos): registra valor (total ou parcial, nunca acima do pago), observação (ex.: ID do Pix da devolução) e, se marcado, **remove da carteirinha os dias que aquele pagamento liberou** (se não sobrar plano, ela é encerrada na hora). **O Pix de devolução é feito no app do banco; o sistema só registra.**
- **Admin recusa** um estorno com motivo, que o cliente lê.
- **Comprovante da devolução:** ao registrar a devolução (ou depois, em "Trocar/Anexar comprovante da devolução") o admin anexa a prova do Pix de volta (imagem ou PDF, até 5 MB). O cliente vê em "Ver comprovante da devolução". Só admin anexa; o cliente vê apenas o do próprio pagamento. Vale a mesma regra de armazenamento privado e o arquivo é apagado junto com a conta do membro.
- Um pagamento devolvido ou cancelado nunca volta a liberar carteirinha (`nvd.aplicar_pagamento` recusa).
- Cancelar com motivo também vale para o admin; o cliente vê quem cancelou e por quê.

## Descontos do estabelecimento, com aprovação do admin

O atendente do parceiro tem a aba **Descontos**:

- **Propõe** um desconto novo ou uma **alteração** de um que já está no ar. Nada muda para os clientes até o admin aprovar (aba **Aprovações**, com selo de pendentes). Ao aprovar, o desconto nasce ou é atualizado; ao recusar, o motivo aparece para o estabelecimento, que pode **corrigir e reenviar**.
- Na alteração, o admin vê **o que muda destacado** e o valor atual riscado. Só há uma alteração pendente por desconto e no máximo 10 descontos novos pendentes por estabelecimento.
- **Pausar e retomar** vale na hora (não muda os termos aprovados). A pausa é separada da desativação do admin: o parceiro nunca reativa o que o admin desligou. Desconto pausado some do cliente e do balcão.
- O servidor valida o que o parceiro digita (percentual entre 0 e 100, valor positivo, limites coerentes) e guarda os termos normalizados.

## Resumo de preço no momento do uso

Ao confirmar o uso, o atendente informa o **valor da conta** (e, no 2x1, o valor do prato mais barato; em "outro", o desconto). **O cálculo oficial é do servidor**: percentual e valor fixo saem da conta, 2x1 desconta o prato de menor preço, brinde não abate. O resultado (conta, desconto, quanto pagar) aparece:

- **no balcão**, com prévia enquanto o atendente digita e o resumo depois de confirmar;
- **no celular do cliente**, em cerca de 3 segundos: primeiro "Carteirinha lida" quando o atendente valida, depois o resumo do desconto quando confirma. O app do cliente consulta `nvd_membro_atendimento` a cada poucos segundos enquanto mostra a carteirinha (o login é próprio, sem Realtime do Supabase). Não funciona sem internet: o cliente offline ainda apresenta o QR, mas não recebe o aviso.

Os valores ficam gravados no uso (com uma foto dos termos do desconto na hora) e aparecem no histórico do cliente, do estabelecimento e do admin. A aba **Usos** do estabelecimento mostra totais de descontos concedidos e valor recebido, hoje e no mês.

## Feito para rede fraca (v1.2.0)

O app foi ajustado depois de testes em Chrome no celular com internet ruim (lentidão e código que não validava):

- **Abre na hora, mesmo sem sinal.** O service worker (`sw.js`, cache `nvd-card-v6`) guarda a casca do app e responde com ela imediatamente, buscando a versão nova por trás ("guarda e atualiza"). Quando acha uma versão nova, mostra "Nova versão disponível" e o usuário escolhe quando atualizar. Com sessão já iniciada no aparelho, a tela abre com o perfil guardado e a sessão é conferida em segundo plano.
- **Carteirinha instantânea.** A carteirinha, o QR e o PIN aparecem sem esperar o servidor (o QR é calculado no aparelho, com o desvio de relógio guardado da última conexão). A lista de parceiros também abre da última cópia e atualiza depois.
- **Nada externo trava a abertura.** O QR é desenhado por um codificador próprio (`qrMatriz`/`qrSvg`, ~1 ms, sem biblioteca de CDN). O leitor de QR de reserva (jsQR, só para navegadores sem `BarcodeDetector`, como iPhone e Firefox) é baixado em segundo plano assim que o atendente entra e fica no cache.
- **Chamadas com limite de tempo e nova tentativa.** Cada chamada ao servidor tem prazo por tentativa (10, 15 e 25 s; no balcão 8, 12, 20 e 25 s). Falha de rede, timeout, 429 e 502-504 são refeitos sozinhos, mas só para chamadas seguras de repetir (leituras e ações que o servidor protege contra duplicidade). Aparece o aviso "Conexão lenta" depois de 2,5 s.
- **Balcão.** Validar e confirmar o uso mostram o progresso ("Tentativa 2 de 4") e, se todas falharem, um botão **Tentar de novo** que reaproveita o mesmo código do cliente (não precisa escanear outra vez).
- **Menos tráfego.** A consulta de avisos do cliente (~3 s) só roda com a tela visível e a rede livre, e espaça para ~15 s quando está sem sinal. Voltar de outro app só recarrega a carteirinha se passaram mais de 15 s.
- **Resposta atrasada não vaza entre contas.** Se a resposta lenta de uma conta chegar depois de sair e entrar com outra, ela é descartada.
- **CSS leve.** Sem `backdrop-filter`/blur; só animações baratas (opacidade e transform), desligadas para quem pediu movimento reduzido.

Tamanho: `index.html` ~160 KB (~46 KB compactado pelo servidor) e é baixado uma vez; depois vem do cache.

## Rodar local

```powershell
powershell -ExecutionPolicy Bypass -File _static_server.ps1 -Port 8799
```

Abrir `http://localhost:8799`. O QR usa `crypto.subtle`, que só existe em `https://` ou `localhost`.

## Publicar

Qualquer hospedagem estática com HTTPS (GitHub Pages, por exemplo). Publicar a pasta inteira: `index.html`, `sw.js`, `manifest.json`, `icon*.png`, `icon.svg`, `apple-touch-icon.png`. Ao publicar uma versão nova, suba a constante `VERSAO` no `index.html` (aparece na aba Conta) e, se mudar a lógica do `sw.js`, o nome do cache (`CACHE`).

## Bibliotecas

- Nenhuma no caminho crítico: o QR é gerado por código próprio dentro do `index.html`.
- `jsQR` 1.4.0 (jsDelivr, SRI sha256): leitor de QR de reserva, carregado só se o navegador não tiver `BarcodeDetector` (iPhone/Safari, Firefox). O service worker guarda uma cópia. Para eliminar de vez a dependência de CDN, dá para hospedar esse arquivo junto com o app.

## Pendências conhecidas

- Gateway de pagamento automático (hoje Pix manual).
- Upload de logo do parceiro (hoje é link de imagem).
- Notificações (vencimento do plano, pagamento confirmado).
- Termos de uso e política de privacidade revisados por advogado (o cadastro só tem uma linha de consentimento).
- Leitura de QR pela câmera testada apenas por simulação; falta validar em celular real (Android e iPhone).
- Rede fraca: testada com rede simulada no navegador do computador (queda antes e depois de chegar ao servidor, 503, conexão travada, servidor de arquivos desligado com o app aberto pelo cache). Falta medir em celular real com 3G/sinal ruim.
- Anexo de comprovante: envio, troca, visualização e exclusão foram testados com PNG e PDF pequenos. A compressão de foto grande e a conversão de HEIC (feitas no aparelho, via canvas) não foram testadas em celular real.
- Política de retenção dos comprovantes (por quanto tempo guardar).
- Regras de estorno: o sistema deixa o cliente pedir a qualquer momento e o admin decide. Vale conferir com contador ou advogado se há prazo ou condição a aplicar (por exemplo, o direito de arrependimento em compras feitas fora do estabelecimento) e, se houver, transformar em regra automática.
- Devolução hoje é só registro: o Pix de volta é manual. Um gateway de pagamento futuro poderia fazer o estorno automático.
