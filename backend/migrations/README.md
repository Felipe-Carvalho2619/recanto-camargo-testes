# Migrations — Recanto Camargo

Diretório onde vivem o baseline estrutural e o histórico de migrations do backend.

---

## 1. Baseline estrutural

Arquivo: [`baseline/20261117_001_schema.sql`](baseline/20261117_001_schema.sql)

**Objetivo:** construir um schema vazio do Recanto Camargo com as 16 tabelas
atuais (112 colunas, 42 índices, 21 foreign keys, 0 CHECK constraints), sem
nenhum dado operacional ou pessoal.

**Origem estrutural:** blocos `CREATE TABLE` do dump SQL
`D:/Downloads/recanto-camargo/docs/recanto_camargo_database_dump.sql`.
A procedência declarada desse dump (exportação de nuvem) **não foi comprovada**
e não é afirmada aqui. O que foi comprovado é a estrutura: na Fase 2.2b o dump
foi comparado com o banco local `recanto_camargo` e apresentou **0 divergências
estruturais** (16/112/42/21/0).

**Data de consolidação:** 17/11/2026.

**Requisito:** MySQL 8.0. A collation `utf8mb4_0900_ai_ci` não existe em MariaDB.

**Charset/collation adotados:** `utf8mb4` / `utf8mb4_0900_ai_ci`, declarados
explicitamente em cada tabela. Engine `InnoDB` em todas.

**Estado representado:** pós-M1 e pós-M2 — inclui a tabela `not_notificacao`
(M1) e as colunas `imo_imovel.Imo_ValorFimSemana` e
`hit_historicovalores.Hit_Tipo` (M2).

**Conteúdo:** 17 instruções — 1 instrução de sessão `SET NAMES utf8mb4;` e 16
instruções `CREATE TABLE`. O `SET NAMES utf8mb4` é necessário para preservar a
interpretação correta dos identificadores com caracteres acentuados
(`fk_Ava_Avaliação_*`, presentes em índices e constraints); sem ele, um cliente
com charset diferente pode corrompê-los. A instrução não altera o schema e não
substitui a exigência de o cliente estar em UTF-8.

Não há `CREATE DATABASE`, `USE`, `DROP TABLE`, `TRUNCATE`, `IF NOT EXISTS`,
`SELECT`, `ALTER` ou qualquer DML.

---

## 2. Regras de aplicação

### 2.1 Precondição: schema vazio e seleção explícita

O baseline exige um schema **vazio**. Não há `IF NOT EXISTS`: a primeira tabela
já existente faz a aplicação falhar imediatamente, o que é intencional para
evitar aplicação dupla ou sobreposição silenciosa.

O arquivo **não contém `USE`** e **não qualifica os nomes de tabela com
schema** (`schema.tabela`). Consequência direta: as 16 tabelas são criadas no
**schema corrente da conexão**, seja ele qual for.

Antes de executar, o operador deve:

1. Confirmar explicitamente o nome do schema de destino.
2. Confirmar que esse schema é o ambiente descartável/autorizado.
3. Confirmar que esse schema está vazio.
4. Selecionar explicitamente esse schema na ferramenta SQL (por exemplo,
   `USE <schema>;` no Workbench ou escolha no painel de schemas) **antes** de
   executar o baseline.
5. Conferir novamente, imediatamente antes da execução, qual schema está
   selecionado.

Selecionar o schema errado pode produzir uma **execução bem-sucedida no banco
errado**: em um schema vazio que não seja o pretendido, o baseline cria as 16
tabelas sem nenhum erro. A única proteção que o arquivo oferece é falhar quando
as tabelas já existem — ele não valida o nome do schema.

`recanto_camargo_dev` é o destino **planejado** para a futura infraestrutura de
QA, mas **ainda não existe no ambiente local** (Fase 2.2). Ele só pode ser
usado após criação e autorização específicas.

### 2.2 Aplicar o baseline **ou** o histórico — nunca ambos

- Em schema vazio, aplicar **somente** `baseline/20261117_001_schema.sql`.
- As migrations `20260904_001_not_notificacao.sql` (M1) e
  `20261103_001_recanto2_precos.sql` (M2) estão **absorvidas** pelo baseline.
