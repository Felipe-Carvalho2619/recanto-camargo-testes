const { criarRecuperacaoSenhaService } = require('./recuperacaoSenhaService');

const INTERVALO_POLLING_MS = 2000;
// O timeout atual de enviarEmail é 10 s; o lease deve permanecer maior que ele.
const LEASE_PROCESSAMENTO_MS = 30000;
const RETENCAO_LIMPEZA_MS = 24 * 60 * 60 * 1000;
const ATRASOS_RETRY_MS = [30000, 120000];
const LIMITE_DELETE_POR_CICLO = 500;
const MOTIVOS_DEFINITIVOS = new Set(['sem_chave', 'sem_remetente', 'parametros_invalidos', 'override_nao_autorizado']);

function criarRecuperacaoSenhaOutboxService({
    db,
    emailService,
    logger = console,
    env = process.env,
    clock = { now: () => Date.now() },
    secret,
    recuperacaoSenhaService,
    rateLimitService,
    intervaloPollingMs = INTERVALO_POLLING_MS,
    leaseMs = LEASE_PROCESSAMENTO_MS
} = {}) {
    const recuperacao = recuperacaoSenhaService || criarRecuperacaoSenhaService({
        db, env, logger, clock, secret
    });

    function registrar(id, estado, tentativas, codigo) {
        const partes = ['[RF02 outbox]'];
        if (id !== undefined && id !== null) partes.push(`id=${Number(id)}`);
        partes.push(`estado=${estado}`);
        partes.push(`tentativas=${Number(tentativas) || 0}`);
        partes.push(`codigo=${codigo}`);
        logger.info(partes.join(' '));
    }

    function registrarInfra(estado, codigo) {
        logger.error(`[RF02 outbox] estado=${estado} tentativas=0 codigo=${codigo}`);
    }

    function sanitizarMotivo(motivo) {
        if (MOTIVOS_DEFINITIVOS.has(motivo)) return motivo;
        if (motivo === 'falha_comunicacao' || motivo === 'falha_provedor') return motivo;
        return 'falha_nao_classificada';
    }

    function predicadoOtimista(claim) {
        return [claim.id, claim.nonce, claim.tentativas, claim.processandoAte];
    }

    async function descartar(claim, codigo) {
        const atual = recuperacao.dataMysql(recuperacao.agora());
        const [resultado] = await db.query(
            `UPDATE rf02_recuperacao_senha
             SET email_estado = 'DESCARTADA', invalidado_em = COALESCE(invalidado_em, ?),
                 processando_ate = NULL, ultima_falha = ?, atualizado_em = ?
             WHERE id = ? AND nonce = ? AND tentativas = ? AND processando_ate = ?
               AND email_estado = 'PROCESSANDO'`,
            [atual, codigo, atual, ...predicadoOtimista(claim)]
        );
        if (resultado.affectedRows === 1) registrar(claim.id, 'DESCARTADA', claim.tentativas, codigo);
    }

    async function falharDefinitivamente(claim, codigo) {
        const atual = recuperacao.dataMysql(recuperacao.agora());
        // Somente a linha e a tentativa donas do lease são afetadas.
        const [resultado] = await db.query(
            `UPDATE rf02_recuperacao_senha
             SET email_estado = 'FALHA', invalidado_em = ?, processando_ate = NULL,
                 ultima_falha = ?, atualizado_em = ?
             WHERE id = ? AND nonce = ? AND tentativas = ? AND processando_ate = ?
               AND email_estado = 'PROCESSANDO'`,
            [atual, codigo, atual, ...predicadoOtimista(claim)]
        );
        if (resultado.affectedRows === 1) registrar(claim.id, 'FALHA', claim.tentativas, codigo);
    }

    async function agendarRetry(claim, codigo) {
        if (claim.tentativas >= 3) return falharDefinitivamente(claim, codigo);
        const atraso = ATRASOS_RETRY_MS[claim.tentativas - 1] || ATRASOS_RETRY_MS[1];
        const proxima = recuperacao.dataMysql(new Date(recuperacao.agora().getTime() + atraso));
        const atual = recuperacao.dataMysql(recuperacao.agora());
        const [resultado] = await db.query(
            `UPDATE rf02_recuperacao_senha
             SET email_estado = 'PENDENTE', proxima_tentativa_em = ?, processando_ate = NULL,
                 ultima_falha = ?, atualizado_em = ?
             WHERE id = ? AND nonce = ? AND tentativas = ? AND processando_ate = ?
               AND email_estado = 'PROCESSANDO' AND consumido_em IS NULL
               AND invalidado_em IS NULL AND ? < expira_em`,
            [proxima, codigo, atual, ...predicadoOtimista(claim), proxima]
        );
        if (resultado.affectedRows === 1) {
            registrar(claim.id, 'PENDENTE', claim.tentativas, codigo);
            return;
        }
        await falharDefinitivamente(claim, codigo);
    }

    async function aceitar(claim) {
        const atual = recuperacao.dataMysql(recuperacao.agora());
        const [resultado] = await db.query(
            `UPDATE rf02_recuperacao_senha
             SET email_estado = 'ACEITA', enviado_em = ?, processando_ate = NULL,
                 ultima_falha = NULL, atualizado_em = ?
             WHERE id = ? AND nonce = ? AND tentativas = ? AND processando_ate = ?
               AND email_estado = 'PROCESSANDO' AND consumido_em IS NULL AND invalidado_em IS NULL`,
            [atual, atual, ...predicadoOtimista(claim)]
        );
        if (resultado.affectedRows === 1) {
            registrar(claim.id, 'ACEITA', claim.tentativas, 'aceita_provedor');
        }
    }

    async function recuperarOrfaos() {
        const atual = recuperacao.dataMysql(recuperacao.agora());
        await db.query(
            `UPDATE rf02_recuperacao_senha
             SET email_estado = 'FALHA', invalidado_em = ?, processando_ate = NULL,
                 ultima_falha = 'lease_excedido', atualizado_em = ?
             WHERE email_estado = 'PROCESSANDO' AND processando_ate <= ?
               AND tentativas >= 3 AND consumido_em IS NULL AND invalidado_em IS NULL`,
            [atual, atual, atual]
        );
        await db.query(
            `UPDATE rf02_recuperacao_senha
             SET email_estado = 'FALHA', invalidado_em = ?, processando_ate = NULL,
                 ultima_falha = 'tentativas_esgotadas', atualizado_em = ?
             WHERE email_estado = 'PENDENTE' AND tentativas >= 3
               AND consumido_em IS NULL AND invalidado_em IS NULL`,
            [atual, atual]
        );
        await db.query(
            `UPDATE rf02_recuperacao_senha
             SET email_estado = 'DESCARTADA', invalidado_em = COALESCE(invalidado_em, ?),
                 processando_ate = NULL, ultima_falha = 'expirado', atualizado_em = ?
             WHERE email_estado IN ('PENDENTE', 'PROCESSANDO') AND expira_em <= ?`,
            [atual, atual, atual]
        );
    }

    async function renovarLeaseParaEnvio(claim) {
        if (!Number.isFinite(leaseMs) || leaseMs <= 10000) return false;
        const instante = recuperacao.agora();
        const atual = recuperacao.dataMysql(instante);
        const novoLease = recuperacao.dataMysql(new Date(instante.getTime() + leaseMs));
        const [resultado] = await db.query(
            `UPDATE rf02_recuperacao_senha
             SET processando_ate = ?
             WHERE id = ? AND nonce = ? AND tentativas = ? AND processando_ate = ?
               AND email_estado = 'PROCESSANDO' AND processando_ate > ?
               AND consumido_em IS NULL AND invalidado_em IS NULL AND expira_em > ?`,
            [novoLease, ...predicadoOtimista(claim), atual, atual]
        );
        if (resultado.affectedRows !== 1) return false;
        claim.processandoAte = novoLease;
        return true;
    }

    async function processarRegistro(claim) {
        const atual = recuperacao.dataMysql(recuperacao.agora());
        const [registros] = await db.query(
            `SELECT u.Usu_Nome, u.Usu_Email, u.Usu_Status
             FROM rf02_recuperacao_senha r
             LEFT JOIN usu_usuario u ON u.Usu_Id = r.usuario_id
             WHERE r.id = ? AND r.nonce = ? AND r.tentativas = ? AND r.processando_ate = ?
               AND r.email_estado = 'PROCESSANDO' AND r.processando_ate > ?
               AND r.consumido_em IS NULL AND r.invalidado_em IS NULL AND r.expira_em > ? LIMIT 1`,
            [...predicadoOtimista(claim), atual, atual]
        );
        const registro = registros[0];
        if (!registro) return;

        if (claim.usuario_id === null || registro.Usu_Status !== 'ATIVO') {
            await descartar(claim, 'conta_inelegivel');
            return;
        }

        let token;
        let frontendUrl;
        try {
            recuperacao.validarConfiguracaoGlobal();
            frontendUrl = recuperacao.obterFrontendUrl();
            token = recuperacao.reconstruirToken(claim.nonce);
        } catch (erro) {
            const codigo = erro.codigo === 'OVERRIDE_PRODUCAO' ? 'override_producao' : 'config_global';
            await falharDefinitivamente(claim, codigo);
            return;
        }

        const urlRecuperacao = `${frontendUrl}/#/RecuperarSenha?token=${encodeURIComponent(token)}`;
        let html;
        try {
            html = emailService.criarEmailRecuperacaoSenha({
                nome: registro.Usu_Nome,
                urlRecuperacao
            });
        } catch {
            await falharDefinitivamente(claim, 'parametros_invalidos');
            return;
        }

        // Revalida a posse e concede lease completo imediatamente antes do provider.
        // Se outro worker assumiu ou o lease expirou, não há chamada ao Resend.
        if (!await renovarLeaseParaEnvio(claim)) return;

        let resultado;
        try {
            resultado = await emailService.enviarEmail(
                registro.Usu_Email,
                'Recuperação de senha',
                html,
                recuperacao.criarChaveIdempotencia(claim.nonce),
                { logs: false }
            );
        } catch {
            resultado = { enviado: false, motivo: 'falha_comunicacao' };
        }

        if (resultado?.enviado === true) {
            await aceitar(claim);
            return;
        }

        const motivo = sanitizarMotivo(resultado?.motivo);
        if (MOTIVOS_DEFINITIVOS.has(motivo)) {
            await falharDefinitivamente(claim, motivo);
            return;
        }
        await agendarRetry(claim, motivo);
    }

    async function adquirirClaim() {
        let conexao;
        try {
            // Lease fresco por item, calculado somente quando ele chega à vez.
            const atual = recuperacao.dataMysql(recuperacao.agora());
            const lease = recuperacao.dataMysql(new Date(recuperacao.agora().getTime() + leaseMs));

            // Claim curto e unitário: commit e release antecedem qualquer Resend.
            conexao = await db.getConnection();
            await conexao.beginTransaction();
            const [candidatos] = await conexao.query(
                `SELECT id, usuario_id, nonce, tentativas FROM rf02_recuperacao_senha
                 WHERE tentativas < 3 AND consumido_em IS NULL AND invalidado_em IS NULL
                   AND expira_em > ?
                   AND ((email_estado = 'PENDENTE' AND proxima_tentativa_em <= ?)
                     OR (email_estado = 'PROCESSANDO' AND processando_ate <= ?))
                 ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
                [atual, atual, atual]
            );

            const candidato = candidatos[0];
            let claim = null;
            if (candidato) {
                const candidatoClaim = {
                    id: candidato.id,
                    usuario_id: candidato.usuario_id,
                    nonce: candidato.nonce,
                    tentativas: Number(candidato.tentativas) + 1,
                    processandoAte: lease
                };
                const [resultado] = await conexao.query(
                    `UPDATE rf02_recuperacao_senha
                     SET email_estado = 'PROCESSANDO', tentativas = tentativas + 1,
                         processando_ate = ?, atualizado_em = ?
                     WHERE id = ? AND nonce = ? AND tentativas = ? AND expira_em > ?
                       AND consumido_em IS NULL AND invalidado_em IS NULL
                       AND ((email_estado = 'PENDENTE' AND proxima_tentativa_em <= ?)
                         OR (email_estado = 'PROCESSANDO' AND processando_ate <= ?))`,
                    [lease, atual, candidato.id, candidato.nonce, candidato.tentativas,
                        atual, atual, atual]
                );
                if (resultado.affectedRows === 1) claim = candidatoClaim;
            }

            await conexao.commit();
            conexao.release();
            conexao = null;
            return claim;
        } catch (erro) {
            if (conexao) await conexao.rollback().catch(() => {});
            if (conexao) conexao.release();
            throw erro;
        }
    }

    async function processarLote() {
        try {
            recuperacao.validarConfiguracaoGlobal();
        } catch (erro) {
            registrarInfra('BLOQUEADO', erro.codigo === 'OVERRIDE_PRODUCAO' ? 'override_producao' : 'config_global');
            return { processados: 0 };
        }

        try {
            await recuperarOrfaos();
        } catch {
            registrarInfra('INDISPONIVEL', 'persistencia');
            return { processados: 0 };
        }

        let processados = 0;
        // Just-in-time: um item lento não consome o lease dos demais. Os envios
        // continuam sequenciais, com no máximo dez ciclos claim→processamento.
        for (let indice = 0; indice < 10; indice += 1) {
            let claim;
            try {
                claim = await adquirirClaim();
            } catch {
                registrarInfra('INDISPONIVEL', 'persistencia');
                break;
            }
            if (!claim) break;

            try {
                registrar(claim.id, 'PROCESSANDO', claim.tentativas, 'claim');
                await processarRegistro(claim);
            } catch {
                registrar(claim.id, 'PROCESSANDO', claim.tentativas, 'processamento');
            }
            processados += 1;
        }
        return { processados };
    }

    async function limpar() {
        try {
            // Órfãos/expirados tornam-se terminais antes de qualquer retenção.
            await recuperarOrfaos();
            const limite = recuperacao.dataMysql(new Date(recuperacao.agora().getTime() - RETENCAO_LIMPEZA_MS));
            // atualizado_em é o marco terminal gravado pelas finalizações. Nenhuma
            // linha PENDENTE/PROCESSANDO é apagada, mesmo quando antiga.
            await db.query(
                `DELETE FROM rf02_recuperacao_senha
                 WHERE email_estado IN ('ACEITA', 'DESCARTADA', 'FALHA') AND atualizado_em < ?
                 LIMIT ${LIMITE_DELETE_POR_CICLO}`,
                [limite]
            );
            if (rateLimitService?.limparExpirados) await rateLimitService.limparExpirados();
        } catch {
            registrarInfra('LIMPEZA', 'persistencia');
        }
    }

    function iniciar() {
        let timer;
        let parado = false;
        let executando = false;
        let ultimaLimpeza = 0;

        const ciclo = async () => {
            if (parado || executando) return;
            executando = true;
            try {
                await processarLote();
                const agoraMs = recuperacao.agora().getTime();
                if (agoraMs - ultimaLimpeza >= 60 * 60 * 1000) {
                    await limpar();
                    ultimaLimpeza = agoraMs;
                }
            } catch {
                registrarInfra('INDISPONIVEL', 'processamento');
            } finally {
                executando = false;
                if (!parado) {
                    timer = setTimeout(ciclo, intervaloPollingMs);
                    timer.unref();
                }
            }
        };

        timer = setTimeout(ciclo, intervaloPollingMs);
        timer.unref();
        return () => {
            parado = true;
            if (timer) clearTimeout(timer);
        };
    }

    return { processarLote, limpar, iniciar, recuperarOrfaos };
}

module.exports = {
    criarRecuperacaoSenhaOutboxService,
    INTERVALO_POLLING_MS,
    LEASE_PROCESSAMENTO_MS,
    ATRASOS_RETRY_MS,
    LIMITE_DELETE_POR_CICLO
};
