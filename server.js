// server.js
const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');
const ExcelJS = require('exceljs');
const bodyParser = require('body-parser');

const app = express();
const port = 3000;

let clients = [];

app.use(express.static('public'));
app.use(bodyParser.json());

let browser; // Navegador Puppeteer
let page;    // Página Puppeteer
let noticias = []; // Notícias extraídas
let isScraping = false; // Flag para evitar múltiplos scrapings simultâneos
let hasClickedLoadMore = false; // Flag para indicar se o botão "Carregar mais" já foi clicado

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint para iniciar o scraping inicial de 10 itens
app.post('/start-scraping', async (req, res) => {
    res.sendStatus(200);
    if (!isScraping) {
        isScraping = true;
        await startScraping(10); // Iniciar com 10 itens
        isScraping = false;
    }
});

// Endpoint para extrair mais itens
app.post('/extract-more', async (req, res) => {
    const { numMoreResults } = req.body;
    res.sendStatus(200);
    if (!isScraping) {
        isScraping = true;
        await extractMoreItems(numMoreResults || 5); // Extrair 5 itens por padrão
        isScraping = false;
    }
});

// SSE endpoint para enviar mensagens de progresso
app.get('/events', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    res.flushHeaders();

    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };

    clients.push(newClient);

    req.on('close', () => {
        clients = clients.filter(client => client.id !== clientId);
    });
});

// Função para enviar mensagens a todos os clientes conectados
function sendEventToAllClients(data) {
    clients.forEach(client => {
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    });
}

// Função de atraso personalizada
function delay(time) {
    return new Promise(function(resolve) { 
        setTimeout(resolve, time);
    });
}

// Função principal de scraping inicial
async function startScraping(initialResults) {
    try {
        sendEventToAllClients({ message: "Iniciando o navegador..." });
        browser = await puppeteer.launch({ headless: true });
        page = await browser.newPage();

        sendEventToAllClients({ message: "Acessando a URL alvo..." });
        await page.goto('https://lupa.uol.com.br/busca/MEIO%20AMBIENTE', { waitUntil: 'networkidle2' });

        sendEventToAllClients({ message: "Extraindo os primeiros 10 itens..." });

        // Extrair os primeiros 10 itens
        noticias = await extractData(page);
        noticias = noticias.slice(0, initialResults);
        sendEventToAllClients({ message: `Total de notícias coletadas: ${noticias.length}`, data: noticias });
    } catch (error) {
        sendEventToAllClients({ message: `Erro durante o scraping inicial: ${error.message}` });
    }
}

// Função para extrair mais itens
async function extractMoreItems(numMoreResults) {
    try {
        if (!browser || !page) {
            sendEventToAllClients({ message: "Navegador não iniciado. Iniciando o navegador..." });
            browser = await puppeteer.launch({ headless: true });
            page = await browser.newPage();
            await page.goto('https://lupa.uol.com.br/busca/MEIO%20AMBIENTE', { waitUntil: 'networkidle2' });
            // Extrair os primeiros 10 itens se ainda não foram extraídos
            if (noticias.length === 0) {
                noticias = await extractData(page);
                noticias = noticias.slice(0, 10);
            }
        }

        sendEventToAllClients({ message: `Extraindo mais ${numMoreResults} itens...` });

        if (!hasClickedLoadMore) {
            // Clicar no botão "Carregar mais" apenas uma vez
            const loadMoreButtons = await page.$$('xpath/.//button[contains(text(), "Carregar mais") and not(@disabled)]');
            if (loadMoreButtons.length > 0) {
                await loadMoreButtons[0].click();
                sendEventToAllClients({ message: "Botão 'Carregar mais' clicado." });
                hasClickedLoadMore = true;
                await delay(5000); // Esperar o carregamento
            } else {
                sendEventToAllClients({ message: "Botão 'Carregar mais' não encontrado ou já foi clicado." });
                hasClickedLoadMore = true; // Mesmo se não encontrado, assumimos que já foi clicado
            }
        }

        let itemsToExtract = numMoreResults;
        let itemsExtracted = 0;
        let maxScrollAttempts = 20;
        let scrollAttempts = 0;

        while (itemsExtracted < itemsToExtract && scrollAttempts < maxScrollAttempts) {
            // Rola a página para baixo
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await delay(3000); // Aguarda o carregamento

            // Extrai novos dados
            const newNoticias = await extractData(page);

            // Filtra para evitar duplicatas
            const noticiasSet = new Set(noticias.map(n => n.link));
            const uniqueNewNoticias = newNoticias.filter(n => !noticiasSet.has(n.link));

            if (uniqueNewNoticias.length === 0) {
                scrollAttempts++;
                continue; // Tenta rolar novamente
            }

            noticias = noticias.concat(uniqueNewNoticias);
            itemsExtracted += uniqueNewNoticias.length;

            sendEventToAllClients({ message: `Total de notícias coletadas: ${noticias.length}`, data: noticias });

            if (itemsExtracted >= itemsToExtract) {
                break;
            }

            scrollAttempts++;
        }

        if (scrollAttempts >= maxScrollAttempts) {
            sendEventToAllClients({ message: "Não há mais itens para extrair ou atingido o limite de tentativas." });
        }

    } catch (error) {
        sendEventToAllClients({ message: `Erro ao extrair mais itens: ${error.message}` });
    }
}

