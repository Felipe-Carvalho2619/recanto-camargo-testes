-- =============================================================================
-- RF02 - RECUPERACAO DE SENHA - ROLLBACK RELEASE ISOLADO E DESTRUTIVO
-- =============================================================================
-- Data do artefato: 24/11/2026.
-- Origem validada em QA: rollback/20261123_001_rf02_recuperacao_senha.sql
-- SHA-256 da origem: 38c75da65b12c557738e41f9865fda0c3e8f97ed5b5071359c895eb17392a7ba
-- Destino futuro: o mesmo schema MySQL 8.0 explicitamente aprovado para a
-- migration release 20261124_001_rf02_recuperacao_senha.sql.
-- Esta preparacao e a validacao local NAO autorizam DDL real. Rollback em banco
-- operacional exige autorizacao humana especifica, janela, backup restauravel e
-- confirmacao imediata de DATABASE(); nenhuma execucao remota faz parte do pacote.
--
-- Gate E: antes de aplicar, parar backend/worker RF02 ou voltar a versao que nao
-- dependa das tabelas, proteger o backup e aceitar formalmente a perda de tokens
-- RF02 (nonce/hash), consumos, revogacoes, outbox/estados de e-mail, tentativas,
-- falhas e contadores/janelas de rate-limit. A perda e irreversivel sem backup.
-- A remocao estrutural nao revoga JWT e nao resolve DI-09/RS-02.
-- Nao executar concorrentemente com a migration nem usar --force.
--
-- Escopo destrutivo limitado a:
--   - rf02_rate_limit;
--   - rf02_recuperacao_senha;
--   - as rotinas auxiliares temporarias release 20261124.
-- Nao remove nem altera usu_usuario, baseline, sessoes, rotinas QA 20261123 ou
-- qualquer outra tabela/rotina. Nao contem DML/backfill e nao cria dados.
--
-- Idempotencia e protecao contra divergencia:
--   - tabela ausente e tratada como no-op;
--   - toda tabela presente e integralmente validada ANTES de qualquer DROP;
--   - divergencia de colunas, indices, FK, engine, collation, CHECK ou trigger
--      causa SIGNAL sem remover nenhuma das duas tabelas;
--   - apos a validacao, a remocao e refeita com IF EXISTS e verificada ao final.
-- DDL tem commit implicito: se o segundo DROP falhar, interromper, reinspecionar
-- e somente entao seguir a recuperacao autorizada. Nao completar manualmente.
--
-- A rotina auxiliar exclusiva 20261124 e removida apos sucesso. Em erro ou
-- interrupcao do cliente ela pode permanecer para diagnostico; a reexecucao a
-- substitui. Requer CREATE ROUTINE no QA isolado ou privilegio aprovado na janela.
-- =============================================================================

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_rf02_20261124_001_guard`$$
DROP PROCEDURE IF EXISTS `_rf02_20261124_001_rollback_guard`$$

CREATE PROCEDURE `_rf02_20261124_001_rollback_guard`()
BEGIN
  DECLARE v_t1_exists INT DEFAULT 0;
  DECLARE v_t2_exists INT DEFAULT 0;
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_actual LONGTEXT;
  DECLARE v_expected LONGTEXT;

  IF DATABASE() IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RF02 rollback release: selecione explicitamente o schema aprovado';
  END IF;

  IF SUBSTRING_INDEX(VERSION(), '.', 2) <> '8.0' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RF02 rollback: o artefato exige MySQL 8.0';
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
        SET MESSAGE_TEXT = 'RF02 rollback: tabela/engine/collation divergentes em recuperacao';
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
        SET MESSAGE_TEXT = 'RF02 rollback: colunas divergentes em recuperacao_senha';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rf02_recuperacao_senha';

    IF v_count <> 11 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'RF02 rollback: quantidade de indices divergente em recuperacao';
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
        SET MESSAGE_TEXT = 'RF02 rollback: indices divergentes em recuperacao_senha';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rf02_recuperacao_senha'
       AND CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK');

    IF v_count <> 1 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'RF02 rollback: FK/CHECK divergentes em recuperacao_senha';
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
        SET MESSAGE_TEXT = 'RF02 rollback: FK divergente em recuperacao_senha';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TRIGGERS
     WHERE EVENT_OBJECT_SCHEMA = DATABASE()
       AND EVENT_OBJECT_TABLE = 'rf02_recuperacao_senha';

    IF v_count <> 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'RF02 rollback: trigger inesperado em recuperacao_senha';
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
        SET MESSAGE_TEXT = 'RF02 rollback: tabela/engine/collation divergentes em rate_limit';
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
        SET MESSAGE_TEXT = 'RF02 rollback: colunas divergentes em rf02_rate_limit';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rf02_rate_limit';

    IF v_count <> 4 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'RF02 rollback: quantidade de indices divergente em rate_limit';
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
        SET MESSAGE_TEXT = 'RF02 rollback: indices divergentes em rf02_rate_limit';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rf02_rate_limit'
       AND CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK');

    IF v_count <> 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'RF02 rollback: FK/CHECK inesperado em rf02_rate_limit';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TRIGGERS
     WHERE EVENT_OBJECT_SCHEMA = DATABASE()
       AND EVENT_OBJECT_TABLE = 'rf02_rate_limit';

    IF v_count <> 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'RF02 rollback: trigger inesperado em rf02_rate_limit';
    END IF;
  END IF;

  -- Nenhum DROP ocorreu antes de todas as tabelas presentes serem validadas.
  DROP TABLE IF EXISTS `rf02_rate_limit`;
  DROP TABLE IF EXISTS `rf02_recuperacao_senha`;

  SELECT COUNT(*) INTO v_count
    FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME IN ('rf02_recuperacao_senha', 'rf02_rate_limit');

  IF v_count <> 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RF02 rollback release: tabelas RF02 ainda presentes; reinspecionar schema';
  END IF;
END$$

CALL `_rf02_20261124_001_rollback_guard`()$$

DROP PROCEDURE IF EXISTS `_rf02_20261124_001_rollback_guard`$$

DELIMITER ;

-- A perda dos registros das duas tabelas e intencional e irreversivel sem copia
-- previa aprovada. Em ambiente real exige autorizacao humana especifica. A
-- remocao estrutural nao revoga JWT e nao resolve DI-09/RS-02.
