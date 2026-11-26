process.env.NODE_ENV = 'test';
process.env.MERCADO_PAGO_ACCESS_TOKEN = 'token-sintetico-somente-testes';
process.env.MERCADO_PAGO_WEBHOOK_SECRET = '';
process.env.FRONTEND_URL = 'http://frontend.test';
process.env.BACKEND_URL = 'http://backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarSessionService } = require('../services/sessionService');

// O SDK é substituído antes de server/controller importarem o serviço de pagamento.
// Nenhum método local faz fetch, abre socket ou delega ao SDK real.
const gatewayMock = {
    preferencias: [],
    consultasPagamento: [],
    buscasPagamento: [],
    pagamentoPorId: null,
    pagamentoPorReserva: null
};
class MercadoPagoConfigLocal {
    constructor(configuracao) { this.configuracao = configuracao; }
}
class PreferenceLocal {
    async create({ body }) {
        gatewayMock.preferencias.push(body);
        const id = `pref-local-${gatewayMock.preferencias.length}`;
        return {
            id,
            init_point: `http://gateway.local/checkout/${id}`,
            sandbox_init_point: `http://gateway.local/sandbox/${id}`
        };
    }
}
class PaymentLocal {
    async get({ id }) {
        gatewayMock.consultasPagamento.push(String(id));
        return gatewayMock.pagamentoPorId;
    }
    async search({ options }) {
        gatewayMock.buscasPagamento.push(options);
        return { results: gatewayMock.pagamentoPorReserva ? [gatewayMock.pagamentoPorReserva] : [] };
    }
}
class PaymentRefundLocal {
    async create() {
        throw new Error('Reembolso não faz parte desta fixture unitária local.');
    }
}
const caminhoMercadoPagoSdk = require.resolve('mercadopago');
const mercadoPagoSdkAnterior = require.cache[caminhoMercadoPagoSdk];
require.cache[caminhoMercadoPagoSdk] = {
    id: caminhoMercadoPagoSdk,
    filename: caminhoMercadoPagoSdk,
    loaded: true,
    exports: {
        MercadoPagoConfig: MercadoPagoConfigLocal,
        Preference: PreferenceLocal,
        Payment: PaymentLocal,
        PaymentRefund: PaymentRefundLocal
    }
};

const emailEnvios = [];
const emailServiceMock = {
    async enviarEmail(destinatario, assunto, html, chaveIdempotencia) {
        emailEnvios.push({ destinatario, assunto, html, chaveIdempotencia });
        return { enviado: true };
    },
    criarHtmlEmail(titulo, mensagem) {
        return `<html-local>${titulo}: ${mensagem}</html-local>`;
    }
};
const caminhoEmail = require.resolve('../email');
const emailAnterior = require.cache[caminhoEmail];
require.cache[caminhoEmail] = {
    id: caminhoEmail,
    filename: caminhoEmail,
    loaded: true,
    exports: {
        criarServicoEmail: () => ({ enviarEmail: emailServiceMock.enviarEmail }),
        criarHtmlEmail: emailServiceMock.criarHtmlEmail,
        criarEmailBoasVindas: () => 'email-local-boas-vindas',
        criarEmailCupomExclusivo: () => 'email-local-cupom',
        criarEmailRecuperacaoSenha: () => 'email-local-recuperacao'
    }
};

