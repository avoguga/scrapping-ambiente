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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint para iniciar o scraping
app.post('/start-scraping', async (req, res) => {
    const { numResults } = req.body;
    res.sendStatus(200);
    startScraping(numResults);
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

// Função principal de scraping
async function startScraping(numResults) {
    try {
        sendEventToAllClients({ message: "Iniciando o navegador..." });
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();

        sendEventToAllClients({ message: "Acessando a URL alvo..." });
        await page.goto('https://lupa.uol.com.br/busca/MEIO%20AMBIENTE', { waitUntil: 'networkidle2' });

        sendEventToAllClients({ message: "Iniciando extração de dados..." });

        let noticias = [];

        // Função para extrair dados da página atual
        async function extractData() {
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

        // Função para clicar no botão "Carregar mais"
        async function clickLoadMore() {
            try {
                const [loadMoreButton] = await page.$x("//button[contains(text(), 'Carregar mais') and not(@disabled)]");
                if (loadMoreButton) {
                    await loadMoreButton.click();
                    sendEventToAllClients({ message: "Carregando mais resultados..." });

                    // Espera 5 segundos após clicar no botão
                    await delay(5000);

                    return true;
                } else {
                    sendEventToAllClients({ message: "Botão 'Carregar mais' não encontrado ou está desabilitado." });
                    return false;
                }
            } catch (error) {
                // Botão não encontrado ou não está visível
                sendEventToAllClients({ message: "Não há mais resultados para carregar." });
                return false;
            }
        }

        let hasMore = true;
        while (noticias.length < numResults && hasMore) {
            const newNoticias = await extractData();

            // Filtra para evitar duplicatas
            const noticiasSet = new Set(noticias.map(n => n.link));
            const uniqueNewNoticias = newNoticias.filter(n => !noticiasSet.has(n.link));

            noticias = noticias.concat(uniqueNewNoticias).slice(0, numResults);

            sendEventToAllClients({ message: `Total de notícias coletadas: ${noticias.length}` });

            if (noticias.length >= numResults) {
                break;
            }

            hasMore = await clickLoadMore();
        }

        sendEventToAllClients({ message: `Extração concluída. Total de notícias extraídas: ${noticias.length}`, data: noticias });

        sendEventToAllClients({ message: "Fechando o navegador..." });
        await browser.close();

        sendEventToAllClients({ message: "Scraping concluído." });
    } catch (error) {
        sendEventToAllClients({ message: `Erro durante o scraping: ${error.message}` });
    }
}

// Endpoint para baixar o arquivo Excel
app.get('/download-excel', async (req, res) => {
    try {
        const noticias = req.query.data ? JSON.parse(req.query.data) : [];

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
