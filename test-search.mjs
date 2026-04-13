import { searchVectors } from './src/services/vector-store.js';
import { DefaultAzureCredential } from '@azure/identity';
import { AzureOpenAI } from 'openai';

const credential = new DefaultAzureCredential();
const embeddingClient = new AzureOpenAI({
    endpoint: 'https://yizha-maz2xf24-swedencentral.openai.azure.com/',
    apiKey: '',
    azureADTokenProvider: () =>
        credential.getToken('https://cognitiveservices.azure.com/.default').then(at => at.token),
    apiVersion: '2023-05-15',
    deployment: 'text-embedding-3-large',
});

async function embed(text) {
    const result = await embeddingClient.embeddings.create({
        input: [text],
        model: 'text-embedding-3-large',
    });
    return result.data[0].embedding;
}

const queries = [
    'grid template no-data view reset filters hide chrome',
    'Merchant Center products grid missing',
    'fluent grid template update no data view',
];

for (const q of queries) {
    const emb = await embed(q);
    const results = await searchVectors(emb, {
        topK: 50,
        minScore: 0.01,
        dateFrom: '2026-03-29',
        dateTo: '2026-04-01',
    });
    const target = results.find(r => (r.id || '').includes('519cdc3f') || (r.commitId || '').includes('519cdc3f'));
    const rank = results.findIndex(r => (r.id || '').includes('519cdc3f') || (r.commitId || '').includes('519cdc3f'));
    console.log('Query:', q);
    console.log('  Total results:', results.length);
    if (target) {
        console.log('  519cdc3f rank:', rank + 1, 'score:', target.score.toFixed(4));
        console.log('  Title:', target.metadata?.title?.slice(0, 80));
    } else {
        console.log('  519cdc3f NOT FOUND in top 50');
        for (let i = 0; i < 3 && i < results.length; i++) {
            console.log('  #' + (i+1), results[i].id?.slice(0, 10), results[i].score.toFixed(4), results[i].metadata?.title?.slice(0, 60));
        }
    }
    console.log();
}
