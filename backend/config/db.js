require('dotenv').config();
const mysql = require('mysql2');

const poolConfig = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

if (process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('aivencloud.com'))) {
    poolConfig.ssl = { rejectUnauthorized: false };
}

// Criando o Pool de Conexões (OWASP: Melhor performance e evita sobrecarga)
const pool = mysql.createPool(poolConfig);

// Convertendo para o formato de Promises, que é muito mais moderno e fácil de ler
const db = pool.promise();

// Testando a conexão inicialmente
db.getConnection()
    .then(connection => {
        console.log('✅ Conexão com o MySQL (Recanto Camargo) estabelecida com sucesso!');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Erro ao conectar com o banco de dados:', err.message);
    });

module.exports = db;
