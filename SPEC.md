# SPEC — Custom White-Label Payment Gateway

> **Arquitetura:** Next.js Core + Vite Micro-Frontends + Prisma ORM
> **Upstream Provider:** Asaas API v3 (Subcontas / Marketplace)
> **Objetivo Central:** Gateway de pagamento white-label e transparente sobre a Asaas, cobrindo onboarding de subcontas, APIs para lojas virtuais, links de pagamento, recorrência e gestão fiscal.
> **Regra de ouro:** o pagador final **nunca** deve ver menções ao Asaas — interface, domínio e recibos pertencem integralmente à nossa plataforma.

---

## 1. Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Backend core & Dashboard | **Next.js 14+** (App Router, Route Handlers, Server Actions) |
| Apps públicos (Checkout / Link de Pagamento) | **Vite + React** (SPA desacoplada, carregamento < 1s) |
| ORM & Banco | **Prisma ORM + PostgreSQL** |
| Estilização / Design System | **Tailwind CSS** + componentes acessíveis (Radix UI / Lucide Icons) |
| Filas, cache & rate limiting | **Redis + BullMQ** (webhooks, e-mails transacionais, mensageria fiscal) |
| E-mail transacional | Resend / SendGrid / SES |
| Fiscal | Driver pattern: Focus NFe / PlugNotas / e-Notas |

---

## 2. Papéis e Tenancy

- **super_admin** — operador central: taxas de plataforma (spread/split), relatórios globais e compliance.
- **merchant** — lojista, autônomo ou prestador de serviço (dono de subconta Asaas).
- **customer** — pagador final da cobrança, sempre vinculado a um merchant.

---

## 3. Módulos Funcionais

### Módulo A — Onboarding & KYC
| Método | Rota | Finalidade |
|---|---|---|
| POST | `/api/v1/merchants/register` | Registro na base local + criação de subconta via `POST /v3/accounts` (Asaas) |
| POST | `/api/v1/merchants/kyc` | Upload multipart de documentos → `POST /v3/accounts/{id}/documents` |

- Webhook listener do evento **`ACCOUNT_STATUS_CHANGED`**: atualiza status KYC do merchant via Prisma (`PENDING → APPROVED/REJECTED`).
- Wizard de onboarding no dashboard com progresso visual 0%–100% e status dos documentos (`Pendente`, `Em Análise`, `Aprovado`, `Rejeitado`).

### Módulo B — Autenticação & API Keys
- **Session/JWT** para o dashboard Next.js.
- **Public key** `pk_live_...` — tokenização client-side e checkout público.
- **Secret key** `sk_live_...` — chamadas server-to-server; o banco guarda **apenas hash SHA-256**.

### Módulo C — Payment Engine
Métodos suportados:
- **Pix** — QR Code dinâmico + Copia-e-Cola, botão de cópia em 1 clique com toast e contador regressivo de expiração.
- **Cartão de crédito** — tokenização transparente (PCI SAQ A) e parcelamento de **1x a 12x** com simulador visual discriminando juros/sem juros.
- **Boleto** — emissão com linha digitável e PDF.

Endpoint principal: **`POST /api/v1/charges`** — roteado com o `access_token` isolado da subconta do merchant.

### Módulo D — Links de Pagamento & Recorrência
- **Payment Links** — SPA Vite/React responsiva em `/pay/{slug}`; seleção de método, cálculo transparente de taxas configuradas pelo merchant.
- **Subscriptions** — recorrência (mensalidades, SaaS, pessoais) via `POST /v3/subscriptions`.

### Módulo E — Webhooks & Notificações
- **Inbound (Asaas):** `POST /api/v1/webhooks/asaas` — validação de token de segurança + atualização **idempotente** no Prisma. Eventos tratados: `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`.
- No evento `PAYMENT_RECEIVED`:
  1. Dispara **e-mail transacional** de comprovante ao cliente final (HTML responsivo, marca própria);
  2. Enfileira job de **emissão de NFS-e/NF-e** (driver fiscal);
  3. Enfileira **webhook outbound** para a URL do lojista com assinatura **HMAC-SHA256** (`X-Signature`) e retry idempotente.

