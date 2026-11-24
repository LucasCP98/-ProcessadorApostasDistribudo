# Processador Distribuído de Apostas (*Distributed Wager Processor*)

Serviço em NestJS para processamento de apostas em carteira com PostgreSQL, razão (*ledger*) imutável, idempotência e entrega de comandos/eventos baseada em SQS.

## Requisitos

- Bun 1.x
- Docker Compose

## Configuração local

```powershell
bun install
docker compose up -d
$env:NODE_ENV = "development"
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/wagering_db"
$env:SQS_ENDPOINT = "http://localhost:4566"
bun run db:migrate
bun run start:dev
```

A aplicação lê variáveis de ambiente do processo; ela não carrega arquivos `.env` por conta própria. Veja o [.env.example](./.env.example) para valores apenas locais. Nunca copie suas credenciais para *staging* ou produção.

O serviço cria a fila FIFO `wager-transactions.fifo` e sua DLQ FIFO `wager-transactions-dlq.fifo`, além da fila padrão `wagering-events` no LocalStack. Os comandos são agrupados por carteira e deduplicados por chave de idempotência mais *hash* do *payload*. `db:migrate` atualiza o esquema existente e preenche retroativamente (*backfills*) uma transação `OPENING` e um lançamento no *ledger* para o saldo inicial não contabilizado de cada carteira legada. Ele não reseta nem apaga dados existentes de carteiras ou apostas.

Para a AWS, omita `SQS_ENDPOINT`, defina `SQS_QUEUES_AUTO_CREATE=false` e configure a região e credenciais normais da AWS pela cadeia de credenciais do AWS SDK. Defina `DATABASE_URL` para a instância PostgreSQL de destino.

## API

- `POST /wagering/wallets` cria uma carteira e, quando o saldo inicial é positivo, registra-o como uma transação `OPENING` e crédito no *ledger*.
- `POST /wagering/transactions` processa uma transação de forma síncrona.
- `POST /wagering/transactions/queue` aceita um comando com HTTP `202`; o *worker* do SQS o processa de forma assíncrona.
- `GET /wagering/wallets/:walletId` retorna o estado da carteira.
- `GET /wagering/wallets/:walletId/ledger?limit=100&offset=0` retorna uma página de lançamentos imutáveis do *ledger*.
- `GET /wagering/transactions/:transactionId` retorna uma transação e seu resultado armazenado.
- `POST /wagering/reconcile` verifica todas as carteiras; envie `{"walletId":"..."}` para verificar uma carteira.
- `POST /wallets/:walletId/reconciliation` compara o saldo armazenado da carteira com o *ledger* sem alterar nenhum dos dois. Retorna `walletId`, `storedBalance`, `calculatedBalance`, `difference` (*stored* menos *calculated*), `consistent` e `checkedEntries`; valores monetários são *strings* decimais com duas casas fracionárias.
- `GET /health/live` verifica se o processo está ativo (*liveness*).
- `GET /health/ready` verifica se o PostgreSQL e o SQS estão prontos (*readiness*).
- `GET /metrics` expõe métricas do Prometheus de processo, HTTP, carteira, aposta, SQS e *outbox*.

