const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./config/db');

async function verificar() {
    console.log('=== VERIFICAÇÃO GERAL DO BANCO DE DADOS ===\n');

    // 1. Imóveis
    const [imoveis] = await db.query(
        'SELECT Imo_Id, Imo_Nome, Imo_ValorFixo, Imo_ValorFimSemana, Imo_Status FROM imo_imovel'
    );
    console.log('1. IMÓVEIS CADASTRADOS:');
    console.table(imoveis);

    // 2. Últimas Reservas
    const [reservas] = await db.query(
        `SELECT Res_Id, Imo_Id, Hos_Hospede_Usu_Id,
                DATE_FORMAT(Res_DataCheckIn, '%Y-%m-%d') as checkin,
                DATE_FORMAT(Res_DataCheckOut, '%Y-%m-%d') as checkout,
                Res_QuantidadeDeHospedes as hospedes,
                Res_ValorTotal as total,
                Res_Status as status,
                DATE_FORMAT(Res_DataReserva, '%Y-%m-%d %H:%i') as criadaEm
         FROM res_reserva ORDER BY Res_Id DESC LIMIT 6`
    );
    console.log('\n2. ÚLTIMAS RESERVAS:');
    console.table(reservas);

    // 3. Pagamentos
    const [pagamentos] = await db.query(
        `SELECT Pag_Id, Res_Id, Pag_Status, Pag_Metodo, Pag_Valor,
                DATE_FORMAT(Pag_DataHora, '%Y-%m-%d %H:%i') as dataHora,
                Pag_TransacaoId
         FROM pag_pagamento ORDER BY Pag_Id DESC LIMIT 6`
    );
    console.log('\n3. ÚLTIMOS PAGAMENTOS:');
    console.table(pagamentos);

    // 4. Notificações
    const [notifs] = await db.query(
        `SELECT Not_Id, Usu_Id, Not_Titulo, Not_Tipo, Not_Lida,
                DATE_FORMAT(Not_CriadaEm, '%Y-%m-%d %H:%i') as criadaEm
         FROM not_notificacao ORDER BY Not_Id DESC LIMIT 6`
    );
    console.log('\n4. ÚLTIMAS NOTIFICAÇÕES:');
    console.table(notifs);

    // 5. Bloqueios de data
    const [bloqueios] = await db.query(
        `SELECT Bld_Id, Imo_Id, DATE_FORMAT(Bld_Data, '%Y-%m-%d') as data,
                Bld_Motivo, Bld_Status
         FROM bld_bloqueiodata ORDER BY Bld_Id DESC LIMIT 6`
    );
    console.log('\n5. ÚLTIMOS BLOQUEIOS DE CALENDÁRIO:');
    console.table(bloqueios);

    // 6. Integridade Referencial (Órfãos)
    const [orfaosReservas] = await db.query(
        `SELECT COUNT(*) as qtd FROM res_reserva r
         LEFT JOIN imo_imovel i ON i.Imo_Id = r.Imo_Id
         WHERE i.Imo_Id IS NULL`
    );
    const [orfaosPagamentos] = await db.query(
        `SELECT COUNT(*) as qtd FROM pag_pagamento p
         LEFT JOIN res_reserva r ON r.Res_Id = p.Res_Id
         WHERE r.Res_Id IS NULL`
    );
    const [orfaosNotifs] = await db.query(
        `SELECT COUNT(*) as qtd FROM not_notificacao n
         LEFT JOIN usu_usuario u ON u.Usu_Id = n.Usu_Id
         WHERE u.Usu_Id IS NULL`
    );
    console.log('\n6. INTEGRIDADE REFERENCIAL:');
    console.log(`- Reservas sem imóvel existente: ${orfaosReservas[0].qtd}`);
    console.log(`- Pagamentos sem reserva existente: ${orfaosPagamentos[0].qtd}`);
    console.log(`- Notificações sem usuário existente: ${orfaosNotifs[0].qtd}`);

    process.exit(0);
}

verificar().catch(err => {
    console.error('Erro na verificação:', err);
    process.exit(1);
});
