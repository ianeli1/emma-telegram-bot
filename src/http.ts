import express from "express";

export function createWebServer() {
  const app = express();
  app.get("/", (_, response) => {
    response.send("Hello World");
  });
  app.listen(process.env.PORT);
  return app;
}
