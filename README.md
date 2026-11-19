# MailPilot

MailPilot é uma prova de conceito de automação inteligente de e-mails.

O sistema recebe uma mensagem, usa IA para identificar assunto e prioridade, encaminha para o time correto e sugere uma resposta. A pessoa responsável pode revisar, editar, aprovar ou rejeitar o rascunho. **Nenhum e-mail é enviado automaticamente.**

## Acesso à demonstração

Use estas credenciais somente para a demonstração:

```text
E-mail: test@gmail.com
Senha: Password123!
```
LINK: https://mailpilot-beta-woad.vercel.app/


![n8n workflow diagram](docs/images/workflows/workflow.png)

![Inbox do MailPilot](docs/images/dashboard/inbox.png)
## O que a demonstração mostra

- Inbox com classificação, prioridade, time responsável e resumo.
- Fila de revisão para rascunhos gerados pela IA.
- Analytics com dados reais salvos no PostgreSQL.
- Monitoramento de filas, tentativas, SLA e falhas.
- Recuperação automática quando o n8n fica indisponível.
- Cinco workflows n8n documentados com imagens reais do canvas.

## Arquitetura

```mermaid
flowchart LR
    Browser[Navegador] --> Web[Next.js]
    Web --> API[API Go]
    API <--> DB[(PostgreSQL)]
    API --> Intake[n8n: entrada de e-mail]
    Intake --> AI[n8n: processamento com IA]
    AI <--> OR[OpenRouter]
    Intake --> API
    SLA[n8n: SLA] <--> API
    Recovery[n8n: recuperação] <--> API
    Recovery --> Intake
    Error[n8n: monitor de erros] --> API
```

Em resumo: o Go salva o e-mail, o n8n coordena a automação, o OpenRouter fornece a IA e o dashboard mostra o resultado para revisão humana.

## Tecnologias

- Next.js, TypeScript, Tailwind CSS e shadcn/ui
- API REST em Go
- PostgreSQL
- n8n
- OpenRouter
- Docker Compose para desenvolvimento local

## Workflows n8n

As imagens foram capturadas do n8n e mostram os nós e suas conexões.

### Entrada de e-mail

![Workflow de entrada](docs/images/workflows/01-email-intake.png)

Recebe o webhook, valida os campos e inicia o processamento. [JSON](n8n/workflows/01-email-intake.json)

### Processamento com IA

![Workflow de processamento](docs/images/workflows/02-ai-processing.png)

Classifica billing, support, sales ou general, define a prioridade, escolhe o time e gera o rascunho. [JSON](n8n/workflows/02-ai-processing.json)

### Escalonamento de SLA

![Workflow de SLA](docs/images/workflows/03-sla-escalation.png)

Verifica mensagens atrasadas e cria uma notificação. [JSON](n8n/workflows/03-sla-escalation.json)

### Recuperação de mensagens em fila

![Workflow de recuperação](docs/images/workflows/04-queued-email-recovery.png)

Tenta novamente mensagens pendentes, com limite de tentativas e backoff. [JSON](n8n/workflows/04-queued-email-recovery.json)

### Monitor de erros

![Workflow de erros](docs/images/workflows/05-error-monitor.png)

Registra falhas inesperadas sem salvar chaves ou o conteúdo completo do e-mail. [JSON](n8n/workflows/05-error-monitor.json)

## Telas da aplicação

| Inbox | Fila de revisão |
| --- | --- |
| ![Inbox](docs/images/dashboard/inbox.png) | ![Fila de revisão](docs/images/dashboard/review-queue.png) |

| Analytics | Automações |
| --- | --- |
| ![Analytics](docs/images/dashboard/analytics.png) | ![Automações](docs/images/dashboard/automations.png) |

![Detalhes de um e-mail](docs/images/dashboard/email-detail.png)

## Limitações da prova de conceito

- O envio real de e-mails está desativado.
- A autenticação é simples e voltada para demonstração.
- O projeto ainda precisa de configuração de produção, backups e observabilidade de uma aplicação pública.
- Os dados da demonstração são fictícios.

## Estrutura principal

```text
apps/web/              Dashboard Next.js
services/api/          API Go e migrations
n8n/workflows/         Workflows exportados
n8n/tests/              Testes de integração
docs/images/           Imagens do dashboard e dos workflows
docker-compose.yml     Ambiente local
```
