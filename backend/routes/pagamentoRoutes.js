const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pagamentoController = require('../controllers/pagamentoController');
const { verificarToken } = require('../middlewares/authMiddleware');

const emTeste = () => process.env.NODE_ENV === 'test';
const limitadorPagamentos = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    skip: emTeste,
    message: { error: 'Muitas requisições de pagamento. Aguarde alguns minutos.' }
});
const limitadorWebhook = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    skip: emTeste
});

// Cria ou obtém preferência de pagamento no Mercado Pago para a reserva
router.post('/criar-preferencia/:reservaId', verificarToken, limitadorPagamentos, pagamentoController.criarPreferencia);

// Consulta o status do pagamento no banco para a reserva
router.get('/status/:reservaId', verificarToken, limitadorPagamentos, pagamentoController.consultarStatus);

// Simula aprovação de pagamento (bloqueado em produção)
if (process.env.NODE_ENV !== 'production') {
    router.post('/simular-aprovacao/:reservaId', verificarToken, limitadorPagamentos, pagamentoController.simularAprovacao);
}

// Webhook para retorno assíncrono do Mercado Pago
router.post('/webhook', limitadorWebhook, pagamentoController.receberWebhook);

module.exports = router;
