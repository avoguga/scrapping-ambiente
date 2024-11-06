const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    console.log("Iniciando o navegador...");
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    
    console.log("Acessando a URL alvo...");
    await page.goto('https://lupa.uol.com.br/busca/MEIO%20AMBIENTE', { waitUntil: 'networkidle2' });
    
    console.log("Capturando o HTML completo da página...");
    const pageContent = await page.content();

    console.log("Salvando o HTML no arquivo 'pagina_completa.html'...");
    fs.writeFileSync('pagina_completa.html', pageContent, 'utf-8');

    console.log("Fechando o navegador...");
    await browser.close();

    console.log("Processo concluído. Verifique o arquivo 'pagina_completa.html' para ver o conteúdo da página.");
})();