Requisições de transação aceitam `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. O cabeçalho opcional `Idempotency-Key` tem como padrão os IDs do provedor e da transação externa. Reutilizar uma identidade com um *payload* diferente retorna HTTP `409`.

O serviço não implementa autenticação de aplicação. Coloque-o atrás de um *API gateway* aprovado com ciência de identidade ou adicione o módulo padrão de autenticação do NestJS da implantação antes de expô-lo publicamente.

## Implantação em produção

Antes do uso público ou em produção:

- Configure o *gateway* com ciência de identidade e restrinja o acesso direto ao serviço.
- Use TLS para o PostgreSQL e credenciais gerenciadas pela AWS com acesso SQS de menor privilégio; não faça *commit* de credenciais nem exponha o *endpoint* do LocalStack.
- Defina `NODE_ENV` explicitamente como `staging` ou `production` e configure `DATABASE_URL`; um `NODE_ENV` não definido também é tratado como não local. `POSTGRES_SSL` vem habilitado por padrão fora de *development*/*test* e não pode ser desabilitado nesses ambientes; defina `POSTGRES_SSL_CA_FILE` quando uma CA privada for necessária. Evite desabilitar ou enfraquecer o TLS por parâmetros de *query* na `DATABASE_URL` (`sslmode` é aceito apenas como `verify-full`). O *logging* de depuração SQL é habilitado apenas em *development*/*test*.
- Ajuste `POSTGRES_POOL_MIN`, `POSTGRES_POOL_MAX`, `POSTGRES_POOL_IDLE_TIMEOUT_MS`, `POSTGRES_CONNECTION_TIMEOUT_MS`, `POSTGRES_QUERY_TIMEOUT_MS`, `POSTGRES_STATEMENT_TIMEOUT_MS` e `POSTGRES_LOCK_TIMEOUT_MS` conforme a capacidade do banco de *staging* e a duração das *migrations*.
- Crie previamente as filas FIFO `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, além da fila de eventos, via infraestrutura como código (*IaC*) e defina `SQS_QUEUES_AUTO_CREATE=false`. O serviço verifica os atributos FIFO da fila de comandos/DLQ e o destino de *redrive*. Conceda ao serviço apenas `sqs:GetQueueUrl`, `sqs:GetQueueAttributes`, `sqs:SendMessage`, `sqs:ReceiveMessage` e `sqs:DeleteMessage` nas filas configuradas. Configure a política de *redrive* da fila de comandos para a DLQ FIFO com máximo de cinco recebimentos e *visibility timeout* de 45 segundos.
- Mantenha o *visibility timeout* da fila alinhado com `SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS` (padrão `45`); o *worker* aplica esse valor ao receber mensagens.
- No *shutdown*, o *worker* para de fazer *polling* e drena o trabalho em andamento por até `SQS_WORKER_SHUTDOWN_TIMEOUT_MS` (padrão `25000`) antes de fechar o SQS; configure o período de carência de encerramento (*termination grace period*) do orquestrador de acordo.
- Monitore `/health/ready`, contadores de resultado de transações, falhas de comandos SQS, falhas de publicação do *outbox* e a DLQ de comandos. Configure alertas e retenção na plataforma de implantação.
- Adicione a integração de *tracing*/APM da implantação se rastreamentos distribuídos forem necessários; este repositório expõe métricas e *logs* estruturados de erro do *worker*, mas não provisiona conta ou credenciais do Observe/APM.

## Migrations do banco de dados

```powershell
bun run db:migrate
bun run db:migrate:down
```

Revise e faça *backup* de um banco de produção antes de aplicar ou reverter *migrations*. `db:migrate:down` reverte a *migration* mais recente; a *migration* atual remove apenas colunas de *correlation*/*causation*/*version*. Reverter a *migration* fundacional também remove lançamentos iniciais gerados e recursos do esquema, portanto é destinada apenas a *rollback* controlado, não a limpeza rotineira local.

## Testes e verificações

```powershell
bun run test
bun run test:e2e
bun run test:all
bun run lint
bun run typecheck
bun run build
```

`test:all` executa os testes unitários e em seguida os testes E2E. Os testes E2E exigem o banco PostgreSQL com *migrations* aplicadas e o LocalStack; eles criam carteiras e transações de teste com nomes únicos e deixam esses registros no banco. A suíte cobre apostas concorrentes contra uma mesma carteira, reconciliação, `LOSS` e `ROLLBACK` fora de ordem, comportamento de *retry*/DLQ no SQS, reentrega após queda simulada antes do `ACK`, publicadores de *Outbox* concorrentes e recuperação após reinício do *worker*.

Veja [ARCHITECTURE.md](./ARCHITECTURE.md) para detalhes de consistência e mensageria.