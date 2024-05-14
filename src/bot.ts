import { type Context, type NarrowedContext, Telegraf } from "telegraf";
import {
  emmaJoinServer1,
  emmaJoinServer2,
  emmaJoinServer3,
} from "./strings.json";
import { randomPick } from "./utils";
import type { Message, Update } from "telegraf/typings/core/types/typegram";
import { OpenAI } from "openai";

const hellos = [emmaJoinServer1, emmaJoinServer2, emmaJoinServer3];

export class Bot {
  private tgBot = new Telegraf(this.botToken);
  private openAi = new OpenAI({
    apiKey: this.openAiKey,
  });
  private userThreadMap = new Map<number, string>();

  constructor(
    private botToken: string,
    private openAiKey: string,
    private assistantId: string
  ) {
    this.tgBot.start(this.start);
    this.tgBot.help(this.help);
    this.tgBot.on("message", this.handleMessage);

    process.once("SIGINT", () => this.tgBot.stop("SIGINT"));
    process.once("SIGTERM", () => this.tgBot.stop("SIGTERM"));
  }

  initialize() {
    this.tgBot.launch();
  }

  //for /start
  start: Parameters<Telegraf["start"]>[0] = async (ctx) => {
    console.log("Received /start command");
    const randomHello = randomPick(hellos);
    try {
      await ctx.reply(randomHello);
    } catch (e) {
      console.trace(`An error ocurred handling /start command: ${e}`);
    }
    await this.createThread(
      ctx.message.chat.id,
      ctx.message.from.first_name,
      randomHello
    );
  };

  help: Parameters<Telegraf["help"]>[0] = (ctx) => {
    console.log("Received /help command");
    try {
      ctx.reply("I am a bot that can chat with you!");
    } catch (e) {
      console.trace(`An error ocurred handling /help command: ${e}`);
    }
  };

  createThread = async (
    chatId: number,
    userName: string,
    hello: string = randomPick(hellos)
  ) => {
    const newThread = await this.openAi.beta.threads.create({
      messages: [
        {
          role: "user",
          content: `Hi, my name is ${userName}`,
        },
        {
          content: hello,
          role: "assistant",
        },
      ],
    });
    this.userThreadMap.set(chatId, newThread.id);
    return newThread;
  };

  handleMessage = async (
    ctx: NarrowedContext<Context<Update>, Update.MessageUpdate<Message>>
  ) => {
    const { message, text } = ctx;
    if (message.chat.type !== "private" || !text) {
      //dont reply to groups
      return;
    }

    ctx.sendChatAction("typing");
    const chatId = message.chat.id;
    let threadId = this.userThreadMap.get(chatId);
    if (!threadId) {
      threadId = (await this.createThread(chatId, message.from.first_name)).id;
    }
    await this.openAi.beta.threads.messages.create(threadId, {
      role: "user",
      content: text,
    });
    try {
      const newMessage = await this.runAI(threadId);
      const newContent = newMessage.content.reduce((acc, curr) => {
        if (curr.type == "text") {
          return acc.length ? `${acc}\n${curr.text.value}` : curr.text.value;
        } else {
          return acc;
        }
      }, "");
      await ctx.reply(newContent);
    } catch (e) {
      console.log(`An error ocurred handling AI response: ${e}`);
    }
  };

  runAI = async (threadId: string) => {
    const run = await this.openAi.beta.threads.runs.create(threadId, {
      assistant_id: this.assistantId,
    });
    if (run.status === "completed") {
      return await this.getLatestMessage(threadId, run.id);
    } else {
      return await this.createTask(
        async () => {
          const status = await this.isRunReady(threadId, run.id);
          return status.error ? null : status.done;
        },
        () => this.getLatestMessage(threadId, run.id),
        10000
      );
    }
  };

  isRunReady = async (threadId: string, runId: string) => {
    const run = await this.openAi.beta.threads.runs.retrieve(threadId, runId);
    return {
      done: run.status === "completed",
      error: run.status === "expired" || run.status === "failed",
    };
  };

  createTask = async <T>(
    checkIfReady: () => Promise<boolean | null>,
    action: () => Promise<T>,
    timeout: number
  ) => {
    return new Promise<T>(async (res, rej) => {
      let init = 0;
      setTimeout(rej, timeout);
      while (init++ < 100) {
        const status = await checkIfReady();
        if (status) {
          return res(await action());
        }
        if (status === null) {
          rej();
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      rej();
    });
  };

  getLatestMessage = async (threadId: string, runId?: string) => {
    const messages = await this.openAi.beta.threads.messages.list(threadId, {
      order: "desc",
      limit: 1,
      run_id: runId,
    });
    return messages.data[0];
  };
}