### Módulo F — Dashboard Financeiro & Fiscal
- Painel consolidado: faturamento bruto/líquido, MRR, saldo a receber, taxas retidas, projeções, inadimplência e volume por método.
- Tabelas com paginação, busca debounced, filtros de status, skeleton loaders e zero-states.
- Geração de link de pagamento avulso e configuração de mensalidades recorrentes.
- Gestão de chaves de API, webhooks cadastrados e extrato analítico exportável.
- Acompanhamento e download de notas fiscais (PDF/XML).

---

## 4. Segurança & Compliance (Prioridade Máxima)

| Item | Implementação |
|---|---|
| **PCI-DSS SAQ A** | Backend **nunca** recebe/registra PAN ou CVV; tokenização ocorre client-side antes da criação da cobrança |
| **Criptografia de tokens de subconta** | AES-256-GCM (`asaasApiKeyEncrypted` no banco) |
| **API secrets** | Hash SHA-256 das `sk_live_*`; apenas `pk_live_*` visível |
| **Idempotência** | Header `Idempotency-Key` (UUIDv4) obrigatório em `POST /api/v1/charges`; respostas cacheadas na tabela `IdempotencyKey` |
| **Rate limiting** | Token bucket em Redis — máx. 5 tentativas/IP/minuto em endpoints de checkout (anti card-testing/brute-force) |
| **Webhooks** | Validação de token inbound + assinatura HMAC-SHA256 outbound |
| **HTTP headers** | CSP restritiva, HSTS, `X-Frame-Options: SAMEORIGIN` (anti clickjacking) |
| **Transações financeiras** | Sempre via `prisma.$transaction` |

---

## 5. SEO & Indexação

- **Páginas institucionais/docs/landing:** SSR/SSG com Metadata API (OpenGraph, Twitter Cards) + JSON-LD; sitemap automático via `app/sitemap.ts`.
- **Páginas transacionais (`/pay/*`, `/checkout/*`):** `noindex, nofollow` obrigatório — meta robots + header `X-Robots-Tag`.

---

## 6. Modelagem de Dados (Prisma)

Modelos com índices e constraints estritas:

| Modelo | Destaques |
|---|---|
| `Merchant` | Dados cadastrais/fiscais, `asaasAccountId`, `asaasApiKeyEncrypted`, `KycStatus (PENDING/APPROVED/REJECTED)` |
| `ApiKey` | Prefixo público `pk_...`, hash da secreta `sk_...`, permissões, revogação |
| `Customer` | Pagador final vinculado ao merchant |
| `Charge` | `asaasPaymentId`, método (`PIX/CREDIT_CARD/BOLETO`), status, valor bruto, taxa de plataforma, valor líquido, parcelas |
| `Subscription` | Plano recorrente, periodicidade, status de vigência |
| `PaymentLink` | Slug/UUID, valor, descrição, métodos permitidos, config de parcelamento |
| `Invoice` | Vínculo com cobrança, status de emissão NFS-e/NF-e, URL PDF/XML |
| `WebhookDelivery` | Log + idempotência de eventos inbound/outbound |
| `IdempotencyKey` | Chave → resposta cacheada (consistência de transações) |

Schema completo em [`apps/api/prisma/schema.prisma`](apps/api/prisma/schema.prisma).

---

## 7. Contrato de API (resumo)

```
POST /api/v1/merchants/register        # registro + subconta Asaas
POST /api/v1/merchants/kyc             # upload de documentos (multipart)
POST /api/v1/charges                   # sk_live + Idempotency-Key obrigatórios
GET  /api/v1/charges/{id}              # status da cobrança
GET  /api/v1/charges/{id}/boleto.pdf   # PDF do boleto
POST /api/v1/subscriptions             # recorrência
POST /api/v1/payment-links             # criação de link (dashboard)
GET  /api/v1/public/pay/{slug}         # dados do link (pk_live)
POST /api/v1/public/charges            # cobrança do checkout público (pk_live + rate limit)
POST /api/v1/public/credit-card/tokenize  # proxy de tokenização (não persiste PAN/CVV)
GET  /api/v1/public/charges/{id}/status   # polling de status (Pix/boleto)
POST /api/v1/webhooks/asaas            # inbound Asaas (valida token)
```

