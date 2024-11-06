// server.js
const express = require('express');
const axios = require('axios');
const ExcelJS = require('exceljs');
const path = require('path');

const app = express();
const port = 3000;

app.use(express.static('public'));
app.use(express.json());

let searches = {}; // Armazena os dados de cada pesquisa por sessão

// Endpoint para buscar dados (UUIDs e dados correspondentes)
app.post('/fetch-data', async (req, res) => {
    try {
        const token = '5Xg7IkxHuOMeDBxZ1CaWBQtt'; // Substitua pelo seu token real
        const size = 30; // Número de resultados por página (limite da API)
        const perPage = 100;
        const batchSize = 50; // Número de UUIDs por requisição

        const searchTerm = req.body.searchTerm;
        const sessionId = req.body.sessionId;

        if (!searchTerm) {
            return res.status(400).send({ success: false, error: 'Termo de pesquisa não fornecido.' });
        }

        if (!sessionId) {
            return res.status(400).send({ success: false, error: 'ID de sessão não fornecido.' });
        }

        // Inicializar os dados para esta sessão
        searches[sessionId] = {
            fetchedUUIDs: [],
            fetchedData: [],
            progress: { status: '', percentage: 0 }
        };

        const searchData = searches[sessionId];

        searchData.progress.status = 'Buscando UUIDs';
        searchData.progress.percentage = 0;

        // Etapa 1: Buscar UUIDs relacionados ao termo de pesquisa
        let endDate = new Date().toISOString();
        let hasMoreResults = true;
        let iteration = 0;
        let totalResults = 0;

        console.log(`Iniciando a busca de UUIDs para a sessão ${sessionId}...`);

        while (hasMoreResults) {
            iteration += 1;

            const response = await axios.post('https://api.lupa.news/v1/search', {
                query: searchTerm,
                from: 0,
                size: size,
                sort: ["published_at", "desc"],
                startDate: "2015-11-01T00:00:01.000Z",
                endDate: endDate,
                tags: [],
                types: [],
                categories: []
            });

            const data = response.data;

            if (iteration === 1) {
                totalResults = data.total;
                console.log(`Total de resultados: ${totalResults}`);
            }

            if (data.uuids && data.uuids.length > 0) {
                searchData.fetchedUUIDs = searchData.fetchedUUIDs.concat(data.uuids);
                console.log(`Sessão ${sessionId}: Buscando UUIDs... (${searchData.fetchedUUIDs.length}/${totalResults})`);

                // Atualizar o 'endDate' para ser a data do último item menos 1 milissegundo
                const lastItemDate = data.hits[data.hits.length - 1].published_at;
                endDate = new Date(new Date(lastItemDate).getTime() - 1).toISOString();

                // Atualizar o progresso
                searchData.progress.percentage = Math.min(Math.floor((searchData.fetchedUUIDs.length / totalResults) * 50), 50);
            } else {
                console.log('Nenhum UUID retornado, parando a busca.');
                hasMoreResults = false;
            }

            // Aguarda 500ms entre as requisições para evitar sobrecarregar o servidor
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`Todos os ${searchData.fetchedUUIDs.length} UUIDs foram buscados com sucesso para a sessão ${sessionId}.`);

        // Etapa 2: Buscar os dados correspondentes aos UUIDs
        let totalItems = [];
        let batchCount = 0;

        searchData.progress.status = 'Buscando dados';
        searchData.progress.percentage = 50;

        for (let i = 0; i < searchData.fetchedUUIDs.length; i += batchSize) {
            const batchUUIDs = searchData.fetchedUUIDs.slice(i, i + batchSize).join(',');

            const response = await axios.get('https://api.storyblok.com/v1/cdn/stories', {
                params: {
                    token: token,
                    per_page: perPage,
                    by_uuids: batchUUIDs,
                    resolve_relations: 'authors',
                }
            });

            const data = response.data;
            totalItems = totalItems.concat(data.stories);
            batchCount++;

            console.log(`Sessão ${sessionId}: Lote ${batchCount}: Buscando dados... (${totalItems.length}/${searchData.fetchedUUIDs.length})`);

            // Atualizar o progresso
            searchData.progress.percentage = 50 + Math.min(Math.floor((totalItems.length / searchData.fetchedUUIDs.length) * 50), 50);

            // Aguarda 500ms entre as requisições para evitar atingir limites da API
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`Todos os ${totalItems.length} itens foram buscados com sucesso para a sessão ${sessionId}.`);

        // Processar os dados para extrair os campos necessários
        searchData.fetchedData = totalItems.map(item => {
            const content = item.content;

            const publishedDate = item.first_published_at ? new Date(item.first_published_at) : null;
            const dateSegment = publishedDate ? `${publishedDate.getFullYear()}/${String(publishedDate.getMonth() + 1).padStart(2, '0')}/${String(publishedDate.getDate()).padStart(2, '0')}` : '';

            let restOfSlug = '';
            if (item.full_slug) {
                // Remove 'jornalismo/conteudos/' do full_slug
                restOfSlug = item.full_slug.replace('jornalismo/conteudos/', '');
            }

            const dataItem = {
                data: publishedDate,
                categoria: content.hat || 'Categoria não encontrada',
                titulo: item.name || 'Título não encontrado',
                descricao: '', // Tentaremos extrair uma descrição
                autor: '', // Tentaremos extrair o autor
                link: publishedDate ? `https://lupa.uol.com.br/jornalismo/${dateSegment}/${restOfSlug}` : 'Link não encontrado'
            };

            // Tentar extrair 'descricao' do conteúdo
            if (content.body && content.body.content) {
                // Percorrer o conteúdo para encontrar o primeiro parágrafo
                const paragraphs = content.body.content.filter(block => block.type === 'paragraph');
                if (paragraphs.length > 0 && paragraphs[0].content) {
                    const texts = paragraphs[0].content.filter(node => node.type === 'text');
                    if (texts.length > 0) {
                        dataItem.descricao = texts.map(textNode => textNode.text).join(' ');
                    }
                }
            } else {
                dataItem.descricao = 'Descrição não encontrada';
            }

            // Tentar extrair 'autor' do conteúdo
            if (content.authors && content.authors.length > 0) {
                dataItem.autor = content.authors.map(author => author.name).join(', ');
            } else {
                dataItem.autor = 'Autor não encontrado';
            }

            return dataItem;
        });

        searchData.progress.status = 'Concluído';
        searchData.progress.percentage = 100;

        res.send({ success: true });
    } catch (error) {
        console.error('Erro ao buscar os dados:', error.message);
        progress.status = 'Erro';
        progress.percentage = 0;
        res.status(500).send({ success: false, error: error.message });
    }
});