// Função para extrair dados da página atual
async function extractData(page) {
    const newNoticias = await page.evaluate(() => {
        const dados = [];
        const elementosNoticia = document.querySelectorAll('.sc-dkrFOg.cbDCWR');
        elementosNoticia.forEach((noticia) => {
            // Extrai a data da notícia
            const dataElemento = noticia.querySelector('.sc-eDvSVe.dVERlv');
            const data = dataElemento ? dataElemento.innerText.trim() : 'Data não encontrada';

            // Extrai a categoria
            const categoriaElemento = noticia.querySelector('.sc-eDvSVe.cLlWvC');
            const categoria = categoriaElemento ? categoriaElemento.innerText.trim() : 'Categoria não encontrada';

            // Extrai o título da notícia
            const tituloElemento = noticia.querySelector('.sc-eDvSVe.hAIjQn');
            const titulo = tituloElemento ? tituloElemento.innerText.trim() : 'Título não encontrado';

            // Extrai a descrição da notícia
            const descricaoElemento = noticia.querySelector('.sc-eDvSVe.jyCpkG.sc-hTBuwn.iKznYo p');
            const descricao = descricaoElemento ? descricaoElemento.innerText.trim() : 'Descrição não encontrada';

            // Extrai o autor da notícia
            const autorElemento = noticia.querySelector('.sc-eDvSVe.hQCdpY');
            const autor = autorElemento ? autorElemento.innerText.trim() : 'Autor não encontrado';

            // Extrai o link da notícia
            const linkElemento = noticia.querySelector('a.sc-eDWCr.hNENvd');
            const linkRelativo = linkElemento ? linkElemento.getAttribute('href') : null;
            const linkCompleto = linkRelativo ? `https://lupa.uol.com.br${linkRelativo}` : 'Link não encontrado';

            dados.push({ data, categoria, titulo, descricao, autor, link: linkCompleto });
        });
        return dados;
    });
    return newNoticias;
}

// Endpoint para baixar o arquivo Excel
app.get('/download-excel', async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Notícias');

        worksheet.columns = [
            { header: 'Data', key: 'data', width: 20 },
            { header: 'Categoria', key: 'categoria', width: 20 },
            { header: 'Título', key: 'titulo', width: 50 },
            { header: 'Descrição', key: 'descricao', width: 50 },
            { header: 'Autor', key: 'autor', width: 25 },
            { header: 'Link', key: 'link', width: 50 }
        ];

        noticias.forEach(noticia => {
            worksheet.addRow(noticia);
        });

        // Estilizando o cabeçalho
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).alignment = { horizontal: 'center' };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=noticias_meio_ambiente.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        res.status(500).send('Erro ao gerar o arquivo Excel.');
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});