- **Nunca executar M1 nem M2 depois do baseline.** Essa proibição é
  **operacional e documental**: não existe proteção automática no SQL que
  impeça a combinação. O que aconteceria, para registro:
  - **M1** usa `CREATE TABLE IF NOT EXISTS \`not_notificacao\``. Com a tabela
    já existente, a instrução **não falha** — ela é ignorada silenciosamente.
    Isso **não** garante que a estrutura existente corresponda ao esperado: a
    M1 não verifica nada e não emite erro que sinalize aplicação dupla.
  - **M2** começa com dois `ALTER TABLE ... ADD COLUMN`, que **não são
    idempotentes**. Num schema pós-baseline eles falham, porque
    `imo_imovel.Imo_ValorFimSemana` e `hit_historicovalores.Hit_Tipo` já
    existem.
  - **M2 também contém DML** (`UPDATE` e `INSERT ... SELECT`) **posterior** aos
    dois `ALTER TABLE`.
  - Clientes e scripts SQL **não são obrigados a interromper** a execução ao
    encontrar erro. Se continuarem, esses comandos DML podem ser executados
    mesmo depois da falha dos `ALTER`, sobre qualquer dado que exista no
    schema.
  - Não há rollback automático e nada é atômico: DDL faz commit implícito.
- O histórico permanece no repositório apenas como registro; **não é um caminho
  de reconstrução**.

### 2.3 O histórico não reconstrói o schema desde o zero

A cadeia M1 → M2 cobre **1 de 16 tabelas** e **2 de 112 colunas**. Não existe
histórico versionado das outras 15 tabelas. Portanto, M1 + M2 **não** produzem
um schema funcional partindo de um banco vazio.

### 2.4 Atomicidade

O baseline **não é atomicamente executável**. O MySQL faz commit implícito em
DDL; uma falha no meio da aplicação pode deixar tabelas parcialmente criadas.
Nesse caso, descartar o schema e recriar do zero — nunca completar à mão.

### 2.5 Uso em banco existente

**Não aplicar diretamente em banco existente.** O baseline não detecta nem
preserva estado; ele foi desenhado para criação limpa. Bancos com dados
operacionais (por exemplo `recanto_camargo`) não devem receber este arquivo.

### 2.6 Dados pessoais

O baseline não contém dados pessoais ou operacionais. O dump de origem contém
`INSERT`s com dados sensíveis; esses blocos **não** foram copiados, e futuras
extrações devem seguir a mesma regra.

---

## 3. O que este diretório não é

- **Não é um runner de migrations.** Não há executor, ledger, tabela de
  controle ou script npm que aplique estes arquivos. A execução é manual e
  deliberada. Antes da Fase 2.3a foi confirmado que o projeto nunca teve runner
  versionado.
- **Não é um pipeline de deploy.** Não existe CI/CD que aplique SQL.
- **Não é um dump de dados.** Nenhum arquivo aqui contém registros.

---

## 4. Processo para futuras alterações estruturais

1. Toda mudança de schema deve ser registrada em arquivo próprio, com nome
   `YYYYMMDD_NNN_objetivo.sql`, e versionada explicitamente.
2. A regra global `*.sql` no `.gitignore` da raiz ignora arquivos novos por
   padrão. Cada migration ou baseline precisa de uma exceção nominal
   (`!caminho/arquivo.sql`). Não ampliar a exceção além do necessário.
3. Não alterar M1 nem M2: são registro histórico e já estão absorvidas.
4. Não editar o baseline para refletir mudanças novas. O baseline é um retrato
   datado; a evolução acontece em migrations incrementais.
5. Qualquer aplicação exige autorização explícita e validação do ambiente antes
   de tocar em banco.

---

## 5. Estado de validação

O baseline foi validado **estaticamente** (contagens, ordem de FKs, ausência de
DML, equivalência estrutural com a fonte e com M1/M2). Ele **não foi executado
em MySQL** até o momento desta consolidação; a validação por execução pertence
a uma fase posterior, com autorização própria.