Respostas padronizadas em JSON **sem vazamento** de URLs/headers do Asaas.

---

## 8. Estrutura do Repositório

```
apps/
├── api/                         # Next.js 14 (App Router) — backend + dashboard
│   ├── prisma/schema.prisma     # Módulo D (modelagem)
│   └── src/
│       ├── app/(dashboard)/     # Dashboard financeiro (Módulo F)
│       ├── app/api/v1/          # REST pública + rotas de checkout (Módulos A–E)
│       ├── middleware.ts        # CSP/HSTS/X-Robots-Tag/rate-limit
│       ├── services/            # asaas.client · charges · onboarding · subscriptions · webhooks
│       ├── fiscal/              # driver pattern (Focus NFe / PlugNotas)
│       ├── queues/ workers/     # BullMQ: webhook outbound, e-mail, nota fiscal
│       └── lib/                 # crypto (AES-256-GCM/SHA-256) · ratelimit (Redis) · http · session · prisma
└── checkout-app/                # Vite + React + Tailwind — SPA de pagamento (Módulo D/B)
    └── src/
        ├── App.tsx              # One-page checkout (tabs Pix/Cartão/Boleto)
        ├── components/          # CardForm (BIN+máscaras+parcelas) · PixPanel · BoletoPanel
        └── masks.ts format.ts api.ts
```

---

## 9. Variáveis de Ambiente (`apps/api/.env.example`)

```
DATABASE_URL=            # PostgreSQL
REDIS_URL=               # filas + rate limiting
ASAAS_BASE_URL=          # sandbox: https://api-sandbox.asaas.com/v3 | prod: https://api.asaas.com/v3
ASAAS_API_KEY_BASE=      # conta mestre (marketplace)
ASAAS_WEBHOOK_TOKEN=     # validação inbound
APP_ENCRYPTION_KEY=      # AES-256-GCM (32 bytes) p/ tokens de subconta
WEBHOOK_SIGNING_SECRET=  # HMAC-SHA256 outbound
NEXT_PUBLIC_CHECKOUT_URL=# base do SPA Vite (/pay/{slug})
FOCUS_NFE_API_KEY=       # driver fiscal (ou PLUGNOTAS_API_KEY)
RESEND_API_KEY=          # e-mail transacional
```

---

## 10. Status de Implementação

| Módulo | Status |
|---|---|
| A — Prisma Schema (9 modelos) | ✅ Implementado |
| B — AsaasClient (subcontas, KYC multipart, Pix/Cartão/Boleto, assinaturas, isolamento de token) | ✅ Implementado |
| C — REST `/api/v1/charges` (auth sk_live, idempotência, response white-label) | ✅ Implementado |
| D — Checkout SPA Vite/React (one-page, BIN, máscaras, parcelas 1x–12x, Pix copy+countdown, polling) | ✅ Implementado |
| E — Webhooks inbound/outbound + filas BullMQ + gatilho fiscal + e-mail | ✅ Implementado |
| F — Dashboard Next.js (métricas, links, assinaturas, notas, settings/chaves) | ✅ Implementado |
| Middleware de segurança (CSP/HSTS/X-Robots-Tag/rate limit) | ✅ Implementado |
| SEO técnico (sitemap/metadata/JSON-LD institucional) | ⚠️ Pendente (meta noindex já aplicado nas rotas transacionais) |
| Migrações Prisma / testes E2E | ⚠️ Pendente (requer Postgres + Redis + credenciais sandbox Asaas) |

**Validações concluídas:** `tsc --noEmit` ✅ · build Next.js ✅ · build Vite ✅ · `prisma validate` ✅

---

*Documento gerado a partir do estado real do repositório no commit `0969bb0` — branch enviada para `github.com/ortizpedroso/gateway`.*
