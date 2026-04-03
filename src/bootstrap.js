// @ts-check

const express = require('express');
const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
const { OpenAI } = require('openai');

const APP_TIME_ZONE = 'Asia/Shanghai';

function validateEnv() {
    if (!process.env.BOT_TOKEN) {
        throw new Error('Missing required env: BOT_TOKEN');
    }

    if (!process.env.MONGODB_URI) {
        console.warn('MONGODB_URI is not set. Database-dependent features may hang or fail.');
    }

    if (!(process.env.AI_API_KEY || process.env.OPENAI_API_KEY)) {
        console.warn('No AI key detected. The bot will still work, but AI replies and diary generation will fall back.');
    }

    if (!process.env.TELEGRAM_WEBAPP_URL) {
        console.warn('TELEGRAM_WEBAPP_URL is not set. The /record command will reply with a configuration hint.');
    }
}

function createHttpApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (!req.url.includes('/webhook/')) {
            console.log(`[HTTP] ${req.method} ${req.url}`);
        }
        next();
    });

    return app;
}

function createBot() {
    const botOptions = {};
    if (process.env.TELEGRAM_API_ROOT) {
        botOptions.telegram = { apiRoot: process.env.TELEGRAM_API_ROOT };
        console.log(`Using custom Telegram API root: ${process.env.TELEGRAM_API_ROOT}`);
    }

    return new Telegraf(process.env.BOT_TOKEN, botOptions);
}

function createOpenAIClient() {
    return new OpenAI({
        apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
        baseURL: process.env.AI_BASE_URL,
    });
}

async function connectDatabase() {
    mongoose.set('strictQuery', true);
    if (!process.env.MONGODB_URI) {
        return false;
    }

    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected.');
    return true;
}

function registerRuntimeRoutes(app, bot, timeZone = APP_TIME_ZONE) {
    const webhookPath = `/webhook/${process.env.BOT_TOKEN}`;
    app.use(bot.webhookCallback(webhookPath));
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', time: new Date().toISOString(), timeZone });
    });

    return webhookPath;
}

/**
 * @param {{ app: import('express').Express, bot: any, port: number, webhookPath: string }} params
 */
function startRuntimeServer(params) {
    const { app, bot, port, webhookPath } = params;

    app.listen(port, '0.0.0.0', () => {
        void (async () => {
            console.log(`Server listening on ${port}`);

            if (process.env.WEBHOOK_URL) {
                const webhookUrl = `${process.env.WEBHOOK_URL}${webhookPath}`;
                await bot.telegram.setWebhook(webhookUrl);
                console.log(`Webhook registered: ${webhookUrl}`);
                return;
            }

            await bot.launch();
            console.log('Bot launched in polling mode.');
        })().catch((error) => {
            console.error('runtime bootstrap failed:', error);
            process.exitCode = 1;
        });
    });
}

module.exports = {
    APP_TIME_ZONE,
    validateEnv,
    createHttpApp,
    createBot,
    createOpenAIClient,
    connectDatabase,
    registerRuntimeRoutes,
    startRuntimeServer,
};
