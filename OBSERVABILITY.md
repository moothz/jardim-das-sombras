# Observabilidade (OpenTelemetry) — Jardim das Sombras

A API exporta **traces** e **métricas** via OTLP/HTTP para o stack de observabilidade do ecossistema
Ravena, que fica no repo **ravena-ai**, pasta `observability/` (otel-collector + Jaeger + Prometheus + Grafana).
A telemetria é **opcional**: sem endpoint configurado nada do SDK é carregado e a API se comporta exatamente como antes.

## Como ligar

1. Suba o stack da ravena-ai: `cd ../ravena-ai && docker compose -f observability/docker-compose.yml up -d` (Jaeger UI em http://localhost:16686). Antes, crie `observability/.env` a partir do `.env.example` (senha do Grafana e, no Linux, `OTEL_BIND_ADDR=172.17.0.1`). Veja "Segurança" no `OBSERVABILITY.md` da ravena-ai: os traces têm o ID do jogador e a stack não pode ficar exposta.
2. No `.env` da raiz deste repo (o compose repassa para o container `api`):

   ```env
   OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
   ```
3. `docker compose up -d --build api`. No log deve aparecer `[otel] telemetria ligada → ...`.

Para desligar: apague `OTEL_EXPORTER_OTLP_ENDPOINT` ou defina `OTEL_SDK_DISABLED=true` e recrie o container.

### Versão do código na imagem (`GIT_SHA`)

`GET /internal/economy/params` devolve `version` com o commit da imagem, que a ravena guarda junto de cada
mudança de balanceamento detectada. Passe o commit no build (sem ele o build funciona e `version` vem `null`):
```bash
GIT_SHA=$(git rev-parse --short HEAD) docker compose build api && docker compose up -d api
```

## Variáveis

| Variável | Padrão | Uso |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | vazio (desligado) | Endpoint OTLP/HTTP do collector |
| `OTEL_SERVICE_NAME` | `jardim-das-sombras` | `service.name` |
| `OTEL_SDK_DISABLED` | vazio | `true` força desligado |
| `OTEL_LOG_LEVEL` | `error` | Nível do diag logger do SDK (só a 1ª linha, no máximo 1x/min por tipo de mensagem) |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | `NODE_ENV` | `deployment.environment.name` |

## Como funciona

- `api/src/instrumentation.ts` é carregado antes do servidor (`node --import ./dist/instrumentation.js dist/server.js`,
  no `CMD` do Dockerfile e no `npm start`). Sem endpoint, retorna sem importar nada do SDK.
- Falhas no bootstrap só geram `console.warn`. Collector fora do ar: o export falha em segundo plano
  (timeout 10 s, fila de 4096 spans que descarta o excedente) e as requisições não atrasam. O diag logger
  (`ThrottledDiagLogger` em `api/src/telemetryProcessors.ts`) imprime só a 1ª linha (sem stack) e repete cada tipo
  de mensagem no máximo 1x por minuto, com a contagem das suprimidas.
- Status de 4xx: o `@fastify/otel` marca `request` e `handler - *`/`preHandler - *` como ERROR (com a mensagem do erro)
  em todo erro lançado. O `FastifyClientErrorProcessor` (mesmo arquivo, antes do `BatchSpanProcessor`) corrige no
  `onEnd`: se o status HTTP do `request` é < 500, os filhos voltam para UNSET, o `request` vai para OK, a mensagem e o
  evento `exception` são removidos. 5xx continuam ERROR. `app.outcome`/`app.reject.reason` ficam só no span de
  negócio (`farm plant`...), nunca no `request`/`handler - *` (senão cada rejeição contava 3x no painel de rejeições).
  OK (e não UNSET) no `request` porque ele é INTERNAL e carrega `http.response.status_code`: com UNSET o Jaeger v2
  infere ERROR para span não-SERVER com status ≥ 400.
- Instrumentações: HTTP (server/client), undici (`fetch`), `@fastify/otel` (rotas com `http.route`; só o hook
  `preHandler` vira span), pino (`trace_id`/`span_id` nos logs JSON do Fastify), runtime do Node (event loop, heap, GC).
- Prisma: spans manuais `prisma {Model}.{operação}` (CLIENT) via `$extends`. O `@prisma/instrumentation` 5.22
  depende do SDK 1.x e quebra o processo com o SDK 2.x, por isso não é usado (nem `previewFeatures = ["tracing"]`).
- Propagação W3C `traceparent`: chamadas da ravena-ai continuam o mesmo trace; o aviso de colheita vira o span
  `notify harvest` (filho de `farm harvest`, termina depois dele porque é fire-and-forget) com o CLIENT
  `POST /api/games/fazenda/harvest` dentro, que continua na ravena-ai.
- Helpers em `api/src/telemetry.ts` (`withSpan`, `setAttrs`, `addEvent`, `recordError`, `userIdAttr`, `setRequestAttrs`, `isEnabled`).

## Privacidade

- Nunca vão para spans: nome de jogador/fazenda, textos livres, tokens, headers.
- O jogador entra como ID (telefone/ID da plataforma) em `jds.user.id`, via `userIdAttr`, para poder investigar
  um caso. Normalização igual à da ravena-ai: corta no primeiro `@` e no primeiro `:` (`5511…@c.us`,
  `5511…:3@s.whatsapp.net` e `5511…` viram `5511…`). Transferência: `jds.from_user.id`/`jds.to_user.id`.
  Por isso a stack de observabilidade só pode ficar acessível no próprio host.
- Hook global `preValidation` (server.ts) grava o ID de `user_id`/`userId` (params, corpo ou query) no span
  SERVER e no `request` de toda rota; rotas por UUID (`/farm/share/image`, `/farm?id=`) gravam após a busca.
- `url.path`: segmentos com ≥ 6 dígitos ou `@` viram `{id}` (a rota parametrizada fica em `http.route`).
- `url.query`: só parâmetros de render (`format`, `tooltips`, `planted_slots`...) mantêm o valor; `token`, `id`,
  `user_id`, `user_name`, `key`, `apiKey`, `auth` etc. viram `REDACTED`.
- Headers não são gravados. Prisma não grava argumentos de query.
- O collector ainda aplica uma segunda camada de mascaramento (ver `ravena-ai/observability`).

## Spans e atributos deste serviço

Atributos comuns aos 3 serviços: `app.outcome` = `ok` | `rejected` | `error` e `app.reject.reason` (código do
`DomainError` em minúsculas, ex. `insufficient_coins`, `not_ready_for_harvest`, `daily_already_claimed`).
Rejeição de negócio **não** marca span nenhum como ERROR (nem os do `@fastify/otel`) e a mensagem do `DomainError`
nunca é gravada (pode conter texto do usuário, ex. `Planta desconhecida: "<texto>"`); exceção inesperada marca
(`error.type` + exceção).

| Span | Atributos |
|---|---|
| `farm render` | `jds.render.kind` = farm/share/badge, `jds.render.cache` = hit/miss, `jds.render.format` = jpeg/png, `jds.render.bytes`, `jds.render.draw_ms`, `jds.render.encode_ms` |
| `canvas draw` | filho de `farm render` (só em miss): composição no canvas |
| `canvas encode` | filho de `farm render` (só em miss): `toBuffer`, `jds.render.format`, `jds.render.bytes` |
| `farm plant` | `jds.plant.random`, `jds.plant.count`, `jds.plant.id` (ID do catálogo); `witherMultiplier` sem a API_KEY vira `app.outcome=rejected` com `app.reject.reason=forbidden`, e fora do alcance de uma data, `invalid_payload` |
| `farm harvest` | `jds.harvest.all`, `jds.harvest.items`, `jds.harvest.plant_types`, `jds.harvest.withered_cleared`, `jds.harvest.coins`, `jds.notify.attempted` (houve POST) ou `jds.notify.sent=false` + `jds.notify.skip_reason` (empty/disabled/no_key) |
| `farm plant tx` | transação do plantio (inclui BEGIN/COMMIT): `jds.plant.count`; filhos `farm plant tx.begin`/`.write`/`.commit` |
| `farm harvest tx` | transação interativa do Prisma (inclui BEGIN/COMMIT): `jds.harvest.slots_reset`, `jds.harvest.plant_types`; filhos `farm harvest tx.begin` (BEGIN), `.write` (corpo, com os `prisma *`) e `.commit` (COMMIT) — helper `withTxSpans` |
| `notify harvest` | `jds.notify.status_code`, `jds.notify.sent` (true só em 2xx), `app.outcome` (ok / rejected em 4xx / error em 5xx ou falha de rede, com `error.type`), `jds.notify.plant_types`, `server.address` |
| `farm daily` | `jds.daily.coins`, `jds.daily.items` |
| `farm sell` | `jds.sell.all`, `jds.sell.items`, `jds.sell.coins` |
| `farm use` | — |
| `farm decorate` | `jds.decorate.op` = equip/unequip/batch, `jds.decorate.count` |
| `shop buy` | `jds.shop.quantity`, `jds.shop.item_id`, `jds.shop.cost` |
| `inventory get` | `jds.inventory.found`, `jds.inventory.items` |
| `economy summary` | `GET /internal/economy/summary` (painel da economia): `jds.economy.window_ms`, `jds.economy.full_history` (from=0), `jds.economy.balances` (false com `balances=0`), `jds.economy.accounts` e `jds.economy.holders` (ausentes com `balances=0`), `jds.economy.ledger_available` (false: o Jardim ainda não tem extrato). Sem ID de jogador; parâmetro inválido vira `app.outcome=rejected` |
| `economy players` | `GET /internal/economy/players` (saldo por jogador para o painel): `jds.economy.window_ms`, `jds.economy.players` (quantos jogadores com saldo diferente de zero). Os IDs ficam só na resposta, nunca no span; parâmetro inválido vira `app.outcome=rejected` |
| `economy params` | `GET /internal/economy/params` (parâmetros de balanceamento para o painel): `jds.economy.params` (quantos parâmetros a rota devolveu). Sem ID de jogador |
| `prisma {Model}.{op}` | `db.system.name`, `db.operation.name`, `db.collection.name` |

Todos os spans de negócio e os spans SERVER das rotas por usuário têm `jds.user.id`.

## Consultas prontas no Jaeger (http://localhost:16686, serviço `jardim-das-sombras`)

- Renders lentos: operação `farm render`, tags `jds.render.cache=miss`, Min Duration `50ms`.
- Encode bloqueando o event loop: operação `canvas encode` (tag `jds.render.format=jpeg`) ordenada por duração.
- Rejeições: tags `app.outcome=rejected` (ou `app.reject.reason=insufficient_coins`).
- Erros reais: tags `error=true`.
- Colheita → bot: operação `notify harvest`, tag `jds.notify.sent=true` (o trace segue para `ravena-ai`);
  aviso recusado pela ravena: `notify harvest` com `jds.notify.sent=false` (ver `jds.notify.status_code`).
- Um jogador: tag `jds.user.id=5511999999999` (mesmo valor de `ravena.user.id` na ravena-ai).
- Correlacionar log: `docker logs jardim-api | grep <trace_id>`.

## Limitações

- `canvas.toBuffer` é síncrono: o span `canvas encode` mostra o custo, mas não o reduz. No @napi-rs/canvas o desenho
  é adiado e quase todo o custo aparece no encode (`canvas draw` fica perto de 0–3 ms).
- A correção de status 4xx muda o objeto do span já entregue ao batch (os filhos terminam antes do `request`). O
  batch exporta a cada 2 s, então na prática a correção chega antes; num export disparado exatamente nesse
  intervalo de microssegundos (fila com 512 spans), um `handler - *` poderia sair ainda como ERROR.
- Em 4xx do `@fastify/otel` sem `DomainError` (ex.: 404 de rota, JSON inválido), o código vem do `exception.type`
  (ex. `fst_err_ctp_invalid_json_body`).
- O `setErrorHandler` do `server.ts` é definido depois do registro dos plugins de rota, então hoje ele não é
  aplicado a essas rotas (comportamento já existente, não alterado). 5xx nelas aparecem como erro pelos spans
  HTTP/@fastify/otel.
- Overhead medido (200 requisições sequenciais, local): rotas baratas (~3 ms) ganham ~0,6–1 ms; o render (~27 ms) ~+1,3 ms.
- Sem logs via OTLP (só `trace_id` no stdout); sem Loki.
