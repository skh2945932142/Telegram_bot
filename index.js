require('dotenv').config();

const {
    APP_TIME_ZONE,
    connectDatabase,
    createBot,
    createHttpApp,
    createOpenAIClient,
    registerRuntimeRoutes,
    startRuntimeServer,
    validateEnv,
} = require('./src/bootstrap');
const { createDiaryService } = require('./src/diary-service');
const setupCommands = require('./src/commands');
const setupHandlers = require('./src/handlers');
const { registerScheduledJobs } = require('./src/scheduler');
const { scheduledJobs } = require('./src/scheduled-content');

async function main() {
    validateEnv();

    const app = createHttpApp();
    const bot = createBot();
    const openai = createOpenAIClient();
    const diaryService = createDiaryService();

    await connectDatabase().catch((error) => {
        console.error('MongoDB connection failed:', error);
        throw error;
    });

    setupCommands(bot, openai, diaryService);
    setupHandlers(bot, openai, diaryService);

    registerScheduledJobs({
        bot,
        diaryService,
        timeZone: APP_TIME_ZONE,
        jobs: scheduledJobs,
    });

    const webhookPath = registerRuntimeRoutes(app, bot, APP_TIME_ZONE);
    startRuntimeServer({
        app,
        bot,
        port: Number(process.env.PORT || 8080),
        webhookPath,
    });

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((error) => {
    console.error('Boot failed:', error);
    process.exitCode = 1;
});
