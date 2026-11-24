# Instruções para agentes de IA — Jardim das Sombras

As regras para agentes ficam no [`CONTRIBUTING.md`](CONTRIBUTING.md), seção 2. Leia antes de mudar qualquer coisa. Em especial:

- **§2.3 Verificação obrigatória:** `npm test` e `npx tsc --noEmit` em `api/` (e `bot/`), docs de rota em `README.md` e `docs/INTEGRATION.md`.
- **§2.4 Telemetria OpenTelemetry:** toda rota, serviço ou fluxo novo sai instrumentado; spans novos vão no [`OBSERVABILITY.md`](OBSERVABILITY.md).
- **§2.5 Mudanças de balanceamento da economia:** o que conta como mudança, como manter as constantes na rota `GET /internal/economy/params` e como registrar depois do deploy.
- **§2.6 Coordenação (Board + ai-memory):** antes de começar uma tarefa, confira o board [`ravena-ai cabritos`](https://github.com/users/moothz/projects/2) (`gh project item-list 2 --owner moothz`) e consulte o `ai-memory` sobre o tema; ao começar, assuma a issue e mova para `In progress`; ao abrir o PR, referencie `Closes #N`. Dúvida entre agentes: coluna `Aguardando resposta`, lida no início da sessão.

Integração com a ravena-ai: [`docs/INTEGRATION.md`](docs/INTEGRATION.md). Rotas consumidas pela ravena não podem quebrar o contrato.
