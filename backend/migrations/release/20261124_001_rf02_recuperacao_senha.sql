-- =============================================================================
-- RF02 - RECUPERACAO DE SENHA - RELEASE CANDIDATE INCREMENTAL ADITIVA
-- =============================================================================
-- Data do artefato: 24/11/2026.
-- Origem validada em QA: 20261123_001_rf02_recuperacao_senha.sql
-- SHA-256 da origem: a7df319c1e435edd1bb84b75bac28d14930d682159b67ed780722876565ee865
-- Destino futuro: MySQL 8.0, em schema explicitamente aprovado pelo responsavel,
-- com estrutura compativel com baseline/20261117_001_schema.sql.
-- Esta preparacao e a validacao local NAO autorizam DDL real. Execucao em banco
-- operacional exige autorizacao humana especifica, janela, backup restauravel e
-- confirmacao imediata de DATABASE(); nenhuma execucao remota faz parte deste pacote.
-- Nao aplicar M1/M2 apos o baseline. Nao aplicar o baseline em banco existente.
--
-- Gate E: este arquivo nao autoriza execucao por sua presenca no repositorio.
-- Aplicar manualmente uma unica vez por release, sem --force e sem concorrencia
-- com esta migration ou seu rollback. Nao existe runner/ledger; registrar no
-- chamado de mudanca artefato, hash, schema, operador, horario e resultado.
-- Manter backend/worker RF02 parado ou desabilitado ate a validacao pos-apply.
--
-- Escopo: cria somente rf02_recuperacao_senha e rf02_rate_limit.
-- Nao contem DML, backfill, ALTER, dados, segredos ou campos de sessao.
-- DI-09/RS-02 continuam fora deste artefato; nenhuma sessao/JWT e alterada.
--
-- Idempotencia segura:
--   1. Valida DATABASE(), MySQL 8 e a FK de referencia usu_usuario.Usu_Id.
--   2. Se uma tabela-alvo ja existir, valida antes de qualquer criacao pendente
--      colunas, ordem, tipos, defaults, indices, FK, engine e collation.
--   3. Estrutura divergente, CHECK, FK ou trigger adicional causa SIGNAL; a
--      divergencia nunca e ocultada por CREATE TABLE IF NOT EXISTS.
--   4. Se estiver ausente, cria a tabela e repete toda a validacao ao final.
--   5. Reexecucao sequencial sobre estrutura exata e no-op de recuperacao, nao
--      substituto do controle manual de apply unico na release.
--
-- A rotina auxiliar exclusiva 20261124 e removida apos sucesso. Se o cliente
-- interromper em erro, ela pode permanecer para diagnostico; a reexecucao a
-- substitui e o rollback release a remove. Isso exige privilegio temporario de
-- CREATE ROUTINE no QA isolado ou o privilegio aprovado na janela de release.
-- DDL MySQL tem commit implicito: em falha parcial, interromper o deploy,
-- reinspecionar e seguir recuperacao autorizada; nao completar manualmente.
--
-- Retencao (implementada futuramente pelo backend/worker, nao por esta migration):
-- manter registros terminais apenas pelo prazo minimo aprovado; expurgar registros
-- expirados e janelas de rate limit vencidas. Nenhum EVENT e criado aqui.
-- =============================================================================

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_rf02_20261124_001_guard`$$

CREATE PROCEDURE `_rf02_20261124_001_guard`()
BEGIN
  DECLARE v_t1_exists INT DEFAULT 0;
  DECLARE v_t2_exists INT DEFAULT 0;
  DECLARE v_pass INT DEFAULT 0;
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_actual LONGTEXT;
  DECLARE v_expected LONGTEXT;

  IF DATABASE() IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RF02 release: selecione explicitamente o schema aprovado';
  END IF;

  IF SUBSTRING_INDEX(VERSION(), '.', 2) <> '8.0' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RF02: a migration exige MySQL 8.0';
  END IF;

  -- A tabela referenciada deve ser a do baseline, com PK INT compativel.
  SELECT COUNT(*) INTO v_count
    FROM information_schema.TABLES t
    JOIN information_schema.COLUMNS c
      ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
     AND c.TABLE_NAME = t.TABLE_NAME
    JOIN information_schema.STATISTICS s
      ON s.TABLE_SCHEMA = t.TABLE_SCHEMA
     AND s.TABLE_NAME = t.TABLE_NAME
   WHERE t.TABLE_SCHEMA = DATABASE()
     AND t.TABLE_NAME = 'usu_usuario'
     AND t.TABLE_TYPE = 'BASE TABLE'
     AND t.ENGINE = 'InnoDB'
     AND c.COLUMN_NAME = 'Usu_Id'
     AND c.DATA_TYPE = 'int'
     AND c.COLUMN_TYPE NOT LIKE '%unsigned%'
     AND c.IS_NULLABLE = 'NO'
     AND s.INDEX_NAME = 'PRIMARY'
     AND s.NON_UNIQUE = 0
     AND s.SEQ_IN_INDEX = 1
     AND s.COLUMN_NAME = 'Usu_Id';

  IF v_count <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RF02: usu_usuario.Usu_Id INT/PK do baseline nao encontrado';
  END IF;

  SELECT COUNT(*) INTO v_t1_exists
    FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'rf02_recuperacao_senha';

  SELECT COUNT(*) INTO v_t2_exists
    FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'rf02_rate_limit';

  SET SESSION group_concat_max_len = 32768;

  -- Duas passagens: prevalida tudo que existe, cria apenas o ausente e
  -- posteriormente repete as mesmas verificacoes nas duas tabelas.
  WHILE v_pass < 2 DO
    IF v_t1_exists = 1 THEN
      SELECT COUNT(*) INTO v_count
        FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'rf02_recuperacao_senha'
         AND TABLE_TYPE = 'BASE TABLE'
         AND ENGINE = 'InnoDB'
         AND TABLE_COLLATION = 'utf8mb4_0900_ai_ci';

      IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: tabela/engine/collation divergentes em recuperacao_senha';
      END IF;

      SELECT GROUP_CONCAT(
               CONCAT_WS('#',
                 ORDINAL_POSITION, COLUMN_NAME, DATA_TYPE, IS_NULLABLE,
                 CONCAT('DEFAULT=', IFNULL(COLUMN_DEFAULT, '<NULL>')),
                 IF(DATA_TYPE IN ('bigint', 'int', 'tinyint'),
                    IF(COLUMN_TYPE LIKE '%unsigned%', 'unsigned', 'signed'), '-'),
                 IF(DATA_TYPE IN ('binary', 'varbinary', 'char', 'varchar'),
                    IFNULL(CHARACTER_MAXIMUM_LENGTH, '-'), '-'),
                 IF(DATA_TYPE IN ('datetime', 'timestamp', 'time'),
                    IFNULL(DATETIME_PRECISION, '-'), '-'),
                 IFNULL(CHARACTER_SET_NAME, '-'),
                 IFNULL(COLLATION_NAME, '-'),
                 IFNULL(NULLIF(EXTRA, ''), '-')
               ) ORDER BY ORDINAL_POSITION SEPARATOR '|'
             ) INTO v_actual
        FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'rf02_recuperacao_senha';

      SET v_expected = CONCAT_WS('|',
        '1#id#bigint#NO#DEFAULT=<NULL>#unsigned#-#-#-#-#auto_increment',
        '2#usuario_id#int#YES#DEFAULT=<NULL>#signed#-#-#-#-#-',
        '3#nonce#binary#NO#DEFAULT=<NULL>#-#32#-#-#-#-',
        '4#token_hash#binary#NO#DEFAULT=<NULL>#-#32#-#-#-#-',
        '5#criado_em#datetime#NO#DEFAULT=<NULL>#-#-#3#-#-#-',
        '6#expira_em#datetime#NO#DEFAULT=<NULL>#-#-#3#-#-#-',
        '7#consumido_em#datetime#YES#DEFAULT=<NULL>#-#-#3#-#-#-',
        '8#invalidado_em#datetime#YES#DEFAULT=<NULL>#-#-#3#-#-#-',
        '9#email_estado#varchar#NO#DEFAULT=<NULL>#-#20#-#utf8mb4#utf8mb4_0900_ai_ci#-',
        '10#tentativas#tinyint#NO#DEFAULT=0#unsigned#-#-#-#-#-',
        '11#proxima_tentativa_em#datetime#NO#DEFAULT=<NULL>#-#-#3#-#-#-',
        '12#processando_ate#datetime#YES#DEFAULT=<NULL>#-#-#3#-#-#-',
        '13#enviado_em#datetime#YES#DEFAULT=<NULL>#-#-#3#-#-#-',
        '14#ultima_falha#varchar#YES#DEFAULT=<NULL>#-#40#-#utf8mb4#utf8mb4_0900_ai_ci#-',
        '15#atualizado_em#datetime#NO#DEFAULT=<NULL>#-#-#3#-#-#-'
      );

      IF v_actual IS NULL OR v_actual <> v_expected THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: colunas divergentes em rf02_recuperacao_senha';
      END IF;

      SELECT COUNT(*) INTO v_count
        FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'rf02_recuperacao_senha';

      IF v_count <> 11 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: quantidade de indices divergente em recuperacao_senha';
      END IF;

      SELECT COUNT(*) INTO v_count
        FROM (
          SELECT 'PRIMARY' AS index_name, 0 AS non_unique, 1 AS seq, 'id' AS column_name
          UNION ALL SELECT 'idx_rf02_recuperacao_cleanup', 1, 1, 'expira_em'
          UNION ALL SELECT 'idx_rf02_recuperacao_cleanup', 1, 2, 'atualizado_em'
          UNION ALL SELECT 'idx_rf02_recuperacao_consumo', 1, 1, 'usuario_id'
          UNION ALL SELECT 'idx_rf02_recuperacao_consumo', 1, 2, 'consumido_em'
          UNION ALL SELECT 'idx_rf02_recuperacao_consumo', 1, 3, 'invalidado_em'
          UNION ALL SELECT 'idx_rf02_recuperacao_worker', 1, 1, 'email_estado'
          UNION ALL SELECT 'idx_rf02_recuperacao_worker', 1, 2, 'processando_ate'
          UNION ALL SELECT 'idx_rf02_recuperacao_worker', 1, 3, 'proxima_tentativa_em'
          UNION ALL SELECT 'uk_rf02_recuperacao_nonce', 0, 1, 'nonce'
          UNION ALL SELECT 'uk_rf02_recuperacao_token_hash', 0, 1, 'token_hash'
        ) e
        LEFT JOIN information_schema.STATISTICS s
          ON s.TABLE_SCHEMA = DATABASE()
         AND s.TABLE_NAME = 'rf02_recuperacao_senha'
         AND s.INDEX_NAME = e.index_name
         AND s.NON_UNIQUE = e.non_unique
         AND s.SEQ_IN_INDEX = e.seq
         AND s.COLUMN_NAME = e.column_name
         AND s.INDEX_TYPE = 'BTREE'
         AND s.IS_VISIBLE = 'YES'
         AND s.COLLATION = 'A'
         AND s.SUB_PART IS NULL
       WHERE s.TABLE_NAME IS NULL;

      IF v_count <> 0 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: indices divergentes em rf02_recuperacao_senha';
      END IF;

      -- Exatamente uma FK; nenhum CHECK adicional. UNIQUE/PK foram validados acima.
      SELECT COUNT(*) INTO v_count
        FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE()
         AND TABLE_NAME = 'rf02_recuperacao_senha'
         AND CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK');

      IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: FK/CHECK divergentes em rf02_recuperacao_senha';
      END IF;

      SELECT COUNT(*) INTO v_count
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
         AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       WHERE k.CONSTRAINT_SCHEMA = DATABASE()
         AND k.TABLE_NAME = 'rf02_recuperacao_senha'
         AND k.CONSTRAINT_NAME = 'fk_rf02_recuperacao_usuario'
         AND k.ORDINAL_POSITION = 1
         AND k.COLUMN_NAME = 'usuario_id'
         AND k.REFERENCED_TABLE_NAME = 'usu_usuario'
         AND k.REFERENCED_COLUMN_NAME = 'Usu_Id'
         AND r.REFERENCED_TABLE_NAME = 'usu_usuario'
         AND r.UNIQUE_CONSTRAINT_SCHEMA = DATABASE()
         AND r.DELETE_RULE = 'CASCADE'
         AND r.UPDATE_RULE = 'RESTRICT';

      IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: FK divergente em rf02_recuperacao_senha';
      END IF;

      SELECT COUNT(*) INTO v_count
        FROM information_schema.TRIGGERS
       WHERE EVENT_OBJECT_SCHEMA = DATABASE()
         AND EVENT_OBJECT_TABLE = 'rf02_recuperacao_senha';

      IF v_count <> 0 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: trigger inesperado em rf02_recuperacao_senha';
      END IF;
    END IF;

    IF v_t2_exists = 1 THEN
      SELECT COUNT(*) INTO v_count
        FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'rf02_rate_limit'
         AND TABLE_TYPE = 'BASE TABLE'
         AND ENGINE = 'InnoDB'
         AND TABLE_COLLATION = 'utf8mb4_0900_ai_ci';

      IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: tabela/engine/collation divergentes em rate_limit';
      END IF;

      SELECT GROUP_CONCAT(
               CONCAT_WS('#',
                 ORDINAL_POSITION, COLUMN_NAME, DATA_TYPE, IS_NULLABLE,
                 CONCAT('DEFAULT=', IFNULL(COLUMN_DEFAULT, '<NULL>')),
                 IF(DATA_TYPE IN ('bigint', 'int', 'tinyint'),
                    IF(COLUMN_TYPE LIKE '%unsigned%', 'unsigned', 'signed'), '-'),
                 IF(DATA_TYPE IN ('binary', 'varbinary', 'char', 'varchar'),
                    IFNULL(CHARACTER_MAXIMUM_LENGTH, '-'), '-'),
                 IF(DATA_TYPE IN ('datetime', 'timestamp', 'time'),
                    IFNULL(DATETIME_PRECISION, '-'), '-'),
                 IFNULL(CHARACTER_SET_NAME, '-'),
                 IFNULL(COLLATION_NAME, '-'),
                 IFNULL(NULLIF(EXTRA, ''), '-')
               ) ORDER BY ORDINAL_POSITION SEPARATOR '|'
             ) INTO v_actual
        FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'rf02_rate_limit';

      SET v_expected = CONCAT_WS('|',
        '1#escopo#varchar#NO#DEFAULT=<NULL>#-#40#-#utf8mb4#utf8mb4_0900_ai_ci#-',
        '2#chave_hmac#binary#NO#DEFAULT=<NULL>#-#32#-#-#-#-',
        '3#janela_inicio#datetime#NO#DEFAULT=<NULL>#-#-#3#-#-#-',
        '4#contador#int#NO#DEFAULT=<NULL>#unsigned#-#-#-#-#-',
        '5#expira_em#datetime#NO#DEFAULT=<NULL>#-#-#3#-#-#-'
      );

      IF v_actual IS NULL OR v_actual <> v_expected THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: colunas divergentes em rf02_rate_limit';
      END IF;

      SELECT COUNT(*) INTO v_count
        FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'rf02_rate_limit';

      IF v_count <> 4 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: quantidade de indices divergente em rate_limit';
      END IF;

      SELECT COUNT(*) INTO v_count
        FROM (
          SELECT 'PRIMARY' AS index_name, 0 AS non_unique, 1 AS seq, 'escopo' AS column_name
          UNION ALL SELECT 'PRIMARY', 0, 2, 'chave_hmac'
          UNION ALL SELECT 'PRIMARY', 0, 3, 'janela_inicio'
          UNION ALL SELECT 'idx_rf02_rate_limit_cleanup', 1, 1, 'expira_em'
        ) e
        LEFT JOIN information_schema.STATISTICS s
          ON s.TABLE_SCHEMA = DATABASE()
         AND s.TABLE_NAME = 'rf02_rate_limit'
         AND s.INDEX_NAME = e.index_name
         AND s.NON_UNIQUE = e.non_unique
         AND s.SEQ_IN_INDEX = e.seq
         AND s.COLUMN_NAME = e.column_name
         AND s.INDEX_TYPE = 'BTREE'
         AND s.IS_VISIBLE = 'YES'
         AND s.COLLATION = 'A'
         AND s.SUB_PART IS NULL
       WHERE s.TABLE_NAME IS NULL;

      IF v_count <> 0 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: indices divergentes em rf02_rate_limit';
      END IF;

      SELECT COUNT(*) INTO v_count
        FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE()
         AND TABLE_NAME = 'rf02_rate_limit'
         AND CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK');

      IF v_count <> 0 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: FK/CHECK inesperado em rf02_rate_limit';
      END IF;

      SELECT COUNT(*) INTO v_count
        FROM information_schema.TRIGGERS
       WHERE EVENT_OBJECT_SCHEMA = DATABASE()
         AND EVENT_OBJECT_TABLE = 'rf02_rate_limit';

      IF v_count <> 0 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'RF02: trigger inesperado em rf02_rate_limit';
      END IF;
    END IF;

    IF v_pass = 0 THEN
      IF v_t1_exists = 0 THEN
        CREATE TABLE `rf02_recuperacao_senha` (
          `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT
            COMMENT 'Identificador interno; nao exposto como token',
          `usuario_id` INT NULL
            COMMENT 'Titular conhecido; NULL permite fluxo sem enumerar contas',
          `nonce` BINARY(32) NOT NULL
            COMMENT 'Identificador opaco criptografico de 32 bytes',
          `token_hash` BINARY(32) NOT NULL
            COMMENT 'Digest do token; token bruto nunca e persistido',
          `criado_em` DATETIME(3) NOT NULL
            COMMENT 'Criacao registrada pelo backend em relogio consistente',
          `expira_em` DATETIME(3) NOT NULL
            COMMENT 'Limite absoluto de validade do token',
          `consumido_em` DATETIME(3) NULL
            COMMENT 'Consumo unico bem-sucedido; NULL enquanto nao consumido',
          `invalidado_em` DATETIME(3) NULL
            COMMENT 'Revogacao sem confundir com consumo',
          `email_estado` VARCHAR(20) NOT NULL
            COMMENT 'Somente PENDENTE, PROCESSANDO, ACEITA, DESCARTADA ou FALHA',
          `tentativas` TINYINT UNSIGNED NOT NULL DEFAULT 0
            COMMENT 'Contador limitado pelo backend para evitar overflow',
          `proxima_tentativa_em` DATETIME(3) NOT NULL
            COMMENT 'Proxima elegibilidade do worker de e-mail',
          `processando_ate` DATETIME(3) NULL
            COMMENT 'Lease do worker; recuperacao de PROCESSANDO expirado',
          `enviado_em` DATETIME(3) NULL
            COMMENT 'Aceite do provedor, sem provar entrega final (RV-10)',
          `ultima_falha` VARCHAR(40) NULL
            COMMENT 'Codigo taxonomico curto; nunca mensagem ou dado do provedor',
          `atualizado_em` DATETIME(3) NOT NULL
            COMMENT 'Ultima transicao persistida pelo backend',
          PRIMARY KEY (`id`),
          UNIQUE KEY `uk_rf02_recuperacao_nonce` (`nonce`),
          UNIQUE KEY `uk_rf02_recuperacao_token_hash` (`token_hash`),
          KEY `idx_rf02_recuperacao_consumo`
            (`usuario_id`, `consumido_em`, `invalidado_em`),
          KEY `idx_rf02_recuperacao_worker`
            (`email_estado`, `processando_ate`, `proxima_tentativa_em`),
          KEY `idx_rf02_recuperacao_cleanup` (`expira_em`, `atualizado_em`),
          CONSTRAINT `fk_rf02_recuperacao_usuario`
            FOREIGN KEY (`usuario_id`) REFERENCES `usu_usuario` (`Usu_Id`)
            ON DELETE CASCADE ON UPDATE RESTRICT
        ) ENGINE=InnoDB
          DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
          COMMENT='RF02: tokens opacos e fila de envio; retencao minima aprovada';
      END IF;

      IF v_t2_exists = 0 THEN
        CREATE TABLE `rf02_rate_limit` (
          `escopo` VARCHAR(40) NOT NULL
            COMMENT 'Classe tecnica do limite; nao contem identificador pessoal',
          `chave_hmac` BINARY(32) NOT NULL
            COMMENT 'HMAC da chave derivada; nunca e-mail, IP ou segredo bruto',
          `janela_inicio` DATETIME(3) NOT NULL
            COMMENT 'Inicio da janela fixa de contagem',
          `contador` INT UNSIGNED NOT NULL
            COMMENT 'Contador incrementado atomicamente pelo backend',
          `expira_em` DATETIME(3) NOT NULL
            COMMENT 'Expiracao da janela para cleanup',
          PRIMARY KEY (`escopo`, `chave_hmac`, `janela_inicio`),
          KEY `idx_rf02_rate_limit_cleanup` (`expira_em`)
        ) ENGINE=InnoDB
          DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
          COMMENT='RF02: rate limit sem identificadores brutos; expurgo apos expiracao';
      END IF;

      SET v_t1_exists = 1;
      SET v_t2_exists = 1;
    END IF;

    SET v_pass = v_pass + 1;
  END WHILE;
END$$

CALL `_rf02_20261124_001_guard`()$$

DROP PROCEDURE IF EXISTS `_rf02_20261124_001_guard`$$

DELIMITER ;

-- Integridade de email_estado: deliberadamente sem ENUM e sem CHECK. CHECK so e
-- efetivamente imposto a partir do MySQL 8.0.16; o contrato geral declara MySQL
-- 8.0. O backend DEVE rejeitar qualquer valor fora dos cinco documentados e os
-- testes de QA devem cobrir essa validacao. O guard reprova CHECK/constraints
-- extras para nao declarar idempotente uma estrutura que diverga deste contrato.
--
-- Nenhuma coluna contem e-mail, IP, token bruto, senha, hash de senha ou HTML.
-- Nenhuma estrutura de revogacao de sessao foi criada (DI-09/RS-02 permanecem).
