require('dotenv').config();

const { OpenAI } = require('openai');
const { syncKnowledgeCorpus } = require('../src/rag');

async function main() {
    const openai = new OpenAI({
        apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
        baseURL: process.env.AI_BASE_URL,
    });

    const result = await syncKnowledgeCorpus(openai);
    console.log(`Knowledge sync complete. Upserted ${result.synced} chunks.`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
