'use strict';

// Isolamento estrutural da suíte unitária: vale antes de qualquer import de produção.
process.env.NODE_ENV = 'test';
process.env.RC_TEST_ISOLATION = '1';
delete process.env.RC_QA_MYSQL_HARNESS;
