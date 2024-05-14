import { config } from "dotenv";
import { Bot } from "./bot";
import { createWebServer } from "./http";

function main() {
  createWebServer();
  config();
  if (
    process.env.TELEGRAM_TOKEN === undefined ||
    process.env.OPEN_AI_TOKEN === undefined ||
    process.env.ASSISTANT_ID === undefined
  ) {
    console.error("Please provide the required environment variables");
    process.exit(1);
  }
  const bot = new Bot(
    process.env.TELEGRAM_TOKEN,
    process.env.OPEN_AI_TOKEN,
    process.env.ASSISTANT_ID
  );

  bot.initialize();
}

main();