// Endpoint para obter o progresso
app.post('/progress', (req, res) => {
    const sessionId = req.body.sessionId;
    if (sessionId && searches[sessionId]) {
        res.json(searches[sessionId].progress);
    } else {
        res.json({ status: 'Inativo', percentage: 0 });
    }
});

// Endpoint para obter os dados filtrados (para exibição no front-end)
app.post('/get-data', (req, res) => {
    const { startDate, endDate, sessionId } = req.body;

    if (!sessionId || !searches[sessionId]) {
        return res.status(400).send({ success: false, error: 'Sessão inválida.' });
    }

    let filteredData = searches[sessionId].fetchedData;

    if (startDate) {
        const start = new Date(startDate);
        filteredData = filteredData.filter(item => item.data && item.data >= start);
    }

    if (endDate) {
        const end = new Date(endDate);
        filteredData = filteredData.filter(item => item.data && item.data <= end);
    }

    // Formatar a data para exibição
    filteredData = filteredData.map(item => {
        return {
            ...item,
            data: item.data ? item.data.toLocaleDateString() : 'Data não encontrada',
        };
    });

    res.json(filteredData);
});

// Endpoint para baixar os dados como um arquivo Excel
app.post('/download-excel', async (req, res) => {
    try {
        const { startDate, endDate, sessionId } = req.body;

        if (!sessionId || !searches[sessionId]) {
            return res.status(400).send({ success: false, error: 'Sessão inválida.' });
        }

        let filteredData = searches[sessionId].fetchedData;

        if (startDate) {
            const start = new Date(startDate);
            filteredData = filteredData.filter(item => item.data && item.data >= start);
        }

        if (endDate) {
            const end = new Date(endDate);
            filteredData = filteredData.filter(item => item.data && item.data <= end);
        }

        // Preparar os dados para o Excel
        const excelData = filteredData.map(item => {
            return {
                ...item,
                data: item.data ? item.data.toLocaleDateString() : 'Data não encontrada',
            };
        });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Dados');

        worksheet.columns = [
            { header: 'Data', key: 'data', width: 15 },
            { header: 'Categoria', key: 'categoria', width: 20 },
            { header: 'Título', key: 'titulo', width: 50 },
            { header: 'Descrição', key: 'descricao', width: 50 },
            { header: 'Autor', key: 'autor', width: 25 },
            { header: 'Link', key: 'link', width: 50 }
        ];

        // Adicionar linhas à planilha
        excelData.forEach(item => {
            worksheet.addRow(item);
        });

        // Formatar a linha do cabeçalho
        worksheet.getRow(1).font = { bold: true };

        // Escrever em um buffer
        const buffer = await workbook.xlsx.writeBuffer();

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=dados.xlsx');
        res.send(buffer);
    } catch (error) {
        console.error('Erro ao gerar o arquivo Excel:', error.message);
        res.status(500).send('Erro ao gerar o arquivo Excel');
    }
});

// Iniciar o servidor
app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});