let estado = {};
const SENHA_HASH_TESTE = 'hash-sintetico-somente-testes-pagamento';
const JWT_TEST = 'segredo-sintetico-somente-testes-pagamento';
const bancoMock = {
    async getConnection() { return this; },
    async beginTransaction() { estado.transacoes.begin += 1; },
    async commit() { estado.transacoes.commit += 1; },
    async rollback() { estado.transacoes.rollback += 1; },
    release() { estado.transacoes.release += 1; },
    destroy() {},
    async query(sql, parametros = []) {
        estado.consultas.push({ sql, parametros });
        const texto = sql.replace(/\s+/g, ' ').trim();
        if (texto.startsWith('SELECT usu.Usu_Id, usu.Usu_Nome, usu.Usu_Status, usu.Usu_SenhaHash')) {
            assert.match(texto, /CASE WHEN EXISTS \(\s*SELECT 1 FROM pro_proprietario AS pro/);
            const id = Number(parametros[0]);
            return [[{
                Usu_Id: id,
                Usu_Nome: 'Hóspede sintético do banco',
                Usu_Status: 'ATIVO',
                Usu_SenhaHash: SENHA_HASH_TESTE,
                Usu_Tipo: 'hospede'
            }]];
        }
        if (texto.startsWith('SELECT r.Res_Id')) {
            return [[{ ...estado.reservaPreferencia }]];
        }
        if (texto.startsWith('SELECT r.Res_Status')) {
            return [[{ ...estado.reservaAprovacao }]];
        }
        if (texto.startsWith('SELECT Pag_Id FROM pag_pagamento')) {
            return [estado.pagamentosAprovacao.map(pagamento => ({ ...pagamento }))];
        }
        if (texto.startsWith('SELECT Hos_Hospede_Usu_Id, Res_Status, Res_ValorTotal FROM res_reserva')) {
            return [[{ ...estado.reservaStatus }]];
        }
        if (texto.startsWith('SELECT Pag_Id, Res_Id, Pag_Metodo')) {
            return [estado.pagamentosStatus.map(pagamento => ({ ...pagamento }))];
        }
        if (texto.startsWith('SELECT * FROM pag_pagamento')) {
            return [estado.pagamentosPreferencia.map(pagamento => ({ ...pagamento }))];
        }
        if (texto.startsWith("UPDATE res_reserva SET Res_Status = 'CONFIRMADA'")) {
            return [{ ...estado.resultadoAtualizacaoReserva }];
        }
        if (texto.startsWith('INSERT INTO pag_pagamento')) {
            return [{ insertId: 10, affectedRows: 1 }];
        }
        if (texto.startsWith('UPDATE pag_pagamento') || texto.startsWith('INSERT INTO his_historicoreservastatus')) {
            return [{ affectedRows: 1 }];
        }
        return [[]];
    }
};

const caminhoDb = require.resolve('../config/db');
const dbAnterior = require.cache[caminhoDb];
require.cache[caminhoDb] = { id: caminhoDb, filename: caminhoDb, loaded: true, exports: bancoMock };

const app = require('../server');
const pagamentoController = require('../controllers/pagamentoController');

if (dbAnterior) require.cache[caminhoDb] = dbAnterior;
else delete require.cache[caminhoDb];
if (mercadoPagoSdkAnterior) require.cache[caminhoMercadoPagoSdk] = mercadoPagoSdkAnterior;
else delete require.cache[caminhoMercadoPagoSdk];
if (emailAnterior) require.cache[caminhoEmail] = emailAnterior;
else delete require.cache[caminhoEmail];

const notificacoesCriadas = [];
const notificacoesMock = {
    async criarNotificacao(...parametros) { notificacoesCriadas.push(parametros); }
};
const appMock = {
    get(nome) {
        if (nome === 'emailService') return emailServiceMock;
        if (nome === 'notificacoes') return notificacoesMock;
        return null;
    }
};

let servidor;
let base;
// O serviço injetado no app usa exclusivamente a constante sintética, sem fallback de ambiente.
const sessaoTeste = criarSessionService({ db: bancoMock, secret: JWT_TEST });
app.set('sessionService', sessaoTeste);
app.set('emailService', emailServiceMock);
app.set('notificacoes', notificacoesMock);

function reiniciarFixture() {
    estado = {
        consultas: [],
        reservaPreferencia: {
            Res_Id: 1,
            Res_ValorTotal: '450.00',
            Res_Status: 'PENDENTE',
            Hos_Hospede_Usu_Id: 41,
            Usu_Nome: 'Hóspede sintético',
            Usu_Email: 'hospede@example.invalid'
        },
        reservaStatus: {
            Hos_Hospede_Usu_Id: 41,
            Res_Status: 'PENDENTE',
            Res_ValorTotal: '450.00'
        },
        reservaAprovacao: {
            Res_Status: 'PAGAMENTO_PENDENTE',
            Hos_Hospede_Usu_Id: 41,
            Res_ValorTotal: '450.00',
            hospedeNome: 'Hóspede sintético',
            hospedeEmail: 'hospede@example.invalid',
            Pro_Proprietario_Usu_Id: 7,
            proprietarioEmail: 'proprietario@example.invalid'
        },
        pagamentosAprovacao: [],
        pagamentosPreferencia: [],
        pagamentosStatus: [],
        resultadoAtualizacaoReserva: { affectedRows: 1 },
        transacoes: { begin: 0, commit: 0, rollback: 0, release: 0 }
    };
    gatewayMock.preferencias.length = 0;
    gatewayMock.consultasPagamento.length = 0;
    gatewayMock.buscasPagamento.length = 0;
    gatewayMock.pagamentoPorId = null;
    gatewayMock.pagamentoPorReserva = null;
    emailEnvios.length = 0;
    notificacoesCriadas.length = 0;
}

reiniciarFixture();
test.beforeEach(reiniciarFixture);

test.before(async () => {
    servidor = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
    await new Promise(resolve => servidor.close(resolve));
});

function cookie(id = 41, tipo = 'hospede') {
    const { token } = sessaoTeste.criarTokenSessao({ id, nome: 'Hóspede sintético', tipo }, SENHA_HASH_TESTE);
    return `token=${token}`;
}

test('Pagamento: recusa criação de preferência sem autenticação (401)', async () => {
    const res = await fetch(`${base}/api/pagamentos/criar-preferencia/999`, {
        method: 'POST'
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.match(data.error, /Acesso negado/);
});

test('Pagamento: recusa consulta de status sem autenticação (401)', async () => {
    const res = await fetch(`${base}/api/pagamentos/status/999`, {
        method: 'GET'
    });
    assert.equal(res.status, 401);
});

test('Pagamento: rejeita ID de reserva não numérico (400)', async () => {
    const res = await fetch(`${base}/api/pagamentos/criar-preferencia/abc`, {
        method: 'POST',
        headers: { Cookie: cookie(41) }
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /inválido/i);
});

test('Pagamento: webhook responde 200 OK mesmo para eventos sem dados', async () => {
    const res = await fetch(`${base}/api/pagamentos/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'test' })
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'OK');
});

test('Pagamento: consulta status de reserva com autenticação do hóspede titular (200)', async () => {
    const res = await fetch(`${base}/api/pagamentos/status/1`, {
        method: 'GET',
        headers: { Cookie: cookie(41) }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.temPagamento, false);
    assert.equal(data.reservaStatus, 'PENDENTE');
});

test('Pagamento: impede consulta de status por hóspede que não seja o dono da reserva (403)', async () => {
    const res = await fetch(`${base}/api/pagamentos/status/1`, {
        method: 'GET',
        headers: { Cookie: cookie(999) }
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /Acesso negado/);
});

function consultasPorPadrao(padrao) {
    return estado.consultas.filter(({ sql }) => padrao.test(sql.replace(/\s+/g, ' ').trim()));
}

function escritasDeAprovacao() {
    return consultasPorPadrao(/^(?:INSERT INTO pag_pagamento|UPDATE pag_pagamento|UPDATE res_reserva|INSERT INTO his_historicoreservastatus)/);
}

function transicoesDeConfirmacao() {
    return consultasPorPadrao(/^UPDATE res_reserva SET Res_Status = 'CONFIRMADA'/);
}

function historicoDeConfirmacao() {
    return consultasPorPadrao(/^INSERT INTO his_historicoreservastatus/);
}

function assertRollbackSemEscritasDeAprovacao() {
    assert.deepEqual(estado.transacoes, { begin: 1, commit: 0, rollback: 1, release: 1 });
    assert.deepEqual(escritasDeAprovacao(), [], 'Nenhum INSERT/UPDATE de aprovação pode ser tentado');
}

function criarRespostaMock() {
    return {
        statusCode: 200,
        corpo: undefined,
        status(codigo) {
            this.statusCode = codigo;
            return this;
        },
        json(corpo) {
            this.corpo = corpo;
            return this;
        },
        send(corpo) {
            this.corpo = corpo;
            return this;
        }
    };
}

async function acionarWebhookAprovado(pagamento) {
    gatewayMock.pagamentoPorId = {
        id: 'mp-webhook-local',
        external_reference: 'RC_1',
        status: 'approved',
        payment_method_id: 'pix',
        ...pagamento
    };
    const resposta = criarRespostaMock();
    await pagamentoController.receberWebhook({
        headers: {},
        query: { 'data.id': 'mp-webhook-local', type: 'payment' },
        body: { data: { id: 'mp-webhook-local' }, type: 'payment' },
        app: appMock
    }, resposta);
    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.corpo, 'OK');
    assert.deepEqual(gatewayMock.consultasPagamento, ['mp-webhook-local']);
    return resposta;
}

async function acionarReconciliacaoAtiva(pagamento) {
    estado.reservaStatus.Res_Status = 'PAGAMENTO_PENDENTE';
    gatewayMock.pagamentoPorReserva = {
        id: 'mp-busca-local',
        external_reference: 'RC_1',
        status: 'approved',
        payment_method_id: 'pix',
        ...pagamento
    };
    const resposta = criarRespostaMock();
    const ambienteAnterior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
        await pagamentoController.consultarStatus({
            params: { reservaId: '1' },
            usuario: { id: 41, tipo: 'hospede' },
            app: appMock
        }, resposta);
    } finally {
        process.env.NODE_ENV = ambienteAnterior;
    }
    assert.equal(process.env.RC_TEST_ISOLATION, '1', 'O isolamento estrutural deve permanecer ativo');
    assert.equal(gatewayMock.buscasPagamento.length, 1);
    assert.equal(gatewayMock.buscasPagamento[0].external_reference, 'RC_1');
    return resposta;
}

test('efetivarAprovacaoPagamento: valor/moeda inválidos fazem rollback sem qualquer escrita de aprovação', async t => {
    const casos = [
        { nome: 'valor menor', valorPago: 400, moeda: 'BRL', motivo: 'VALOR_PAGO_DIVERGENTE' },
        { nome: 'valor menor por 0.01', valorPago: 449.99, moeda: 'BRL', motivo: 'VALOR_PAGO_DIVERGENTE' },
        { nome: 'valor ausente', valorPago: null, moeda: 'BRL', motivo: 'VALOR_PAGO_AUSENTE_OU_INVALIDO' },
        { nome: 'valor não finito NaN', valorPago: Number.NaN, moeda: 'BRL', motivo: 'VALOR_PAGO_AUSENTE_OU_INVALIDO' },
        { nome: 'valor não finito infinito', valorPago: Number.POSITIVE_INFINITY, moeda: 'BRL', motivo: 'VALOR_PAGO_AUSENTE_OU_INVALIDO' },
        { nome: 'moeda USD', valorPago: 450, moeda: 'USD', motivo: 'MOEDA_INVALIDA_OU_AUSENTE' },
        { nome: 'moeda ausente', valorPago: 450, moeda: null, motivo: 'MOEDA_INVALIDA_OU_AUSENTE' }
    ];

    for (const caso of casos) {
        await t.test(caso.nome, async () => {
            reiniciarFixture();
            const resultado = await pagamentoController.efetivarAprovacaoPagamento(
                1, 'tx-invalida-local', 'PIX', null, caso.valorPago, caso.moeda
            );
            assert.equal(resultado.confirmada, false);
            assert.equal(resultado.motivo, caso.motivo);
            assertRollbackSemEscritasDeAprovacao();
        });
    }
});

test('efetivarAprovacaoPagamento: 450.00 BRL confirma com exatamente uma transição e um commit', async () => {
    const resultado = await pagamentoController.efetivarAprovacaoPagamento(
        1, 'tx-exata-local', 'PIX', null, '450.00', 'BRL'
    );

    assert.deepEqual(resultado, { confirmada: true, motivo: 'PAGAMENTO_CONFIRMADO' });
    assert.deepEqual(estado.transacoes, { begin: 1, commit: 1, rollback: 0, release: 1 });
    assert.equal(transicoesDeConfirmacao().length, 1);
    assert.equal(historicoDeConfirmacao().length, 1);
    const insercoesPagamento = consultasPorPadrao(/^INSERT INTO pag_pagamento/);
    assert.equal(insercoesPagamento.length, 1);
    assert.deepEqual(insercoesPagamento[0].parametros, [1, 'PIX', 450, 'tx-exata-local']);
    assert.equal(notificacoesCriadas.length, 0);
    assert.equal(emailEnvios.length, 0);
});

test('efetivarAprovacaoPagamento: affectedRows diferente de 1 faz rollback e não confirma', async () => {
    estado.resultadoAtualizacaoReserva = { affectedRows: 0 };
    const resultado = await pagamentoController.efetivarAprovacaoPagamento(
        1, 'tx-sem-afetados-local', 'PIX', null, 450, 'BRL'
    );

    assert.deepEqual(resultado, { confirmada: false, motivo: 'ATUALIZACAO_RESERVA_NAO_APLICADA' });
    assert.deepEqual(estado.transacoes, { begin: 1, commit: 0, rollback: 1, release: 1 });
    assert.equal(transicoesDeConfirmacao().length, 1, 'A atualização foi tentada, mas não afetou uma linha');
    assert.equal(historicoDeConfirmacao().length, 0, 'Não pode registrar transição histórica após affectedRows != 1');
    assert.equal(notificacoesCriadas.length, 0);
    assert.equal(emailEnvios.length, 0);
});

test('Pagamento: preferência local usa success /#/ReservaConcluida/<id>', async () => {
    estado.reservaPreferencia.Res_Status = 'PAGAMENTO_PENDENTE';
    const res = await fetch(`${base}/api/pagamentos/criar-preferencia/1`, {
        method: 'POST',
        headers: { Cookie: cookie(41) }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.preferenceId, 'pref-local-1');
    assert.equal(gatewayMock.preferencias.length, 1);
    assert.equal(
        gatewayMock.preferencias[0].back_urls.success,
        'http://frontend.test/#/ReservaConcluida/1'
    );
    assert.match(gatewayMock.preferencias[0].back_urls.success, /\/#\/ReservaConcluida\/1$/);
});

test('Webhook aprovado: propaga 450.00 BRL e efetiva somente o pagamento exato', async () => {
    await acionarWebhookAprovado({ transaction_amount: 450.00, currency_id: 'BRL' });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(estado.transacoes, { begin: 1, commit: 1, rollback: 0, release: 1 });
    assert.equal(transicoesDeConfirmacao().length, 1);
    assert.equal(historicoDeConfirmacao().length, 1);
    const insercoesPagamento = consultasPorPadrao(/^INSERT INTO pag_pagamento/);
    assert.equal(insercoesPagamento.length, 1);
    assert.deepEqual(insercoesPagamento[0].parametros, ['1', 'PIX', 450, 'mp-webhook-local']);
});

test('Webhook aprovado: não aprova valor ou moeda inválidos', async t => {
    const casos = [
        { nome: 'valor divergente', transaction_amount: 449.99, currency_id: 'BRL' },
        { nome: 'moeda USD', transaction_amount: 450, currency_id: 'USD' },
        { nome: 'valor ausente', transaction_amount: null, currency_id: 'BRL' }
    ];

    for (const caso of casos) {
        await t.test(caso.nome, async () => {
            reiniciarFixture();
            await acionarWebhookAprovado(caso);
            assertRollbackSemEscritasDeAprovacao();
            assert.equal(notificacoesCriadas.length, 0);
            assert.equal(emailEnvios.length, 0);
        });
    }
});

test('Reconciliação ativa: propaga 450.00 BRL e confirma pagamento exato', async () => {
    estado.pagamentosStatus = [{ Pag_Id: 10, Res_Id: 1, Pag_Status: 'APROVADO', Pag_Valor: 450 }];
    const resposta = await acionarReconciliacaoAtiva({ transaction_amount: 450.00, currency_id: 'BRL' });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.corpo.reservaStatus, 'CONFIRMADA');
    assert.equal(resposta.corpo.temPagamento, true);
    assert.equal(resposta.corpo.pagamento.Pag_Status, 'APROVADO');
    assert.deepEqual(estado.transacoes, { begin: 1, commit: 1, rollback: 0, release: 1 });
    assert.equal(transicoesDeConfirmacao().length, 1);
    assert.equal(historicoDeConfirmacao().length, 1);
});

test('Reconciliação ativa: pagamento recusado pelo contrato não é anunciado como CONFIRMADA', async t => {
    const casos = [
        { nome: 'valor divergente', transaction_amount: 449.99, currency_id: 'BRL' },
        { nome: 'moeda USD', transaction_amount: 450, currency_id: 'USD' },
        { nome: 'moeda ausente', transaction_amount: 450, currency_id: null }
    ];

    for (const caso of casos) {
        await t.test(caso.nome, async () => {
            reiniciarFixture();
            const resposta = await acionarReconciliacaoAtiva(caso);
            assert.equal(resposta.statusCode, 200);
            assert.equal(resposta.corpo.reservaStatus, 'PAGAMENTO_PENDENTE');
            assert.notEqual(resposta.corpo.reservaStatus, 'CONFIRMADA');
            assertRollbackSemEscritasDeAprovacao();
            assert.equal(notificacoesCriadas.length, 0);
            assert.equal(emailEnvios.length, 0);
        });
    }
});
