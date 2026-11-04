require('dotenv').config({ path: 'C:/Users/Padar/OneDrive/Desktop/Projeto Recanto/recanto-camargo/backend/.env' });
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const pastaDestinoDesktop = 'C:/Users/Padar/OneDrive/Desktop/Projeto Recanto/recanto-camargo/portfolio_screenshots';
const pastaArtifacts = 'C:/Users/Padar/.gemini/antigravity/brain/e0dbd5d2-d567-45e0-a2f4-dee22fabe8b6';

if (!fs.existsSync(pastaDestinoDesktop)) {
  fs.mkdirSync(pastaDestinoDesktop, { recursive: true });
}

async function capturarTelas() {
  console.log('Iniciando navegador Playwright (Edge/Chromium)...');
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true
  });

  // Resolução Desktop Premium (1440x900 com scale 1.5 para fidelidade e nitidez retina)
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
  });

  const page = await context.newPage();
  const baseUrl = 'http://localhost:5173/recanto-camargo/#';

  // ==========================================
  // 1. HOME PAGE
  // ==========================================
  console.log('1. Capturando Página Inicial (Home)...');
  await page.goto(`${baseUrl}/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  const printHomeDesktop = path.join(pastaDestinoDesktop, '01_Home_Recanto_Camargo.png');
  const printHomeArtifact = path.join(pastaArtifacts, '01_Home_Recanto_Camargo.png');
  await page.screenshot({ path: printHomeDesktop, fullPage: false });
  fs.copyFileSync(printHomeDesktop, printHomeArtifact);
  console.log('✅ Print 1 (Home) salvo em:', printHomeDesktop);

  // ==========================================
  // 2. CRIAÇÃO DE CONTA (CADASTRO)
  // ==========================================
  console.log('2. Capturando Tela de Criação de Conta (Cadastro)...');
  await page.goto(`${baseUrl}/Cadastro`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);

  const printCadastroDesktop = path.join(pastaDestinoDesktop, '02_Criacao_de_Conta.png');
  const printCadastroArtifact = path.join(pastaArtifacts, '02_Criacao_de_Conta.png');
  await page.screenshot({ path: printCadastroDesktop, fullPage: false });
  fs.copyFileSync(printCadastroDesktop, printCadastroArtifact);
  console.log('✅ Print 2 (Cadastro) salvo em:', printCadastroDesktop);

  // ==========================================
  // 3. DASHBOARD DO CLIENTE (HÓSPEDE)
  // ==========================================
  console.log('3. Realizando Login como Hóspede (Felipe Carvalho)...');
  await page.goto(`${baseUrl}/Login`);
  await page.waitForLoadState('networkidle');

  await page.locator('input[type="email"]').fill('felipeteste@email.com');
  await page.locator('input[type="password"]').fill('Felipe123.');

  const loginPromise = page.waitForResponse(
    res => res.url().includes('/api/usuarios/login') && res.status() === 200,
    { timeout: 10000 }
  );

  await page.locator('button[type="submit"]').click();
  const loginRes = await loginPromise;
  console.log(`✓ Login bem-sucedido: status ${loginRes.status()}`);

  await page.waitForTimeout(1500);

  console.log('Acessando Dashboard do Cliente...');
  await page.goto(`${baseUrl}/DashboardCliente`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);

  const printDashboardDesktop = path.join(pastaDestinoDesktop, '03_Dashboard_Cliente.png');
  const printDashboardArtifact = path.join(pastaArtifacts, '03_Dashboard_Cliente.png');
  await page.screenshot({ path: printDashboardDesktop, fullPage: false });
  fs.copyFileSync(printDashboardDesktop, printDashboardArtifact);
  console.log('✅ Print 3 (Dashboard Cliente) salvo em:', printDashboardDesktop);

  await browser.close();
  console.log('\n🎉 Todas as 3 capturas em altíssima qualidade foram concluídas com sucesso!');
}

capturarTelas().catch(err => {
  console.error('❌ Erro na captura de telas:', err);
  process.exit(1);
});
