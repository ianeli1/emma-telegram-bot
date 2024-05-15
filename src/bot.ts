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

    if (
      !message ||
      !("photo" in message) ||
      message.chat.type !== "private" ||
      !text
    ) {
      //dont reply to groups
      return;
    }
    if (message.photo && message.photo.length > 0) {
      // If it has a picture hanle it separately
      await this.handleImageMessage(ctx);
      return;
    }

    if (!text) {
      // If the message doesn't have any content return nothing
      return;
    }

    // Regular messages
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
      console.log(`An error occurred handling AI response: ${e}`);
    }
  };

  //Handling messages with images
  handleImageMessage = async (
    ctx: NarrowedContext<Context<Update>, Update.MessageUpdate<Message>>
  ) => {
    const imageUrl = await this.getImageFromChat(ctx);
    if (!imageUrl) {
      console.log("There's no image url to be found");
      return;
    }

    console.log("Image url: ", imageUrl);

    try {
      const description = await this.describeImage(imageUrl);
      console.log("Description: ", description);
      if (!description || !description.choices) {
        console.log("Invalid response from OpenAI");
        return;
      }

      const newContent = this.extractTextFromDescription(description);
      console.log("New Content: ", newContent);
      await ctx.reply(newContent);
    } catch (e) {
      console.log(`An error ocurred handling AI response: ${e}`);
    }
  };

  extractTextFromDescription = (description: any) => {
    return description.choices[0].message.content.reduce(
      (acc: string, curr: any) => {
        if (curr.type == "text") {
          return acc.length ? `${acc}\n${curr.text.value}` : curr.text.value;
        } else {
          return acc;
        }
      },
      ""
    );
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

  getImageFromChat = async (ctx: Context) => {
    if (!ctx.message || !("photo" in ctx.message)) return null;

    const messageId = ctx.message.photo ? ctx.message.photo[0].file_id : null;

    if (!messageId) return null;

    const fileInfo = await ctx.telegram.getFile(messageId);
    if (!fileInfo) return null;

    const imageUrl = `https://api.telegram.org/file/bot${this.botToken}/${fileInfo.file_path}`;

    return imageUrl;
  };

  describeImage = async (image: string) => {
    const description = await this.openAi.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hi there Emma, could you please describe this image?",
            },
            {
              type: "image_url",
              image_url: { url: image },
            },
          ],
        },
      ],
    });
    return description;
  };
}
